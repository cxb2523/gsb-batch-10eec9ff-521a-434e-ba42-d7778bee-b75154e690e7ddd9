import { Meteor } from 'meteor/meteor'

import React from 'react';

import Tone from 'tone';

import styled from 'styled-components';

import { updateSound, removeSound } from './sounds';
import { soundsWatcher } from './soundsWatcher';
import { observeTones } from './tones';
import { consumeAutoWrittenCode } from '../code/codeSafety';
import { clearParamsError, setParamsError } from '../code/paramsFeedback';
import { cancelParamsSave } from '../code/updateParamsInCode';

export default class Player extends React.Component {

  constructor(props){
    super(props)
    this.state = {
      codeErrors: false
    }
  }

  componentDidMount () {
    // clean all the meteor collection replication of the window.tones object
    Meteor.call('tones.removeAll')

    Tone.Transport.start('+0.1')
    Tone.Transport.loopEnd = '2m'
    Tone.Transport.loop = true
    window.Tone = Tone

    Tone.context.latencyHint = "interactive"

    observeTones()
  }

  //
  // Evaluate a sound and report errors.
  //
  // A code write produced by a knob does not need to be evaluated again: the
  // live tone already carries the value, the Tones record has been updated
  // and the written code was validated before being stored. Skipping it also
  // avoids restarting the sound (and rebuilding its Tones record) while the
  // user drags a knob.
  //
  evaluate = (sound, reason) => {
    if (reason === 'code' && consumeAutoWrittenCode(sound)) {
      return { status: 'ok' }
    }

    let result = updateSound(sound)

    if (result.status === 'ok') {
      this.setState({codeErrors: false})
      clearParamsError(sound._id)
      return result
    }

    this.setState({codeErrors: result.body})

    if (reason === 'code') setParamsError(sound._id, result.body)

    return result
  }

  componentWillReceiveProps(nextProps) {
    soundsWatcher({
      array1: nextProps.sounds,
      array2: this.props.sounds,
      added: s => this.evaluate(s, 'added'),
      updated: (s, p) => this.evaluate(s, p === 'code' ? 'code' : 'muted'),
      deleted: s => {
        cancelParamsSave(s._id)
        clearParamsError(s._id)
        removeSound(s)
      },
      nothing: () => {}
    })
  }

  componentWillUnmount () {
    Tone.Transport.stop()
  }

	render() {
    let errors = this.state.codeErrors ? this.state.codeErrors : 'no synthax error'

		return (
      <div>
        <Result error={this.state.codeErrors}> {errors} </Result>
      </div>

    )
  }
}

const Result = styled.p`
  color: ${props => props.error ? 'red' : 'green'};
`;
