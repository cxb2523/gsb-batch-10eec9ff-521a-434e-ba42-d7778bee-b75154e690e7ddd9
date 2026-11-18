import esprima from 'esprima'
import { each } from 'lodash'

import {
  PARAM_KIND_NUMBER,
  PARAM_KIND_PROPERTY,
  PARAM_KIND_TONE_PARAM,
  formatNumber,
  isNumeric
} from './params'

//
// Rewrite the `o.vars` / `options.vars` declaration of a sound code so that
// the values written there match the values currently displayed on the mixer.
//
// An option tuple is `[NAME, VARIABLE, MIN, MAX, STEP, INIT?]`.
//
// Three shapes are handled:
//
//  1. a plain number literal
//       ['attack', 0.5, 0, 1, 0.01]
//     -> the literal is replaced (and the optional init slot kept in sync).
//
//  2. a numeric property of a container object
//       ['attack', synth.envelope, 0, 1, 0.01]
//     -> `synth.envelope.attack = <value>` is updated, or inserted before the
//        options declaration when the code never sets it. The init slot is
//        updated as well because initTonesModifiers() applies it when the
//        code is evaluated.
//
//  3. a Tone.Param
//       ['volume', vol.volume, -100, 100, 1]
//     -> `vol.volume.value = <value>` is updated, or inserted the same way.
//
//  4. a number coming from an expression
//       ['attack', synth.envelope.attack, 0, 1, 0.01]
//     -> the expression itself is updated / gets an assignment.
//
// A parameter whose value slot is not numeric at all (a string, a boolean...)
// is never touched.
//
// The rewrite is done on the esprima AST using node ranges instead of a blind
// regex, so it cannot corrupt unrelated code. A rewritten code that does not
// parse anymore is never returned: the caller receives an error and keeps the
// original code.
//

const OPTIONS_VAR_NAMES = ['o', 'options']
const VARS_PROP_NAME = 'vars'
const OPTION_VALUE_INDEX = 1
const OPTION_INIT_INDEX = 5

// identifiers that are always available when the sound code is evaluated
const KNOWN_GLOBALS = ['Tone', 'window', 'global', 'document', 'Math', 'console', 'this']

const isNode = node => !!node && typeof node === 'object' && typeof node.type === 'string'

const normalize = text => (text || '').replace(/\s+/g, '')

const walkAst = (node, visit, parent) => {
  if (!isNode(node)) return

  visit(node, parent)

  each(node, (value, key) => {
    if (key === 'range' || key === 'loc' || key === 'type') return

    if (value instanceof Array) {
      each(value, child => walkAst(child, visit, node))
      return
    }

    if (isNode(value)) walkAst(value, visit, node)
  })
}

// {start, end, value} for a numeric literal (negative numbers are an
// UnaryExpression around a Literal).
const numericNodeInfo = node => {
  if (!isNode(node)) return null

  if (node.type === 'Literal' && isNumeric(node.value)) {
    return { start: node.range[0], end: node.range[1], value: node.value }
  }

  if (
    node.type === 'UnaryExpression' &&
    (node.operator === '-' || node.operator === '+') &&
    node.argument &&
    node.argument.type === 'Literal' &&
    isNumeric(node.argument.value)
  ) {
    return {
      start: node.range[0],
      end: node.range[1],
      value: node.operator === '-' ? -node.argument.value : node.argument.value
    }
  }

  return null
}

const stringNodeValue = node => {
  if (!isNode(node) || node.type !== 'Literal') return undefined
  return typeof node.value === 'string' ? node.value : undefined
}

// Find the array behind `o = { vars: [...] }` / `options = { vars: [...] }`
// together with the statement declaring it.
const findOptionsDeclaration = ast => {
  let found = null

  each(ast.body, statement => {
    if (found || !statement || statement.type !== 'VariableDeclaration') return

    each(statement.declarations, declaration => {
      if (found || !declaration || !declaration.id || declaration.id.type !== 'Identifier') return
      if (!OPTIONS_VAR_NAMES.includes(declaration.id.name)) return
      if (!declaration.init || declaration.init.type !== 'ObjectExpression') return

      each(declaration.init.properties, property => {
        if (found || !property || property.type !== 'Property') return

        const key = property.key && (property.key.name !== undefined ? property.key.name : property.key.value)
        if (key === VARS_PROP_NAME && property.value && property.value.type === 'ArrayExpression') {
          found = { statement, varsArray: property.value }
        }
      })
    })
  })

  return found
}

