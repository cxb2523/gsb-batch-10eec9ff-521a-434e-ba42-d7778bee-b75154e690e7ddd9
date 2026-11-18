import { Tracker } from 'meteor/tracker'

//
// Small reactive store holding the last error produced while writing a knob
// value back into the sound code, keyed by soundId.
//
// The mixer subscribes to it so an error stays visible even when it happens
// outside of a React event (debounced write, failed evaluation...).
//

const errors = {}
const dependency = new Tracker.Dependency()

const notify = () => dependency.changed()

export const setParamsError = (soundId, message) => {
  if (!soundId) return

  if (!message) {
    clearParamsError(soundId)
    return
  }

  if (errors[soundId] === message) return

  errors[soundId] = message
  notify()
}

export const clearParamsError = soundId => {
  if (!soundId || errors[soundId] === undefined) return

  delete errors[soundId]
  notify()
}

export const getParamsError = soundId => {
  dependency.depend()
  return errors[soundId] || null
}

export const getAllParamsErrors = () => {
  dependency.depend()
  return Object.assign({}, errors)
}
