import { isNumber, round } from 'lodash'

//
// Helpers around an entry of `o.vars` / `options.vars`.
//
// An option entry has the shape:
//
//   [NAME, VARIABLE, MIN, MAX, STEP, INIT_VALUE?]
//
// VARIABLE can be:
//
//  - a plain number (a literal like `0.5` written in the code, or a variable
//    holding a number). The value lives in the entry itself.
//
//  - an object whose property `NAME` is a number
//      ['attack', synth.envelope, 0, 1, 0.01, 0.1]
//    The value lives in `variable[NAME]`.
//
//  - a Tone.Param object (e.g. `vol.volume`), whose value lives in
//    `variable.value` (a getter), and is mirrored into `persistedValue` when
//    the tone is persisted in the Tones collection.
//
// Everything else (strings, booleans, undefined...) is *not* a knob and must
// never be modified.
//

export const PARAM_KIND_NUMBER = 'number'
export const PARAM_KIND_PROPERTY = 'property'
export const PARAM_KIND_TONE_PARAM = 'tone-param'
export const PARAM_KIND_UNKNOWN = 'unknown'

// lodash `isNumber(NaN)` is true, so NaN/Infinity are never valid knob values.
export const isNumeric = value => isNumber(value) && isFinite(value)

export const isOptionEntry = v => v instanceof Array && v.length >= 2

export const getParamName = v => (isOptionEntry(v) && typeof v[0] === 'string' ? v[0] : undefined)

//
// Kind of the variable held by an option entry.
//
export const getParamKind = (v, name) => {
  if (!isOptionEntry(v)) return PARAM_KIND_UNKNOWN

  const paramName = name !== undefined ? name : getParamName(v)
  const variable = v[1]

  if (isNumeric(variable)) return PARAM_KIND_NUMBER

  if (variable && typeof variable === 'object') {
    // a plain numeric property (synth.envelope.attack & co)
    if (paramName && isNumeric(variable[paramName])) return PARAM_KIND_PROPERTY

    // a Tone.Param (live: value getter, persisted: persistedValue)
    if (isNumeric(variable.value) || isNumeric(variable.persistedValue)) {
      return PARAM_KIND_TONE_PARAM
    }
  }

  return PARAM_KIND_UNKNOWN
}

//
// Current numeric value of an option entry, or undefined when the entry does
// not hold a numeric parameter.
//
export const getParamValue = (v, name) => {
  if (!isOptionEntry(v)) return undefined

  const paramName = name !== undefined ? name : getParamName(v)
  const variable = v[1]

  if (isNumeric(variable)) return variable

  if (!variable || typeof variable !== 'object') return undefined

  if (paramName && isNumeric(variable[paramName])) return variable[paramName]
  if (isNumeric(variable.persistedValue)) return variable.persistedValue
  if (isNumeric(variable.value)) return variable.value

  return undefined
}

export const isNumericParam = (v, name) => getParamValue(v, name) !== undefined

//
// Write a value on an option entry.
// Returns false when the entry does not hold a numeric parameter, so callers
// can never accidentally modify a non numeric param.
//
export const setParamValue = (v, value, name) => {
  if (!isOptionEntry(v) || !isNumeric(value)) return false

  const paramName = name !== undefined ? name : getParamName(v)
  const variable = v[1]

  // plain number: the value is the entry itself
  if (isNumeric(variable)) {
    v[1] = value
    return true
  }

  if (!variable || typeof variable !== 'object') return false

  const kind = getParamKind(v, paramName)

  if (kind === PARAM_KIND_PROPERTY) {
    variable[paramName] = value
    return true
  }

  if (kind === PARAM_KIND_TONE_PARAM) {
    // on a live Tone.Param `value` is a setter; on the serialized copy it is
    // a plain field. In both cases persistedValue keeps the mixer in sync.
    variable.value = value
    variable.persistedValue = value
    return true
  }

  return false
}

//
// Render a number as a valid JavaScript literal, without float noise.
//
export const formatNumber = value => {
  if (!isNumeric(value)) return null
  return String(round(value, 10))
}

//
// Build a JSON/DDP friendly copy of a variable held by an option entry.
// A live Tone.Param cannot be sent to the server as is, only the numeric
// value matters for the mixer.
//
export const serializeParamVariable = (v, name) => {
  const paramName = name !== undefined ? name : getParamName(v)
  const kind = getParamKind(v, paramName)
  const value = getParamValue(v, paramName)

  if (kind === PARAM_KIND_NUMBER) return value
  if (!isNumeric(value)) {
    const variable = v[1]

    // keep primitives as they are (a string option stays a string), but never
    // try to serialize a live Tone object.
    if (typeof variable === 'string' || typeof variable === 'boolean' || variable === null) return variable

    return null
  }

  if (kind === PARAM_KIND_PROPERTY) {
    const serialized = {}
    serialized[paramName] = value
    serialized.persistedValue = value
    return serialized
  }

  return { value, persistedValue: value }
}

//
// Build the payload sent to the Tones collection.
// Only the data used by the mixer is kept (the live Tone objects are not
// serializable and are re-created by the player anyway).
//
export const buildPersistableTone = (tone, soundId) => {
  const source = tone || {}
  const vars = source.options && source.options.vars

  const payload = {
    soundId: soundId !== undefined ? soundId : source.soundId,
    name: source.name,
    options: {
      vars: (vars instanceof Array ? vars : []).map(v => {
        if (!(v instanceof Array) || v.length < 2) return v

        const name = getParamName(v)
        const serialized = serializeParamVariable(v, name)

        const copy = v.slice()
        copy[1] = serialized
        return copy
      })
    }
  }

  if (source._id) payload._id = source._id
  if (source.createdAt) payload.createdAt = source.createdAt

  return payload
}

//
// Read the current params of a persisted tone document.
// Returns { NAME: {name, value, kind} }.
//
export const getParamsFromTone = tone => {
  const params = {}
  const vars = tone && tone.options && tone.options.vars

  if (!(vars instanceof Array)) return params

  vars.forEach(v => {
    const name = getParamName(v)
    if (!name) return

    const value = getParamValue(v, name)
    if (!isNumeric(value)) return

    params[name] = { name, value, kind: getParamKind(v, name) }
  })

  return params
}
