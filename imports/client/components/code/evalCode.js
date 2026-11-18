import { filter, get } from 'lodash'
import { prepareCode } from './prepareCode'

import Tone from 'tone';
import teoria from 'teoria'

export let evalCode = (code) => {

  code = prepareCode(code)

  try {
    let result =  eval(`(function self(){${code}}())`);
    let error = `EDITOR RESULT ERROR => the code should contain one c(code) var`

    if(!result || typeof result !== 'object') return {status: 'err', body: error}
    if(!result.c) return {status: 'err', body: error}
    if(!result.e) return {status: 'err', body: error}

    // a sound does not need options: it simply has no knob on the mixer.
    let vars = get(result, ['o', 'vars'])
    if(vars !== undefined && !(vars instanceof Array)) {
      return {status: 'err', body: 'EDITOR RESULT ERROR => o/options.vars should be an array'}
    }

    if(vars) {
      let error = {status: 'err', body: 'EDITOR RESULT ERROR => each result.o.vars structure should be [NAMEVAR, VAR, MINVAL, MAXVAL, STEP, INIT]'}
      if (filter(vars, v => v instanceof Array).length !== vars.length) return error
    }
    return {status: 'ok', body: result}

  } catch (e) {
    let error = `EDITOR SYNTAX ERROR => ${e.message}`
    return {status: 'err', body: error}
  }
}
