// Run after importing dist/swiss-due.shortcut. Calls the Due tools through the real MCP server and checks what Due reports back.
// Default: read-only (list reminders). --write: create, reschedule and complete a throwaway reminder.
// --timer <name>: also start, pause and stop that existing timer.
type Item = Record<string, unknown>

const write = Bun.argv.includes('--write')
const timerFlag = Bun.argv.indexOf('--timer')
const timer = timerFlag >= 0 ? Bun.argv[timerFlag + 1] : undefined

const title = `swiss-mcp check ${new Date().toISOString().slice(0, 16)}`
const pad = (n: number) => String(n).padStart(2, '0')
// Local wall-clock minutes from now, in the format the tools take.
const inMinutes = (minutes: number) => {
  const d = new Date(Date.now() + minutes * 60_000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
// Due reports dates back as ISO with an offset; the local date and minute are its first 16 characters.
const sameMinute = (reported: unknown, local: string) =>
  typeof reported === 'string' &&
  reported.slice(0, 16) === local.replace(' ', 'T')

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
    return {
      ms,
      items: undefined,
      problem: JSON.stringify(result?.content?.[0]?.text ?? reply.error),
    }
  }
  const content = result.structuredContent ?? {}
  return {
    ms,
    items: (content.reminders ?? content.timers) as ReadonlyArray<Item>,
    problem: undefined,
  }
}

let failures = 0
const check = async (
  tool: string,
  args: object,
  expect: (items: ReadonlyArray<Item>) => string | undefined,
) => {
  const { ms, items, problem } = await call(tool, args)
  const why = problem ?? (items ? expect(items) : 'no result')
  if (why) failures++
  console.log(
    `${why ? 'FAIL' : 'PASS'} ${tool} (${ms} ms)${why ? `: ${why}` : ''}`,
  )
  if (items) console.log(`  ${JSON.stringify(items).slice(0, 400)}`)
  return items
}

const one = (key: string, value: string) => (items: ReadonlyArray<Item>) =>
  items.length === 1 && items[0]?.[key] === value
    ? undefined
    : `expected exactly one item with ${key} "${value}"`

await check('due_list_reminders', {}, (items) =>
  items.every(
    (i) => typeof i.title === 'string' && typeof i.dueDate === 'string',
  )
    ? undefined
    : 'items missing title or dueDate',
)

if (write) {
  const created = inMinutes(60)
  const moved = inMinutes(120)
  await check(
    'due_create_reminder',
    { title, dueDate: created },
    (items) =>
      one('title', title)(items) ??
      (sameMinute(items[0]?.dueDate, created)
        ? undefined
        : `created with dueDate ${String(items[0]?.dueDate)}, not ${created}`),
  )
  await check('due_list_reminders', {}, (items) => {
    const found = items.find((i) => i.title === title)
    if (!found) return 'created reminder not listed'
    return sameMinute(found.dueDate, created)
      ? undefined
      : `listed with dueDate ${String(found.dueDate)}, not ${created}`
  })
  await check(
    'due_reschedule_reminder',
    { title, dueDate: moved },
    one('title', title),
  )
  await check('due_list_reminders', {}, (items) => {
    const found = items.find((i) => i.title === title)
    if (!found) return 'rescheduled reminder not listed'
    return sameMinute(found.dueDate, moved)
      ? undefined
      : `still due ${String(found.dueDate)}, not ${moved}`
  })
  await check('due_complete_reminder', { title }, one('title', title))
  await check('due_list_reminders', {}, (items) =>
    items.some((i) => i.title === title)
      ? 'completed reminder still listed'
      : undefined,
  )
  await check(
    'due_complete_reminder',
    { title: `${title} (no such reminder)` },
    (items) =>
      items.length === 0 ? undefined : 'unmatched title returned items',
  )
}

if (timer) {
  for (const tool of ['due_start_timer', 'due_pause_timer', 'due_stop_timer']) {
    await check(tool, { name: timer }, one('name', timer))
  }
}

console.log(
  failures === 0 ? 'all checks passed' : `${failures} check(s) failed`,
)
process.exit(failures === 0 ? 0 : 1)
