import { Meteor } from 'meteor/meteor'
import { each, get } from 'lodash'

import { Tones } from '/imports/api/tones'
import { Sounds } from '/imports/api/sounds'

import {
  buildPersistableTone,
  getParamName,
  getParamsFromTone,
  isNumeric,
  setParamValue
} from './params'
import { rewriteParamsInCode } from './rewriteParamsInCode'
import { validateSoundCode } from './validateCode'
import { markAutoWrittenCode } from './codeSafety'
import { clearParamsError, setParamsError } from './paramsFeedback'

if (Meteor.isClient) {
  Meteor.subscribe('tones');
  Meteor.subscribe('sounds');
}

// Consecutive knob moves are coalesced: only the final value of a drag is
// written to the database and to the sound code.
export const PARAMS_DEBOUNCE_MS = 300

const pending = {}

//
// Access to the live (in memory) tone objects played by the audio engine.
//
const getLiveTones = () => {
  if (typeof window === 'undefined') return []
  if (!(window.tones instanceof Array)) window.tones = []
  return window.tones
}

export const getLiveTone = soundId => {
  let found = null

  each(getLiveTones(), tone => {
    if (!found && tone && tone.soundId === soundId) found = tone
  })

  return found
}

export const findVarEntry = (tone, name) => {
  let found = null

  each(get(tone, 'options.vars'), v => {
    if (!found && getParamName(v) === name) found = v
  })

  return found
}

//
// Immediately change the sound that is currently playing.
// Returns false when no live tone / no numeric param matched.
//
export const applyParamValue = (soundId, name, value) => {
  if (!isNumeric(value) || typeof name !== 'string') return false

  const entry = findVarEntry(getLiveTone(soundId), name)
  if (!entry) return false

  return setParamValue(entry, value, name)
}

const getToneDocument = (soundId, toneId) => {
  if (toneId) {
    const byId = Tones.findOne(toneId)
    if (byId && byId.soundId === soundId) return byId
  }

  return Tones.findOne({ soundId })
}

//
// Build the name -> {name, value, kind} map that is going to be written in
// the sound code.
//
//  - `allParams` (the historical "save" entry point) writes every numeric
//    param of the tone;
//  - otherwise only the params of `values` (the knob that just moved) are
//    written, so the rest of the code is left untouched.
//
// In both cases only params that are numeric in the tone document are kept: a
// string / boolean / unknown object parameter is not a knob and must never be
// rewritten.
//
const buildParams = (tone, values, allParams) => {
  const params = {}
  if (!tone) return params

  const stored = getParamsFromTone(tone)

  if (allParams) {
    each(stored, param => {
      params[param.name] = param
    })
  }

  if (!values || typeof values !== 'object') return params

  each(Object.keys(values), name => {
    const value = values[name]
    const known = stored[name]

    if (!known || !isNumeric(known.value) || !isNumeric(value)) return

    params[name] = { name, value, kind: known.kind }
  })

  return params
}

//
// Persist the current knob values in the Tones collection without creating a
// new record: the document keeps its identity.
//
// The document returned by minimongo is never mutated: only a serializable
// copy is sent to the server.
//
const persistToneValues = (tone, params) => {
  if (!tone || !Object.keys(params).length) return false

  const payload = buildPersistableTone(tone, tone.soundId)
  let changed = false

  each(payload.options.vars, entry => {
    const name = getParamName(entry)
    const param = params[name]

    if (!param) return
    if (setParamValue(entry, param.value, name)) changed = true
  })

  if (!changed) return false

  Meteor.call('tones.update', payload)
  return true
}

