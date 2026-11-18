import esprima from 'esprima'
import { filter, each } from 'lodash'

//
// Add the `return {c, o, e}` statement used by evalCode to the sound code.
//
// A sound without options (`o` / `options` not declared) is valid: the mixer
// then simply has no knob for it. In that case the return statement must not
// reference an undeclared variable, otherwise the whole sound would fail to
// evaluate.
//
export let prepareCode = (code) => {
  try {
    let result = esprima.parseModule(code)

    // get all the vars declarations
    let variables = filter(result.body, e => e.type === "VariableDeclaration")

    let declaredNames = []
    each(variables, v => each(v.declarations, declaration => {
      if (declaration.id && declaration.id.name) declaredNames.push(declaration.id.name)
    }))

    // build the object returned according to what is given
    let toneVar = filter(variables, v => ['t', 'tone', 'c'].includes(v.declarations[0].id.name))[0] || false
    if (toneVar) toneVar = toneVar.declarations[0].id.name

    let optionsVar = filter(variables, v => ['o', 'options'].includes(v.declarations[0].id.name))[0] || false
    if (optionsVar) optionsVar = optionsVar.declarations[0].id.name

    let allElements = declaredNames

    // undeclared values are replaced by their safe default so the returned
    // object stays well formed.
    let returnStatement = `return {c: ${toneVar || 'undefined'}, o: ${optionsVar || 'undefined'}, e: [${allElements}]}`

    return code + '\n\r' + returnStatement

  } catch (e) {
    console.warn('PrepareCode Error :', e)
    return code
  }
}
