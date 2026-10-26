// Calls the OmniFocus tools through the real MCP server and checks what OmniFocus reports back.
// Default: read-only (list perspectives, tags and projects, and each supported perspective's tasks).
// --write: create a throwaway project, and in it create, update, complete and skip a throwaway repeating task, move it
// to the Inbox and back, and check a dropped throwaway project takes no task. Then delete every task and project with
// the throwaway names.
// A failed write step stops the ones after it, so nothing acts on a task the server returned wrongly.
// --parity: compare each supported perspective's tasks with what OmniFocus renders for it in a temporary tab.
type Item = Record<string, any>

const write = Bun.argv.includes('--write')
const parity = Bun.argv.includes('--parity')

const call = async (tool: string, args: object) => {
  const started = performance.now()
  const proc = Bun.spawn(
    ['bun', 'scripts/mcp-call.ts', tool, JSON.stringify(args)],
    { stdout: 'pipe', stderr: 'inherit' },
  )
  const reply = JSON.parse(await new Response(proc.stdout).text())
  const ms = Math.round(performance.now() - started)
  const result = reply.result
  if (!result || result.isError) {
    const text = result?.content?.[0]?.text
    return {
      ms,
      content: undefined,
      error: text ? (JSON.parse(text) as Item) : undefined,
      problem: JSON.stringify(text ?? reply.error),
    }
  }
  return {
    ms,
    content: result.structuredContent as Item,
    error: undefined,
    problem: undefined,
  }
}

let failures = 0
const report = (label: string, why: string | undefined, detail?: unknown) => {
  if (why) failures++
  console.log(`${why ? 'FAIL' : 'PASS'} ${label}${why ? `: ${why}` : ''}`)
  if (detail !== undefined) {
    console.log(`  ${JSON.stringify(detail).slice(0, 400)}`)
  }
}
// The content only if it passed.
const check = async (
  tool: string,
  args: object,
  expect: (content: Item) => string | undefined,
) => {
  const { ms, content, problem } = await call(tool, args)
  const why = problem ?? (content ? expect(content) : 'no result')
  report(`${tool} (${ms} ms)`, why, content)
  return why ? undefined : content
}
const step = async (...args: Parameters<typeof check>) => {
  const content = await check(...args)
  if (!content) {
    throw new Error(
      `${args[0]} failed, so the write steps after it were skipped`,
    )
  }
  return content
}

