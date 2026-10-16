// Run after importing dist/swiss-due.shortcut: exercises each Due op through the real MCP server.
// Read-only ops always run; pass --write to also create, reschedule and complete a throwaway reminder.
const write = Bun.argv.includes('--write')
const title = `swiss-mcp check ${new Date().toISOString().slice(0, 16)}`
const inAnHour = new Date(Date.now() + 3_600_000)
const inTwoHours = new Date(Date.now() + 7_200_000)
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

const steps: Array<[string, object]> = [
  ['due_list_reminders', {}],
  ['due_list_timers', {}],
  ...(write
    ? ([
        ['due_create_reminder', { title, dueDate: iso(inAnHour) }],
        ['due_reschedule_reminder', { title, dueDate: iso(inTwoHours) }],
        ['due_complete_reminder', { title }],
      ] as Array<[string, object]>)
    : []),
]

for (const [tool, args] of steps) {
  const started = performance.now()
  const proc = Bun.spawn(
    ['bun', 'scripts/mcp-call.ts', tool, JSON.stringify(args)],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const out = await new Response(proc.stdout).text()
  const ms = Math.round(performance.now() - started)
  const reply = JSON.parse(out)
  const result = reply.result
  const ok = result && !result.isError
  const body =
    result?.structuredContent ?? result?.content?.[0]?.text ?? reply.error
  console.log(`${ok ? 'PASS' : 'FAIL'} ${tool} (${ms} ms)`)
  console.log(`  ${JSON.stringify(body).slice(0, 400)}`)
}