const findTupleForName = (varsArray, name) => {
  let found = null

  each(varsArray.elements, element => {
    if (found || !element || element.type !== 'ArrayExpression') return
    if (!element.elements || !element.elements.length) return
    if (stringNodeValue(element.elements[0]) === name) found = element
  })

  return found
}

const findVariableDeclaration = (ast, name) => {
  let found = null

  each(ast.body, statement => {
    if (found || !statement || statement.type !== 'VariableDeclaration') return

    each(statement.declarations, declaration => {
      if (found || !declaration.id || declaration.id.type !== 'Identifier') return
      if (declaration.id.name === name) found = { declaration, kind: statement.kind }
    })
  })

  return found
}

const hasIdentifierDeclared = (ast, name) => {
  let declared = false

  walkAst(ast, node => {
    if (declared) return

    if (node.type === 'VariableDeclarator' && node.id && node.id.type === 'Identifier' && node.id.name === name) {
      declared = true
      return
    }

    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id && node.id.name === name) {
      declared = true
      return
    }

    // a parameter (e.g. a Tone.Transport callback receives time/note)
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      each(node.params, param => {
        if (param && param.type === 'Identifier' && param.name === name) declared = true
      })
    }
  })

  return declared
}

// A declaration after the options tuple would reset the value that is
// assigned just before it (`x = 7; var x = 1` -> x is 1 again). The option
// tuple can only be trusted when the variable is created before it.
const isDeclaredBefore = (ast, name, position) => {
  let declared = false

  each(ast.body, statement => {
    if (declared || !statement || !statement.range) return
    if (statement.range[0] >= position) return

    if (statement.type !== 'VariableDeclaration') return

    each(statement.declarations, declaration => {
      if (declaration.id && declaration.id.type === 'Identifier' && declaration.id.name === name) {
        declared = true
      }
    })
  })

  return declared
}

// Root identifier of a member chain: `a.b.c` -> `a`
const findRootIdentifier = node => {
  let current = node
  let guard = 0

  while (isNode(current) && guard < 50) {
    guard += 1

    if (current.type === 'Identifier') return current.name
    if (current.type === 'MemberExpression') { current = current.object; continue }
    if (current.type === 'ThisExpression') return 'this'

    return undefined
  }

  return undefined
}

const findAssignments = (ast, code, paths, before) => {
  const matches = []
  const wanted = paths.map(path => normalize(path)).filter(Boolean)

  // Only top-level assignments are considered. An assignment inside a
  // scheduled callback (a modulation, for instance) must never be rewritten:
  // its value is not the initial value of the parameter.
  each(ast.body, statement => {
    if (!statement || statement.type !== 'ExpressionStatement') return
    if (!statement.range) return
    if (isNumeric(before) && statement.range[0] >= before) return
    if (!statement.expression || statement.expression.type !== 'AssignmentExpression') return

    const assignment = statement.expression
    if (assignment.operator !== '=') return
    if (!assignment.left) return
    if (assignment.left.type !== 'MemberExpression' && assignment.left.type !== 'Identifier') return

    const left = normalize(code.slice(assignment.left.range[0], assignment.left.range[1]))
    if (wanted.includes(left)) matches.push(assignment)
  })

  return matches
}

// Which expression has to receive the assignment, according to the kind of
// the parameter and the expression declared in the code.
//
// `kind` is the runtime kind of the value (number / property / Tone.Param),
// the expression is what the code put in the VALUE slot of the tuple:
//
//  - 0.5                 -> handled before this call (literal replacement)
//  - synth.envelope      -> property: `synth.envelope.attack` is assigned
//  - vol.volume          -> Tone.Param: `vol.volume.value` is assigned
//  - synth.envelope.attack / someNumberVar
//                        -> number whose value comes from an expression:
//                           the expression itself is assigned
//  - 1 / 2, Math.PI * 2  -> cannot be mapped back to an assignment: refused
//
// Only Identifier / MemberExpression roots are accepted: binding an
// expression would corrupt the code instead of updating it.
const resolveAssignmentTarget = (code, node, kind, name) => {
  if (!isNode(node)) return null

  if (node.type !== 'Identifier' && node.type !== 'MemberExpression') return null

  const basePath = normalize(code.slice(node.range[0], node.range[1]))
  if (!basePath) return null

  let assignPath = null

  if (kind === PARAM_KIND_TONE_PARAM) {
    assignPath = /\.value$/.test(basePath) ? basePath : `${basePath}.value`
  } else if (kind === PARAM_KIND_PROPERTY) {
    assignPath = `${basePath}.${name}`
  } else if (kind === PARAM_KIND_NUMBER) {
    // the declared expression itself is a number slot (synth.envelope.attack,
    // or a numeric variable)
    assignPath = basePath
  }

  if (!assignPath) return null

  return {
    basePath,
    assignPath,
    isIdentifier: node.type === 'Identifier',
    node
  }
}

