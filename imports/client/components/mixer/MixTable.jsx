import React from 'react';
import styled from 'styled-components';

import { Tracker } from 'meteor/tracker'

import Knob from './knob/Knob';
import {
  flushParamsSave,
  scheduleParamsSave,
  applyParamValue
} from '../code/updateParamsInCode';
import {
  getParamName,
  getParamValue,
  isNumeric
} from '../code/params';
import { clearParamsError, getAllParamsErrors } from '../code/paramsFeedback';

//
// One mixer strip per generated tone.
//
// Moving a knob does the whole loop:
//  1. the live tone played by Tone.Transport changes immediately
//  2. the value is written back in the sound code (debounced, so a continuous
//     drag only produces one write)
//  3. the Tones document is updated with the final value (debounced as well)
//  4. the "save" entry point flushes anything still pending, keeping its
//     historical semantics
//
// When the code cannot be rewritten the original code is left untouched, the
// knob keeps displaying its current value and an error is shown on screen.
//
export default class MixTable extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      errors: {}
    }
  }

  componentDidMount() {
    // the debounced write can fail outside of a React event: follow the
    // reactive error store so the error stays visible.
    this.errorComputation = Tracker.autorun(() => {
      if (this.unmounted) return
      this.setState({ errors: getAllParamsErrors() })
    })
  }

  componentWillUnmount() {
    this.unmounted = true
    this.errorComputation && this.errorComputation.stop()
  }

  // Move a knob: apply to memory now, write back to the code / database
  // shortly after, so a continuous drag is coalesced into a final value.
  changeValue = (tone, name, value) => {
    // never modify a param that is not a number (strings, booleans...)
    if (!name || !isNumeric(value)) return

    // 1. the sound playing in memory changes right away
    applyParamValue(tone.soundId, name, value)

    // 2. persist the value + write it back in the code (debounced)
    scheduleParamsSave(tone.soundId, tone._id, { [name]: value })
  }

  // Historical "save" entry point: same behaviour (write the tone params back
  // in the code) but it flushes pending knob values first.
  saveParamsTone = tone => {
    clearParamsError(tone.soundId)
    flushParamsSave(tone.soundId)
  }

  // Only entries carrying a numeric parameter are knobs. A string / boolean
  // option has no numeric value and must never be presented as adjustable.
  renderKnob = (tone, v, i) => {
    if (!(v instanceof Array)) return null

    const name = getParamName(v)
    const value = getParamValue(v)

    if (!name || !isNumeric(value)) return null

    // the tuple is [NAME, VAR, MIN, MAX, STEP, INIT?]
    const min = isNumeric(v[2]) ? v[2] : 0
    const max = isNumeric(v[3]) ? v[3] : 1
    const step = isNumeric(v[4]) ? v[4] : 0.01

    return (
      <Knob
        key={`${tone.soundId}-${name}`}
        name={name}
        val={value}
        min={min}
        max={max}
        step={step}
        initVal={v[5]}
        onValueChange={this.changeValue.bind(this, tone, name)} />
    )
  }

  render() {
    return (
      <Table>
        {this.props.tones.map(tone => (
          <SoundMixer key={tone.soundId}>
            <SoundName>{tone.name}</SoundName>
            <div>
               {(tone.options && tone.options.vars) && tone.options.vars.map((v, i) =>
                  this.renderKnob(tone, v, i)
               )}
            </div>
            <SaveButton onClick={this.saveParamsTone.bind(this, tone)}>save</SaveButton>
            {this.state.errors[tone.soundId] && (
              <Error>{this.state.errors[tone.soundId]}</Error>
            )}
          </SoundMixer>
          )
        )}
        <Clear></Clear>
      </Table>
    )
  }
}

//
// CSS
//

const Table = styled.div`

`;

const Clear = styled.div`
  clear: both;
`;

const SoundName = styled.div`
  padding: 10px;
  background: #dfdfdf;
  text-align: center;
`;

const SoundMixer = styled.div`
  background: #f3f3f3;
  max-width: 50%;
  margin: 5px;
  float: left;
`;

const SaveButton = styled.div`
  cursor: pointer;
  padding: 4px;
  border-top: 1px solid #ccc;
  text-align: center;
`;

const Error = styled.div`
  color: red;
  padding: 4px;
  max-width: 260px;
  font-size: 11px;
  word-wrap: break-word;
`;
