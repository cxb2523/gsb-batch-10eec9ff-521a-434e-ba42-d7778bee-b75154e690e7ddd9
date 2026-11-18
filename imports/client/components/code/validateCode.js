import Tone from 'tone'
import { each, find, get, isFunction } from 'lodash'

import { evalCode } from './evalCode'
import { getParamName, getParamValue, isNumeric, setParamValue } from './params'

//
// Validate a rewritten sound code before it is written back:
//
//  1. the code must evaluate,
//  2. the initial values it produces must be the ones displayed on the knobs
//     (after the init slot has been applied, exactly like the player does),
//  3. nothing must be scheduled or kept alive: Transport scheduling is stubbed
//     during the evaluation and every created object is disposed right after.
//
// The third point matters because a sound code often calls
// Tone.Transport.schedule(...) directly; evaluating it a second time would
// schedule the notes twice (and the callback id is usually not kept in a
// variable, so it could not be cleared afterwards).
//

const TRANSPORT_METHODS = ['schedule', 'scheduleOnce', 'scheduleRepeat', 'start', 'stop']

// initTonesModifiers() applies the init slot of each option tuple. The
// validation has to apply it too, otherwise it would judge the code on values
// that the player immediately overrides.
const applyInitValues = vars => {
  each(vars, v => {
    if (!(v instanceof Array)) return

    const initValue = v[5]
    if (!isNumeric(initValue)) return

    setParamValue(v, initValue, getParamName(v))
  })
}

const closeEnough = (actual, expected) => {
  if (!isNumeric(actual) || !isNumeric(expected)) return false
  return Math.abs(actual - expected) <= 1e-4 * Math.max(1, Math.abs(expected))
}

const stubTransport = () => {
  const transport = get(Tone, 'Transport')
  if (!transport) return null

  const saved = {}
  let stubId = -1

  each(TRANSPORT_METHODS, method => {
    if (!isFunction(transport[method])) return

    saved[method] = transport[method]
    transport[method] = () => {
      stubId -= 1
      return stubId
    }
  })

  return saved
}

const restoreTransport = saved => {
  if (!saved) return

  const transport = get(Tone, 'Transport')
  if (!transport) return

  each(saved, (method, name) => {
    transport[name] = method
  })
}

const muteMaster = () => {
  const master = get(Tone, 'Master')
  if (!master || master.mute === undefined) return null

  const previous = master.mute
  try { master.mute = true } catch (e) { return null }

  return { previous }
}

const restoreMaster = state => {
  if (!state) return

  const master = get(Tone, 'Master')
  if (master) master.mute = state.previous
}

export const validateSoundCode = (code, expectedParams) => {
  const savedTransport = stubTransport()
  const masterState = muteMaster()

  let result

  try {
    result = evalCode(code)
  } catch (e) {
    result = { status: 'err', body: `CODE VALIDATION ERROR => ${e.message}` }
  } finally {
    restoreTransport(savedTransport)
    restoreMaster(masterState)
  }

  if (result.status === 'err') return result

  const body = result.body || {}
  const vars = get(body, ['o', 'vars'])
  const elements = body.e instanceof Array ? body.e : []

  if (vars instanceof Array) {
    applyInitValues(vars)

    let mismatch = null
    each(expectedParams, param => {
      if (mismatch) return

      const entry = find(vars, v => getParamName(v) === param.name)
      if (!entry) return

      const value = getParamValue(entry, param.name)
      if (!closeEnough(value, param.value)) {
        mismatch = `the parameter "${param.name}" would be re-evaluated as ${value} instead of ${param.value}`
      }
    })

    if (mismatch) {
      each(elements, element => {
        if (isFunction(get(element, 'dispose'))) try { element.dispose() } catch (e) { /* ignore */ }
      })

      return { status: 'err', body: `CODE UPDATE ERROR => ${mismatch}` }
    }
  }

  each(elements, element => {
    if (!isFunction(get(element, 'dispose'))) return
    try { element.dispose() } catch (e) { /* already disposed / not disposable */ }
  })

  return result
}