//
// Apply every edit at once, from the end of the code to its beginning so the
// still-untouched ranges stay valid. The insertion of new assignments is an
// edit of its own (an empty range), which makes it immune to the length
// changes produced by the other edits.
//
const applyEdits = (code, edits) => {
  const sorted = edits
    .slice()
    .sort((a, b) => (b.start - a.start) || (b.end - a.end))

  const seen = {}
  let result = code

  each(sorted, edit => {
    const key = `${edit.start}:${edit.end}:${edit.text}`
    if (seen[key]) return
    seen[key] = true

    if (edit.start < 0 || edit.end > code.length || edit.start > edit.end) return
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  })

  return result
}

//
// Normalize the different accepted `params` shapes into a list of
// {name, value, kind}.
//
const getParamList = params => {
  const byName = {}

  const register = param => {
    if (!param || typeof param.name !== 'string') return

    const value = param.value
    if (!isNumeric(value)) return

    byName[param.name] = {
      name: param.name,
      value,
      kind: param.kind || PARAM_KIND_NUMBER
    }
  }

  if (params instanceof Array) {
    each(params, param => {
      if (param instanceof Array) register({ name: param[0], value: param[1], kind: param[2] })
      else register(param)
    })
  } else if (params && typeof params === 'object') {
    each(params, (param, name) => {
      if (param && typeof param === 'object' && !(param instanceof Array)) {
        register({
          name: param.name || name,
          value: isNumeric(param.value) ? param.value : param.persistedValue,
          kind: param.kind
        })
        return
      }

      register({ name, value: param, kind: PARAM_KIND_NUMBER })
    })
  }

  return Object.keys(byName).map(name => byName[name])
}

//
// Plan the rewrite of one parameter.
// Returns an error message (string) or null.
//
const planParam = (code, ast, varsArray, param, accumulator) => {
  const tuple = findTupleForName(varsArray, param.name)
  if (!tuple) return `PARAM "${param.name}" IS NOT DECLARED IN THE o.vars ARRAY`

  const elements = tuple.elements || []
  if (elements.length <= OPTION_VALUE_INDEX) return `PARAM "${param.name}" HAS NO VALUE SLOT`

  const valueText = formatNumber(param.value)
  if (valueText === null) return `PARAM "${param.name}" HAS NO NUMERIC VALUE`

  const valueNode = elements[OPTION_VALUE_INDEX]
  const valueLiteral = numericNodeInfo(valueNode)

  const isKnownKind =
    param.kind === PARAM_KIND_TONE_PARAM ||
    param.kind === PARAM_KIND_PROPERTY ||
    param.kind === PARAM_KIND_NUMBER

  // A parameter that is neither a literal number nor a known numeric kind is
  // not a knob (a string, a boolean, an unknown object...): leave the whole
  // tuple alone instead of touching any of its slots.
  if (!valueLiteral && !isKnownKind) return null

  // The init slot is applied by initTonesModifiers() after evaluation, so it
  // has to carry the knob value too, otherwise re-evaluating the sound would
  // reset the parameter to its previous value.
  const initLiteral = numericNodeInfo(elements[OPTION_INIT_INDEX])
  if (initLiteral) {
    accumulator.edits.push({ start: initLiteral.start, end: initLiteral.end, text: valueText })
  }

  // 1. a plain number literal in the code: replace it.
  if (valueLiteral) {
    accumulator.edits.push({ start: valueLiteral.start, end: valueLiteral.end, text: valueText })
    return null
  }

  // 2. the value comes from an expression (Tone.Param / property / numeric
  //    variable): the assignment producing it is rewritten.
  const target = resolveAssignmentTarget(code, valueNode, param.kind, param.name)
  if (!target) return `PARAM "${param.name}" IS DECLARED WITH AN UNSUPPORTED EXPRESSION`

  // For an object reference (Tone.Param / property container) the tuple keeps
  // the reference, so an assignment anywhere in the code changes the value
  // read from that object. For a number the tuple copies the value, so only
  // the assignments executed *before* it matter.
  const assignmentsBefore = target.isIdentifier
    ? accumulator.insertAt
    : undefined

  // only the precise assignment path is looked for: assigning the container
  // (`vol.volume = -6`) would replace the Param object instead of its value.
  const assignments = findAssignments(ast, code, [target.assignPath], assignmentsBefore)
  let writable = null

  each(assignments, assignment => {
    if (!assignment.right) return
    const literal = numericNodeInfo(assignment.right)
    if (!literal) return
    // the last assignment wins at runtime
    writable = literal
  })

  if (writable) {
    accumulator.edits.push({ start: writable.start, end: writable.end, text: valueText })
    return null
  }

  // the code of the sound sets no value: either the init slot carries it
  // already, or an assignment has to be added before the options declaration.
  if (initLiteral) return null

  if (target.isIdentifier) {
    const declaration = findVariableDeclaration(ast, target.basePath)
    if (!declaration) return `PARAM "${param.name}" IS NOT ASSIGNED IN THE CODE`
    if (declaration.kind === 'const') return `PARAM "${param.name}" IS A CONSTANT AND CANNOT BE UPDATED`

    // the assignment is inserted before the options tuple: a declaration
    // placed after it would reset the value (`x = 7; var x = 1`).
    if (!isDeclaredBefore(ast, target.basePath, accumulator.insertAt)) {
      return `PARAM "${param.name}" REFERS TO "${target.basePath}" WHICH IS DECLARED AFTER THE o.vars ARRAY`
    }
  } else {
    const root = findRootIdentifier(target.node)
    if (!root) return `PARAM "${param.name}" IS DECLARED WITH AN UNSUPPORTED EXPRESSION`
    if (!KNOWN_GLOBALS.includes(root)) {
      if (!hasIdentifierDeclared(ast, root)) {
        return `PARAM "${param.name}" REFERS TO "${root}" WHICH IS NOT DECLARED IN THE CODE`
      }

      // the assignment is inserted before the options tuple: a declaration
      // placed after it would reset the value (`x = 7; var x = 1`).
      if (!isDeclaredBefore(ast, root, accumulator.insertAt)) {
        return `PARAM "${param.name}" REFERS TO "${root}" WHICH IS DECLARED AFTER THE o.vars ARRAY`
      }
    }
  }

  accumulator.appends.push(`${target.assignPath} = ${valueText};`)
  return null
}

