const wrappers = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
])

const isEffect = (node, name) =>
  node?.type === 'MemberExpression' &&
  node.object.type === 'Identifier' &&
  node.object.name === 'Effect' &&
  !node.computed &&
  (name === undefined || node.property.name === name)

// `Effect.gen(...)`, `Effect.gen(...).pipe(...)` or `Effect.scoped(Effect.gen(...))`.
const isGen = (node) => {
  if (node?.type !== 'CallExpression') return false
  if (isEffect(node.callee, 'gen')) return true
  if (node.callee.type === 'MemberExpression' && !isEffect(node.callee))
    return isGen(node.callee.object)
  return isEffect(node.callee) && isGen(node.arguments[0])
}

const noGenWrapper = {
  create(context) {
    return {
      ArrowFunctionExpression(node) {
        if (!node.expression || !isGen(node.body)) return
        let bound = node
        while (wrappers.has(bound.parent.type)) bound = bound.parent
        if (bound.parent.type !== 'VariableDeclarator') return
        context.report({
          node: bound.parent.id,
          message:
            "Write a function that returns Effect.gen as Effect.fn('Name')(function* (...) {...}). See node_modules/effect/AGENTS.md.",
        })
      },
    }
  },
}

export default {
  meta: { name: 'effect' },
  rules: { 'no-gen-wrapper': noGenWrapper },
}
