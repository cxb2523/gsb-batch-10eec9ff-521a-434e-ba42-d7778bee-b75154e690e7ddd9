//
// The mixer writes knob values back into the sound code, and the sounds
// watcher then re-evaluates the sound. That is how the written code becomes
// authoritative, and how an invalid write gets detected.
//
// This module remembers the exact code strings produced by the mixer so the
// player can tell a mixer write apart from a manual edit, roll a write that
// cannot be evaluated back to the previous valid code, and avoid
// re-evaluating that restore.
//

const LIMIT = 10

const written = {}

// `restore` marks a code written back after a failed mixer write: the running
// tone is already the good one, so it must not be evaluated again.
export const markAutoWrittenCode = (soundId, code, previousCode, restore) => {
  if (!soundId || typeof code !== 'string') return false

  const entries = written[soundId] || []
  entries.push({
    code,
    previousCode: typeof previousCode === 'string' ? previousCode : null,
    restore: !!restore
  })

  written[soundId] = entries.slice(-LIMIT)
  return true
}

export const clearAutoWrittenCode = soundId => {
  delete written[soundId]
}

// Returns the marker matching the current code of the sound, or null.
// The marker is consumed so a code is never treated twice.
export const consumeAutoWrittenCode = sound => {
  if (!sound || !sound._id) return null

  const entries = written[sound._id]
  if (!(entries instanceof Array) || !entries.length) return null

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].code !== sound.code) continue

    const entry = entries[i]
    entries.splice(i, 1)

    if (!entries.length) delete written[sound._id]

    return entry
  }

  // the code changed again: pending markers are stale
  delete written[sound._id]
  return null
}
