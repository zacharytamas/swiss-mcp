import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestOnce } from '../scripts/mcp-client.ts'

const REMINDERS = [{ title: 'Pay rent', dueDate: '2026-11-01T09:00:00-07:00' }]
let dir = ''

// A stand-in for /usr/bin/shortcuts: `list` shows swiss-due; `run` echoes the JSON it was given to $dir/last-input.json
// and replies with whatever is in $dir/reply.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'swiss-fake-cli-'))
  await Bun.write(
    join(dir, 'shortcuts'),
    `#!/bin/sh
if [ "$1" = list ]; then echo "swiss-due (46CFA397-9F0C-4CE9-92B1-3C92D17C8EB3)"; exit 0; fi
cp "$4" "${dir}/last-input.json"
cat "${dir}/reply"
`,
  )
  await chmod(join(dir, 'shortcuts'), 0o755)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

// Starts src/main.ts against the fake CLI and returns its reply to one request.
const request = async (
  protocolVersion: string,
  method: string,
  params: object,
  reply = '[]',
) => {
  await Bun.write(join(dir, 'reply'), reply)
  return requestOnce(method, params, {
    protocolVersion,
    env: {
      ...process.env,
      SWISS_SHORTCUTS_BIN: join(dir, 'shortcuts'),
      TZ: 'America/New_York',
    },
  })
}

const callTool = (
  protocolVersion: string,
  name: string,
  args: object,
  reply: string,
) => request(protocolVersion, 'tools/call', { name, arguments: args }, reply)

describe.each(['2025-06-18', '2025-11-25'])(
  'Due tools over MCP %s',
  (version) => {
    test('a successful call returns the list under a key in structuredContent', async () => {
      const reply = await callTool(
        version,
        'due_list_reminders',
        {},
        JSON.stringify(REMINDERS),
      )

      expect(reply.result).toEqual({
        content: [
          { type: 'text', text: JSON.stringify({ reminders: REMINDERS }) },
        ],
        structuredContent: { reminders: REMINDERS },
        isError: false,
      })
    })

    test('a mutation passes the local wall-clock date straight to the swiss-due shortcut', async () => {
      await callTool(
        version,
        'due_reschedule_reminder',
        { title: 'Pay rent', dueDate: '2026-11-02 09:30' },
        '[{"title":"Pay rent"}]',
      )

      expect(await Bun.file(join(dir, 'last-input.json')).json()).toEqual({
        op: 'reminders.reschedule',
        title: 'Pay rent',
        dueDate: '2026-11-02 09:30',
      })
    })

    test('a reply in the wrong shape is a tool error naming ShortcutOutputInvalid', async () => {
      const reply = await callTool(
        version,
        'due_stop_timer',
        { name: 'Laundry' },
        'not json {',
      )

      expect(reply.result.isError).toBe(true)
      expect(JSON.parse(reply.result.content[0].text).error).toBe(
        'ShortcutOutputInvalid',
      )
    })

    test.each([
      ['due_complete_reminder', { title: 'Nope' }, false],
      [
        'due_reschedule_reminder',
        { title: 'Nope', dueDate: '2026-11-02 09:30' },
        false,
      ],
      [
        'due_create_reminder',
        { title: 'New', dueDate: '2026-11-02 09:30' },
        true,
      ],
      ['due_start_timer', { name: 'Task' }, true],
    ] as const)(
      'empty shortcut output from %s is an error only where Due always answers',
      async (tool, args, isError) => {
        const reply = await callTool(version, tool, args, '')

        expect(reply.result.isError).toBe(isError)
      },
    )

    test.each([
      ['2026-02-30 09:00', 'does not exist'],
      ['2027-02-29 09:00', 'does not exist'],
      ['2026-11-02 24:00', 'does not exist'],
      ['2026-11-02T14:30:00Z', 'YYYY-MM-DD HH:mm'],
      ['2026-11-02 09:30:45', 'YYYY-MM-DD HH:mm'],
    ])('rejects %s before the shortcut runs', async (dueDate, expected) => {
      await Bun.write(join(dir, 'last-input.json'), 'untouched')

      const reply = await callTool(
        version,
        'due_create_reminder',
        { title: 'Pay rent', dueDate },
        '[]',
      )

      // 2025-06-18 answers invalid arguments with JSON-RPC -32602; 2025-11-25 returns them as a tool error.
      const message: string =
        reply.error?.message ?? reply.result?.content?.[0]?.text ?? ''
      expect(message).toContain(expected)
      expect(await Bun.file(join(dir, 'last-input.json')).text()).toBe(
        'untouched',
      )
    })

    test('tools/list tells clients the local YYYY-MM-DD HH:mm date format', async () => {
      const reply = await request(version, 'tools/list', {})
      const tools: Array<{
        name: string
        inputSchema: { properties?: Record<string, { description?: string }> }
      }> = reply.result.tools

      expect(
        tools
          .filter((t) => t.inputSchema.properties?.dueDate)
          .map((t) => [
            t.name,
            t.inputSchema.properties?.dueDate?.description?.includes(
              'YYYY-MM-DD HH:mm',
            ),
          ]),
      ).toEqual([
        ['due_create_reminder', true],
        ['due_reschedule_reminder', true],
      ])
    })

    test('accepts a leap day', async () => {
      const reply = await callTool(
        version,
        'due_create_reminder',
        { title: 'Leap', dueDate: '2028-02-29 09:00' },
        '[{"title":"Leap","dueDate":"2028-02-29T09:00:00-05:00"}]',
      )

      expect(reply.result.isError).toBe(false)
    })
  },
)