//
// MAIN ENTRY POINT
//
// Rewrite the sound code so that the params carried by the tone (and by the
// optional `values` map) match the knobs, then persist the values.
//
// The code is never modified when the rewrite fails: the original code is
// left intact, the knob value is still persisted in the Tones collection (so
// the knob keeps a readable value) and an error is published for the UI.
//
export const updateParamsInCode = (soundId, toneId, options) => {
  const opts = options || {}
  const values = opts.values

  const sound = Sounds.findOne(soundId)
  const tone = getToneDocument(soundId, toneId)

  if (!sound) {
    const error = 'CODE UPDATE ERROR => the sound does not exist anymore'
    setParamsError(soundId, error)
    return { status: 'err', body: error }
  }

  if (!tone) {
    const error = 'CODE UPDATE ERROR => no tone is generated for this sound yet'
    setParamsError(soundId, error)
    return { status: 'err', body: error }
  }

  const params = buildParams(tone, values, opts.allParams)

  if (!Object.keys(params).length) {
    // nothing numeric to write back (the sound declares no knob)
    clearParamsError(soundId)
    return { status: 'ok', code: sound.code, changed: false }
  }

  // 1. always keep the persisted knob value first, even when the code cannot
  //    be rewritten.
  persistToneValues(tone, params)

  // 2. rewrite the code.
  const result = rewriteParamsInCode(sound.code, params)

  if (result.status === 'err') {
    setParamsError(soundId, result.body)
    return result
  }

  if (!result.changed) {
    clearParamsError(soundId)
    return result
  }

  // 3. never write a code that would break the sound: the rewritten code is
  //    evaluated (and its audio nodes disposed right away). On failure the
  //    original code stays in place, untouched, and the error is shown.
  const check = validateSoundCode(result.code, params)

  if (check.status === 'err') {
    const message = `CODE UPDATE ERROR => ${check.body}`
    setParamsError(soundId, message)
    return { status: 'err', body: message }
  }

  // 4. write it back. The sounds watcher then sees a code change that is not
  //    a manual edit: the running tone and the Tones record already carry the
  //    values, so that write is not re-evaluated.
  markAutoWrittenCode(soundId, result.code, sound.code)

  Meteor.call('sounds.updateCode', soundId, result.code, error => {
    if (error) {
      const message = `CODE UPDATE ERROR => ${error.message || error}`
      setParamsError(soundId, message)
      return
    }

    clearParamsError(soundId)
    opts.onSuccess && opts.onSuccess(result)
  })

  return result
}

//
// Debounced variant used by the mixer knobs.
//
// Extra options (used by the "save" entry point) are merged with the pending
// values, so flushing a drag writes both the pending values and the rest of
// the tone params in a single operation.
//
const runPending = (soundId, options) => {
  const entry = pending[soundId]
  const opts = options || {}

  if (!entry) return updateParamsInCode(soundId, undefined, opts)

  clearTimeout(entry.timer)
  delete pending[soundId]

  return updateParamsInCode(soundId, entry.toneId, Object.assign({}, opts, {
    values: entry.values,
    onSuccess: opts.onSuccess || entry.onSuccess,
    onError: opts.onError || entry.onError
  }))
}

export const scheduleParamsSave = (soundId, toneId, values, options) => {
  const opts = options || {}

  if (!values || typeof values !== 'object' || !Object.keys(values).length) return null

  const previous = pending[soundId]
  if (previous) clearTimeout(previous.timer)

  const entry = {
    toneId,
    values: Object.assign({}, previous && previous.values, values),
    onSuccess: opts.onSuccess,
    onError: opts.onError,
    timer: null
  }

  entry.timer = setTimeout(() => runPending(soundId), PARAMS_DEBOUNCE_MS)
  pending[soundId] = entry

  return entry
}

// Used by the "save" entry point: flush the pending values right away and
// write every numeric param of the tone back in the code (historical
// behaviour), in one single write.
export const flushParamsSave = (soundId, options) => {
  const opts = options || {}

  return runPending(soundId, {
    allParams: true,
    onSuccess: opts.onSuccess,
    onError: opts.onError
  })
}

export const hasPendingParamsSave = soundId => !!pending[soundId]

// Only useful for tests / when a sound is removed while a save is pending.
export const cancelParamsSave = soundId => {
  const entry = pending[soundId]
  if (!entry) return false

  clearTimeout(entry.timer)
  delete pending[soundId]
  return true
}