//
// Public API.
//
// `params` accepts:
//   - { name: value }
//   - { name: {name, value, kind} }
//   - [[name, value, kind], ...] / [{name, value, kind}, ...]
//
// Returns {status: 'ok', code, changed} or {status: 'err', body}.
// On error the original code is left untouched.
//
export const rewriteParamsInCode = (code, params) => {
  if (typeof code !== 'string' || !code.trim()) {
    return { status: 'err', body: 'CODE UPDATE ERROR => the sound has no code' }
  }

  const paramList = getParamList(params)
  if (!paramList.length) return { status: 'ok', code, changed: false }

  let ast
  try {
    ast = esprima.parseModule(code, { range: true })
  } catch (e) {
    return { status: 'err', body: `CODE PARSE ERROR => ${e.message}` }
  }

  const declaration = findOptionsDeclaration(ast)
  if (!declaration) {
    return {
      status: 'err',
      body: 'CODE UPDATE ERROR => the code should declare an o/options object with a vars array'
    }
  }

  const varsArray = declaration.varsArray
  // new assignments are inserted right before the options declaration, so
  // they run after everything they depend on but before the tuple captures
  // the values.
  const accumulator = { edits: [], appends: [], insertAt: declaration.statement.range[0] }
  let error = null

  each(paramList, param => {
    if (error) return
    error = planParam(code, ast, varsArray, param, accumulator)
  })

  if (error) return { status: 'err', body: `CODE UPDATE ERROR => ${error}` }

  const appends = accumulator.appends
    .filter((value, index, self) => self.indexOf(value) === index)
    .sort()

  const edits = accumulator.edits.slice()

  // New assignments have to run *before* the `o` object reads its values,
  // otherwise the tuple would still hold the old value. They are inserted
  // just before the options declaration, after everything they depend on has
  // been created. The insertion is an edit like the others, so it cannot be
  // shifted by the length changes of the other edits.
  if (appends.length) {
    edits.push({
      start: accumulator.insertAt,
      end: accumulator.insertAt,
      text: `${appends.join('\n')}\n`
    })
  }

  const newCode = applyEdits(code, edits)

  // never return a code that cannot be parsed anymore.
  try {
    esprima.parseModule(newCode, { range: true })
  } catch (e) {
    return { status: 'err', body: `CODE UPDATE ERROR => the generated code is invalid (${e.message})` }
  }

  return { status: 'ok', code: newCode, changed: newCode !== code }
}
