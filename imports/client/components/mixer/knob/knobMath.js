import { clamp, round } from 'lodash'

import { isNumeric } from '../../code/params'

//
// Pure maths behind the knob gestures, kept apart so the behaviour can be
// unit-tested without a DOM.
//

// A vertical pan of KNEE pixels sweeps the whole [min, max] range.
export const PAN_KNEE = 200

// Depending on the version, Hammer reports deltaY either as a cumulative
// displacement since the pan started or as the displacement since the previous
// event. Callers pass the value plus a flag so the maths stays explicit.
export const deltaToValue = (startValue, deltaY, options) => {
  const opts = options || {}
  const max = isNumeric(opts.max) ? opts.max : 1
  const min = isNumeric(opts.min) ? opts.min : 0
  const precision = isNumeric(opts.precision) ? opts.precision : 0

  if (!isNumeric(startValue)) return undefined
  if (!isNumeric(deltaY)) return startValue

  const variator = (max / PAN_KNEE) * deltaY
  const value = round(startValue + variator, precision)

  return clamp(parseFloat(value), min, max)
}

// Clamp + round a raw value (typed input, persisted value...).
export const normalizeValue = (value, options) => {
  const opts = options || {}
  const min = isNumeric(opts.min) ? opts.min : 0
  const max = isNumeric(opts.max) ? opts.max : 1
  const precision = isNumeric(opts.precision) ? opts.precision : 0

  if (!isNumeric(value)) return undefined

  return clamp(parseFloat(round(value, precision)), min, max)
}

// Display precision derived from the step (`0.01` -> 2 decimals).
export const precisionFromStep = step => {
  const decimals = (step + '').split('.')[1]
  return decimals ? decimals.length : 0
}
