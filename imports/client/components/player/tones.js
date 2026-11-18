import Tone from 'tone';
import { Meteor } from 'meteor/meteor'

import { Tones } from '/imports/api/tones';
import { each, find, get, round } from 'lodash';

import {
  buildPersistableTone,
  getParamName,
  getParamValue,
  isNumeric,
  setParamValue
} from '../code/params';

if (Meteor.isClient) Meteor.subscribe('tones');

export let getToneType = tone => {
  if (typeof tone === 'number') return 'transport-event'
  else if (typeof tone === 'object') return 'loop'

  return false
}

export let stopTone = tone => {
  let type = getToneType(tone)
  type === 'loop' && Tone.Transport.scheduleOnce(t => tone.stop().dispose(), 1)
  type === 'transport-event' && Tone.Transport.clear(tone)
}

export let startTone = tone => {
  let type = getToneType(tone)
  type === 'loop' && Tone.Transport.scheduleOnce(t => tone.start(0), 1)
}

// for each option var defined in the o array, apply the init value
// ['pitchDecay', synth, 0, 0.5, 0.001, 0] -> the last entry is the init value
export let initTonesModifiers = (vars) => {
  each(vars, v => {
    if (!(v instanceof Array)) return

    let initValue = v[5]
    if (!isNumeric(initValue)) return

    setParamValue(v, round(initValue, 5), getParamName(v))
  })
}

// persist the window.tones object to a meteor collection.
//
// Only the data used by the mixer is sent: the live Tone objects are not
// serializable and are rebuilt by the player anyway.
//
// `tones.replace` keeps a single record per sound (the existing document is
// updated in place, and its createdAt is preserved), so re-evaluating a sound
// never leaves a duplicate or a stale tone record behind.
export let persistTone = tone => {
  let vars = get(tone, ['options', 'vars'])
  if (!(vars instanceof Array)) return false

  let payload = buildPersistableTone(tone, tone.soundId)
  delete payload._id

  // only a new record needs a creation date: tones.replace keeps the existing
  // one (so the mixer strips are not reordered on every re-evaluation).
  if (tone.createdAt) payload.createdAt = tone.createdAt
  else delete payload.createdAt

  Meteor.call('tones.replace', payload)
  return payload
}

export let getToneForSound = soundId => {
  if (!get(window, 'tones')) return undefined
  return find(window.tones, {soundId: soundId})
}

// if we have some vars inside the options that changed
// spread the change to the live value so the running sound is modified
export let observeTones = () => {
  Tones.find().observeChanges({
    changed: (id, fields) => {
      let toneDocument = Tones.findOne(id)
      if (!toneDocument) return

      let liveTone = getToneForSound(toneDocument.soundId)
      if (!liveTone || !liveTone.options) return

      let vars = get(fields, ['options', 'vars']) || get(toneDocument, ['options', 'vars'])
      if (!(vars instanceof Array)) return

      each(vars, v => {
        let name = getParamName(v)
        let value = getParamValue(v, name)
        if (!isNumeric(value)) return

        // never map a param by its index: a malformed entry could shift
        // everything. Look the live entry up by name instead.
        each(liveTone.options.vars, liveEntry => {
          if (getParamName(liveEntry) !== name) return
          setParamValue(liveEntry, value, name)
        })
      })
    }
  })
}
