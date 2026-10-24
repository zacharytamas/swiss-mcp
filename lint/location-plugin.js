const derived =
  /^Schema\.(?:(?:de|en)code(?:Unknown)?(?:Effect|Exit|Option|Promise|Result|Sync)|is(?:[A-Z]\w*)?|asserts|makeFilter(?:Group)?|makeIs\w*|resolveAnnotations(?:Key)?|to(?:JsonSchemaDocument|Equivalence|Formatter|Iso(?:Focus|Source)?|Representation|DifferJsonPatch|EncoderXml))$/

const errorBases = new Set([
  'Error',
  'Schema.TaggedError',
  'Schema.Error',
  'Data.TaggedError',
  'Data.Error',
])

const wrappers = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
])

const functions = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

// `Schema.Struct` for `Schema.Struct({}).pipe(f)`, `Error` for `Error`.
const rootPath = (node) => {
  let member
  while (node) {
    if (node.type === 'CallExpression') node = node.callee
    else if (node.type === 'MemberExpression') {
      member = node
      node = node.object
    } else if (wrappers.has(node.type)) node = node.expression
    else break
  }
  if (node?.type !== 'Identifier') return undefined
  if (!member) return node.name
  return member.object === node && !member.computed
    ? `${node.name}.${member.property.name}`
    : undefined
}

const isSchema = (node) => {
  const path = rootPath(node)
  return path?.startsWith('Schema.') && !derived.test(path)
}

// The binding a function is assigned to, looking through `satisfies` and `as`.
const nameOf = (fn) => {
  let node = fn
  while (wrappers.has(node.parent.type)) node = node.parent
  return node.parent.type === 'VariableDeclarator' ? node.parent.id : fn.id
}

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
        if (node.expression && isSchema(node.body)) report(nameOf(node))
      },
      ReturnStatement(node) {
        if (!isSchema(node.argument)) return
        const fn = context.sourceCode
          .getAncestors(node)
          .findLast((a) => functions.has(a.type))
        if (fn) report(nameOf(fn))
      },
    }
  },
}

const errorLocation = {
  create(context) {
    if (/(?:-errors|\.test)\.ts$/.test(context.filename)) return {}
    return {
      'ClassDeclaration, ClassExpression'(node) {
        if (errorBases.has(rootPath(node.superClass)))
          context.report({
            node: node.id ?? node,
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
