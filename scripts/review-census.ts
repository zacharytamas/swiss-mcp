// Census of PR review findings: which code each one lands on. Usage: bun scripts/review-census.ts [pr]
// Reads the PR's top-level review comments with `gh` and groups them by file and by the boundary they touch.
const pr = Bun.argv[2] ?? '1'
const repo = (
  await Bun.$`gh repo view --json nameWithOwner -q .nameWithOwner`.text()
).trim()
const comments: Array<{
  path: string
  body: string
  in_reply_to_id?: number
  created_at: string
}> = await Bun.$`gh api repos/${repo}/pulls/${pr}/comments --paginate`.json()

const findings = comments
  .filter((c) => c.in_reply_to_id === undefined)
  .map((c) => ({
    when: c.created_at.slice(11, 16),
    path: c.path,
    title:
      /<\/sub><\/sub>\s+(.+?)\*\*/.exec(c.body)?.[1]?.trim() ??
      c.body.slice(0, 60),
  }))

// Each finding is about one of the ways the tool's input gets turned into something Due runs.
const boundaries: ReadonlyArray<[string, RegExp]> = [
  ['date/time conversion', /date|time|timestamp|second|calendar|minute/i],
  [
    'finding reminders by title',
    /title|non-ascii|reminder.*(match|list)|list/i,
  ],
  ['GUI automation', /click|import|window|replace/i],
  ['tool metadata', /destructive|annotation|hint/i],
]
const boundaryOf = (title: string) =>
  boundaries.find(([, re]) => re.test(title))?.[0] ?? 'other'

for (const f of findings)
  console.log(
    `${f.when}  ${boundaryOf(f.title).padEnd(28)} ${f.path.padEnd(32)} ${f.title}`,
  )
console.log()
const counts = Object.groupBy(findings, (f) => boundaryOf(f.title))
for (const [boundary, list] of Object.entries(counts))
  console.log(`${String(list?.length).padStart(2)}  ${boundary}`)