// Runs OmniJS in OmniFocus directly, outside the server, with `jxa` as the osascript program.
const omnijs = async (
  source: string,
  jxa = "function run(argv) { return Application('OmniFocus').evaluateJavascript(argv[0]) }",
  ...args: Array<string>
) => {
  const proc = Bun.spawn(
    ['/usr/bin/osascript', '-l', 'JavaScript', '-e', jxa, source, ...args],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (stderr.trim()) console.log(`  osascript: ${stderr.trim()}`)
  if (code !== 0) throw new Error(`osascript exited ${code}`)
  return JSON.parse(stdout) as unknown
}

const listed = await check('omnifocus_list_perspectives', {}, (c) =>
  Array.isArray(c.perspectives) &&
  c.perspectives.every(
    (p: Item) => typeof p.name === 'string' && typeof p.supported === 'boolean',
  )
    ? undefined
    : 'perspectives missing name or supported',
)
const supported: Array<Item> = (listed?.perspectives ?? []).filter(
  (p: Item) => p.supported,
)
for (const p of listed?.perspectives ?? []) {
  if (!p.supported)
    console.log(`  unsupported: ${p.name}: ${p.unsupportedReason}`)
}

await check('omnifocus_list_tags', {}, (c) =>
  Array.isArray(c.tags) && c.tags.every((t: Item) => typeof t.path === 'string')
    ? undefined
    : 'tags missing path',
)

await check('omnifocus_list_projects', {}, (c) =>
  Array.isArray(c.projects) &&
  c.projects.every((p: Item) => typeof p.path === 'string')
    ? undefined
    : 'projects missing path',
)

const shown = new Map<string, ReadonlyArray<Item>>()
for (const p of supported) {
  const content = await check(
    'omnifocus_perspective_tasks',
    { perspective: p.name },
    (c) => (Array.isArray(c.tasks) ? undefined : 'no task list'),
  )
  shown.set(p.id, content?.tasks ?? [])
  console.log(
    `  ${p.name}: ${(content?.tasks ?? []).map((t: Item) => `${t.name} [${t.status}]`).join('; ')}`,
  )
}

if (write) {
  const name = `swiss-mcp verify (safe to delete) ${new Date().toISOString().slice(0, 19)}`
  // Top-level, so a project's path is its name.
  const project = `${name} project`
  const dropped = `${name} dropped project`
  const pad = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const later = (a: unknown, b: unknown) =>
    typeof a === 'string' && typeof b === 'string' && a > b
  try {
    await omnijs(
      `((active, dropped) => {
  new Project(active)
  new Project(dropped).status = Project.Status.Dropped
  return JSON.stringify(null)
})(${JSON.stringify(project)}, ${JSON.stringify(dropped)})`,
    )
    await step('omnifocus_list_projects', {}, ({ projects }) => {
      const status = (path: string) =>
        projects?.find((p: Item) => p.path === path)?.status
      return status(project) !== 'Active' || status(dropped) !== 'Dropped'
        ? `the throwaway projects are listed as ${status(project)} and ${status(dropped)}`
        : undefined
    })

    const created = await step(
      'omnifocus_create_task',
      {
        name,
        project,
        deferDate: today,
        repeat: {
          rule: 'FREQ=DAILY',
          schedule: 'regularly',
          anchor: 'deferDate',
        },
      },
      ({ task }) =>
        task?.name !== name
          ? 'created with another name'
          : task.project !== project
            ? `created in ${task.project}, not the throwaway project`
            : !String(task.deferDate).startsWith(`${today} `)
              ? `deferDate ${task.deferDate} is not on ${today} at the default start time`
              : task.repeat?.rule !== 'FREQ=DAILY' ||
                  task.repeat?.anchor !== 'deferDate'
                ? `repeat is ${JSON.stringify(task.repeat)}`
                : undefined,
    )
    const id = created.task.id
    const seen = created.task.deferDate

    await step(
      'omnifocus_update_task',
      { id, note: 'updated by verify-omnifocus', repeat: { catchUp: true } },
      ({ task }) =>
        task?.note !== 'updated by verify-omnifocus'
          ? 'note not updated'
          : JSON.stringify(task.repeat) !==
              JSON.stringify({
                rule: 'FREQ=DAILY',
                schedule: 'regularly',
                anchor: 'deferDate',
                catchUp: true,
              })
            ? `repeat is ${JSON.stringify(task.repeat)}, not the old rule with catchUp`
            : task.deferDate !== seen
              ? 'deferDate changed'
              : undefined,
    )

    const completed = await step(
      'omnifocus_complete_task',
      { id, deferDate: seen },
      ({ completed, next }) =>
        completed?.status !== 'Completed'
          ? `completed is ${JSON.stringify(completed)}`
          : completed.id === id
            ? 'completed the repeating task itself, not an occurrence'
            : next?.id !== id || !later(next.deferDate, seen)
              ? `next is ${JSON.stringify(next)}`
              : undefined,
    )
    const nextSeen = completed.next.deferDate

    const stale = await call('omnifocus_complete_task', { id, deferDate: seen })
    const staleWhy =
      stale.error?.error === 'OmniFocusOccurrenceMoved'
        ? undefined
        : `expected OmniFocusOccurrenceMoved, got ${JSON.stringify(stale.error ?? stale.content)}`
    report(
      `omnifocus_complete_task again with the stale deferDate (${stale.ms} ms)`,
      staleWhy,
      stale.error,
    )
    if (staleWhy)
      throw new Error(
        'the stale complete was not refused, so the write steps after it were skipped',
      )

    await step(
      'omnifocus_complete_task',
      { id, deferDate: nextSeen, skip: true },
      ({ next }) =>
        next?.id !== id || !later(next.deferDate, nextSeen)
          ? `next is ${JSON.stringify(next)}`
          : undefined,
    )

    await step(
      'omnifocus_update_task',
      { id, clear: ['repeat', 'deferDate'] },
      ({ task }) =>
        task?.repeat !== null || task?.deferDate !== null
          ? `repeat ${JSON.stringify(task?.repeat)}, deferDate ${task?.deferDate} after clearing both`
          : task.note !== 'updated by verify-omnifocus'
            ? 'clearing changed the note'
            : undefined,
    )

    await step(
      'omnifocus_update_task',
      { id, clear: ['project'] },
      ({ task }) =>
        task?.project !== null
          ? `project is ${task?.project} after clearing it`
          : undefined,
    )
    await step('omnifocus_update_task', { id, project }, ({ task }) =>
      task?.project !== project
        ? `project is ${task?.project}, not the throwaway project`
        : undefined,
    )

    const closed = await call('omnifocus_create_task', {
      name,
      project: dropped,
    })
    report(
      `omnifocus_create_task in a dropped project (${closed.ms} ms)`,
      closed.error?.error === 'OmniFocusProjectClosed'
        ? undefined
        : `expected OmniFocusProjectClosed, got ${JSON.stringify(closed.error ?? closed.content)}`,
      closed.error,
    )
  } catch (e) {
    report('write checks', (e as Error).message)
  } finally {
    const cleanup = await omnijs(
      `((name, projects) => {
  const tasks = () => flattenedTasks.filter((t) => t.name === name)
  const mine = () => flattenedProjects.filter((p) => projects.includes(p.name))
  const deleted = { tasks: tasks().length, projects: mine().length }
  tasks().forEach((t) => deleteObject(t))
  mine().forEach((p) => deleteObject(p))
  return JSON.stringify({ deleted, left: { tasks: tasks().length, projects: mine().length } })
})(${JSON.stringify(name)}, ${JSON.stringify([project, dropped])})`,
    ).catch((e: Error) => ({ error: e.message }))
    const left = (cleanup as Item).left
    report(
      'cleanup',
      left?.tasks === 0 && left?.projects === 0
        ? undefined
        : 'tasks or projects left behind',
      cleanup,
    )
  }
}

if (parity && supported.length > 0) {
  // JXA window ids move between tabs when a tab opens, and OmniJS tab.close() leaves the tab open. So the temporary
  // tab ends on a perspective none of the user's windows was showing, and JXA closes the one window showing it.
  const candidates = (listed?.perspectives ?? []).map((p: Item) => p.name)
  const jxa = `function run(argv) {
  const of = Application('OmniFocus')
  const shown = of.windows().map((w) => { try { return w.perspectiveName() } catch (e) { return null } })
  const marker = JSON.parse(argv[1]).find((name) => !shown.includes(name))
  if (marker === undefined) throw new Error('every custom perspective is open in a window, so the temporary tab could not be told apart')
  try {
    return of.evaluateJavascript(argv[0].replace('__MARKER__', () => JSON.stringify(marker)))
  } finally {
    delay(0.3)
    const mine = of.windows().filter((w) => { try { return w.perspectiveName() === marker } catch (e) { return false } })
    if (mine.length === 1) mine[0].close()
    console.log(mine.length === 1 ? 'closed the temporary tab' : 'left ' + mine.length + ' window(s) showing ' + marker + ' open; close the temporary tab by hand')
  }
}`
  const source = `(async (ids, marker) => {
  const tab = await document.newTabOnWindow(document.windows[0])
  const rendered = {}
  try {
    for (const id of ids) {
      tab.perspective = Perspective.Custom.byIdentifier(id)
      const seen = []
      tab.content.rootNode.apply((node) => {
        if (node.object instanceof Task) seen.push(node.object.id.primaryKey)
      })
      rendered[id] = seen
    }
  } finally {
    tab.perspective = Perspective.Custom.byName(marker)
  }
  return JSON.stringify(rendered)
})(${JSON.stringify(supported.map((p) => p.id))}, __MARKER__)`
  try {
    const rendered = (await omnijs(
      source,
      jxa,
      JSON.stringify(candidates),
    )) as Record<string, ReadonlyArray<string>>
    for (const p of supported) {
      const ours = shown.get(p.id) ?? []
      const theirs = new Set(rendered[p.id] ?? [])
      const onlyOurs = ours.filter((t) => !theirs.has(t.id))
      const onlyTheirs = [...theirs].filter(
        (id) => !ours.some((t) => t.id === id),
      )
      report(
        `parity ${p.name} (ours ${ours.length}, OmniFocus ${theirs.size})`,
        onlyOurs.length + onlyTheirs.length === 0
          ? undefined
          : `only ours: ${onlyOurs.map((t) => t.name).join('; ') || 'none'}; only OmniFocus: ${onlyTheirs.join(', ') || 'none'}`,
      )
    }
  } catch (e) {
    report('parity', (e as Error).message)
  }
}

console.log(
  failures === 0 ? 'all checks passed' : `${failures} check(s) failed`,
)
process.exit(failures === 0 ? 0 : 1)
