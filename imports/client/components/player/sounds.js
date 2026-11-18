import { evalCode } from '../code/evalCode';
import { stopTone, startTone, initTonesModifiers, persistTone } from './tones';

import { Meteor } from 'meteor/meteor'
import Tone from 'tone';
import {filter, isFunction, each, get} from 'lodash';

if (!(window.tones instanceof Array)) window.tones = []

//
// Evaluate a sound code and start the resulting tone.
//
// The code is evaluated *before* the running tone is replaced: a code that
// cannot be evaluated leaves the current sound untouched instead of stopping
// it.
//
export let updateSound = sound => {
  if (sound.muted) {
    // a muted sound has no knob on the mixer: its tone record must not linger
    removeSound(sound)
    return {status:'ok'}
  }

  let result = evalCode(sound.code)

  if (result.status === 'err') return result

  result = result.body
  result = {soundId: sound._id, name: sound.name, tone: result.c, elementsToDispose: result.e, options: result.o}

  // the code is valid: replace the previous tone of that sound
  removeSound(sound, true)

  startTone(result.tone)

  window.tones.push(result)

  initTonesModifiers(get(result, ['options', 'vars']))

  if (get(result, ['options', 'vars'])) {
    persistTone(result)
  } else {
    // the sound declares no options anymore: no knob, so no tone record
    Meteor.call('tones.removeFromSoundId', sound._id)
  }

  return {status:'ok'}
}

// when tone get removed
export let removeSound = (sound, dispose) => {
  if (!sound) return

  let old = filter(window.tones, t => t && t.soundId === sound._id)

  each(old, tone => {
    stopTone(tone.tone)

    if (get(tone, 'elementsToDispose')) Tone.Transport.scheduleOnce(t => {
      each(tone.elementsToDispose, e => {
        // if we have elementsToDispose, try to dispose them (tonejs)
        if (isFunction(get(e, 'dispose'))) try { e.dispose() } catch (err) { console.log('error when dispose() :'+ err.message) }
      })
    }, 1)
  })

  window.tones = filter(window.tones, t => !t || t.soundId !== sound._id)

  // on a re-evaluation (dispose=true) persistTone replaces the record in the
  // same tick, so it is not removed here. When the sound is really deleted
  // the record has to go away with it.
  if (!dispose) Meteor.call('tones.removeFromSoundId', sound._id)
}
