const derived =
  /^(?:(?:de|en)code(?:Unknown)?(?:Effect|Exit|Option|Promise|Result|Sync)|is(?:[A-Z]\w*)?|asserts|makeFilter(?:Group)?|makeIs\w*|resolveAnnotations(?:Key)?|to(?:JsonSchemaDocument|Equivalence|Formatter|Iso(?:Focus|Source)?|Representation|DifferJsonPatch|EncoderXml))$/

const wrappers = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
])

// The member access applied directly to the chain's root identifier, e.g. `Schema.Struct` in `Schema.Struct({}).pipe(f)`.
const rootMember = (node) => {
  let member
  while (node) {
    if (wrappers.has(node.type)) node = node.expression
    else if (node.type === 'CallExpression') node = node.callee
    else if (node.type === 'MemberExpression') {
      member = node
      node = node.object
    } else break
  }
  return node?.type === 'Identifier' && member?.object === node
    ? { root: node.name, name: member.computed ? null : member.property.name }
    : undefined
}

const isSchema = (node) => {
  const m = rootMember(node)
  return m?.root === 'Schema' && m.name !== null && !derived.test(m.name)
}

const functionName = (fn) =>
  fn.type === 'FunctionDeclaration'
    ? fn.id
    : fn.parent.type === 'VariableDeclarator'
      ? fn.parent.id
      : undefined

const schemaLocation = {
  create(context) {
    if (/(?:-schema|\.test)\.ts$/.test(context.filename)) return {}
    const reported = new Set()
    const report = (id) => {
      if (!id || reported.has(id)) return
      reported.add(id)
      context.report({
        node: id,
        message:
          'Define named Schemas in a sibling *-schema.ts file (e.g. due.ts -> due-schema.ts) and import them. See AGENTS.md.',
      })
    }
    return {
      VariableDeclarator(node) {
        if (isSchema(node.init)) report(node.id)
      },
      ArrowFunctionExpression(node) {
        if (node.expression && isSchema(node.body)) report(functionName(node))
      },
      ReturnStatement(node) {
        if (!isSchema(node.argument)) return
        const fn = context.sourceCode
          .getAncestors(node)
          .findLast((a) => a.type.includes('Function'))
        if (fn) report(functionName(fn))
      },
    }
  },
}

const errorLocation = {
  create(context) {
    if (/(?:-errors|\.test)\.ts$/.test(context.filename)) return {}
    return {
      ClassDeclaration(node) {
        const base = node.superClass
        const m = rootMember(base)
        const isError =
          (base?.type === 'Identifier' && base.name === 'Error') ||
          ((m?.root === 'Schema' || m?.root === 'Data') &&
            (m.name === 'TaggedError' || m.name === 'Error'))
        if (isError && node.id)
          context.report({
            node: node.id,
            message:
              'Define error classes in a sibling *-errors.ts file (e.g. shortcuts.ts -> shortcuts-errors.ts) and import them. See AGENTS.md.',
          })
      },
    }
  },
}

export default {
  meta: { name: 'location' },
  rules: { 'schema-location': schemaLocation, 'error-location': errorLocation },
}
