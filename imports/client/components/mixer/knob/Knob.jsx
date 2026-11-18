import React from 'react';

import Hammer from 'react-hammerjs';
import { round, throttle } from 'lodash';

import { isNumeric } from '../code/params';
import { deltaToValue, normalizeValue, precisionFromStep } from './knobMath';

require('./knob.sass')

const formatValue = (value, precision) => {
  if (!isNumeric(value)) return ''
  return String(round(value, precision))
}

export default class Knob extends React.Component {

  constructor(props){
    super(props)

    let precision = precisionFromStep(this.props.step)

    // initVal is the value written in the code, val the current (persisted)
    // value. The knob always displays the current value when there is one.
    let val = isNumeric(props.val) ? props.val : props.initVal
    val = isNumeric(val) ? val : (isNumeric(props.min) ? props.min : 0)

    this.state = {
      startingVal: val,
      val: val,
      // raw text of the input, so intermediate values ("1.", "-", "") can be
      // typed without the controlled input rejecting them.
      inputValue: formatValue(val, precision),
      currentPercentage: 0,
      precision: precision
    }

    // value at the beginning of the current gesture. Hammer reports the
    // movement of a pan, so the reference value must stay fixed while the
    // finger moves.
    this.gestureStartVal = val
    this.pendingDelta = 0
  }

  componentWillReceiveProps(nextProps) {
    // follow the value coming from the data layer, unless the user is
    // currently dragging this knob (the drag owns the value until it ends).
    if (this.dragging) return

    let nextVal = isNumeric(nextProps.val) ? nextProps.val : nextProps.initVal
    if (!isNumeric(nextVal)) return
    if (nextVal === this.state.val) return

    this.state.val = nextVal
    this.state.startingVal = nextVal
    this.state.inputValue = formatValue(nextVal, this.state.precision)
    this.gestureStartVal = nextVal
    this.updateCurrentPercentage()
  }

  componentDidMount () {
    this.updateCurrentPercentage()
  }

  componentWillUnmount () {
    this.unmounted = true
    this.throttleApplyGesture && this.throttleApplyGesture.cancel && this.throttleApplyGesture.cancel()
  }

  //
  // UX : touch management
  //

  // throttled with a trailing call: the final position of a gesture is never
  // lost.
  throttleApplyGesture = throttle(() => {
    if (this.unmounted) return
    this.applyGesture()
  }, 100)

  handlePan = e => {
    this.pendingDelta = isNumeric(e.deltaY) ? e.deltaY : 0
    this.throttleApplyGesture()
  }

  applyGesture = () => {
    let value = deltaToValue(this.gestureStartVal, this.pendingDelta, {
      min: this.props.min,
      max: this.props.max,
      precision: this.state.precision
    })

    if (!isNumeric(value)) return

    this.setValue(value)
  }

  handlePanStart = () => {
    this.dragging = true
    this.pendingDelta = 0
    this.gestureStartVal = this.state.val
    this.setState({startingVal: this.state.val})
  }

  handlePanEnd = () => {
    // apply the last pending movement before releasing the knob
    this.flushPan()
    this.dragging = false
    this.gestureStartVal = this.state.val
    this.pendingDelta = 0
    this.setState({startingVal: this.state.val})
  }

  flushPan = () => {
    if (this.throttleApplyGesture && this.throttleApplyGesture.flush) {
      this.throttleApplyGesture.flush()
      return
    }

    this.applyGesture()
  }

  modifyValueByInput = e => {
    let raw = e.target.value

    // keep what the user typed, including intermediate states ("1.", "-",
    // ""), so the field stays usable. Only a complete, numeric value is sent
    // to the sound.
    this.setState({inputValue: raw})

    let value = parseFloat(raw)
    if (!isNumeric(value)) return

    this.setValue(normalizeValue(value, {
      min: this.props.min,
      max: this.props.max,
      precision: this.state.precision
    }), {fromInput: true})
  }

  // Blur normalises what has been typed (and re-sends the clamped value).
  normalizeInput = () => {
    this.setValue(this.state.val)
  }

  //
  // The single place where the knob value changes: it keeps the state, the
  // displayed number and the sound in sync.
  //
  setValue = (value, options) => {
    if (!isNumeric(value)) return

    const opts = options || {}

    this.state.val = value
    this.state.startingVal = value

    // during a gesture the reference value must not move, otherwise every
    // update would apply the whole gesture again.
    if (!this.dragging) this.gestureStartVal = value

    // while typing, the text stays exactly what the user typed
    if (!opts.fromInput) this.state.inputValue = formatValue(value, this.state.precision)

    this.changeValue()
  }

  // UI

  updateCurrentPercentage = () => {
    let range = this.props.max - this.props.min
    let currentRelativePosition = this.state.val - this.props.min
    let currentPercentage = range ? (currentRelativePosition / range) * 100 : 0

    this.setState({currentPercentage: currentPercentage})
  }

  //
  // DATA FLOW
  //

  changeValue = () => {
    if (this.unmounted) return

    this.updateCurrentPercentage()
    this.props.onValueChange(this.state.val)
  }

	render() {
		return (
      <div className="component-knob">
        <Hammer
          onPan={this.handlePan}
          onPanStart={this.handlePanStart}
          onPanEnd={this.handlePanEnd}
          direction="DIRECTION_VERTICAL"
          options={this.state.hammerOptions}>
          <div>
            <div className="name"> {this.props.name} </div>
            <div className="knob" style={{transform: `rotate(${(this.state.currentPercentage * 3.60)}deg)`}}>
            </div>
            <input
              className="number"
              type="number"
              min={this.props.min}
              max={this.props.max}
              step={this.props.step}
              ref="input"
              value={this.state.inputValue}
              onChange={this.modifyValueByInput}
              onBlur={this.normalizeInput} />
          </div>
        </Hammer>
      </div>
    )
  }
}
