import {filter, reduce, intersection, find, isEqual, each} from 'lodash';

// Properties that require the sound to be re-evaluated by the player.
const PLAYBACK_PROPS = ['code', 'muted'];

export let soundsWatcher = (props) => {
  // 1 DETECT SOUNDS ADDED
  each(props.array1, sound => {
    if (!sound) return false

    let oldSound = find(props.array2, {_id: sound._id})
    if (!oldSound) {
      if (props.added) {
        return props.added(sound)
      }
    }
  })

  // 2 DETECT SOUNDS DELETED
  each(props.array2, sound => {
    if (!sound) return false

    let newSound = find(props.array1, {_id: sound._id})
    if (!newSound) {
      if (props.deleted) {
        return props.deleted(sound)
      }

      return
    }

    // 3 DETECT SOUNDS UPDATED
    let props2 = reduce(sound, (result, value, key) => isEqual(value, newSound[key]) ? result : result.concat(key), [])

    if (props2.length === 0) return

    let playbackProps = intersection(PLAYBACK_PROPS, props2)

    if (playbackProps.length > 0)  {
      if (props.updated) {
        return props.updated(newSound, playbackProps[0], props2)
      }

      return
    }

    if (props.nothing) {
      return props.nothing(newSound, props2[0])
    }
  })
}
