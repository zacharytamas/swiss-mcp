import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const callTool = async (
  protocolVersion: string,
  name: string,
  args: object,
  reply: string,
) => {
  await Bun.write(join(dir, 'reply'), reply)
  const server = Bun.spawn(['bun', 'src/main.ts'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: {
      ...process.env,
      SWISS_SHORTCUTS_BIN: join(dir, 'shortcuts'),
      TZ: 'America/New_York',
    },
  })
  for (const message of [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  ]) {
    server.stdin.write(`${JSON.stringify(message)}\n`)
  }
  let buffered = ''
  for await (const chunk of server.stdout.pipeThrough(
    new TextDecoderStream(),
  )) {
    buffered += chunk
    const found = buffered
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2)
    if (found) {
      server.kill()
      return found
    }
  }
  throw new Error('server exited without answering tools/call')
}

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

    test('a mutation sends the op, and the date as local wall-clock time, to the swiss-due shortcut', async () => {
      await callTool(
        version,
        'due_reschedule_reminder',
        { title: 'Pay rent', dueDate: '2026-11-02T14:30:00Z' },
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
        { title: 'Nope', dueDate: '2026-11-02T14:30:00Z' },
        false,
      ],
      [
        'due_create_reminder',
        { title: 'New', dueDate: '2026-11-02T14:30:00Z' },
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

    test('rejects a date that does not exist instead of rolling it into the next month', async () => {
      await Bun.write(join(dir, 'last-input.json'), 'untouched')

      const reply = await callTool(
        version,
        'due_create_reminder',
        { title: 'Pay rent', dueDate: '2026-02-30T09:00Z' },
        '[]',
      )

      // 2025-06-18 answers invalid arguments with JSON-RPC -32602; 2025-11-25 returns them as a tool error.
      const message: string =
        reply.error?.message ?? reply.result?.content?.[0]?.text ?? ''
      expect(message).toContain('2026-02-30 09:00 does not exist')
      expect(await Bun.file(join(dir, 'last-input.json')).text()).toBe(
        'untouched',
      )
    })

    test('accepts an ISO date with fractional seconds, as Date.toISOString() writes it', async () => {
      const reply = await callTool(
        version,
        'due_create_reminder',
        { title: 'Pay rent', dueDate: '2026-11-02T14:30:00.000Z' },
        '[{"title":"Pay rent","dueDate":"2026-11-02T09:30:00-05:00"}]',
      )

      expect(reply.result.isError).toBe(false)
      expect(
        (await Bun.file(join(dir, 'last-input.json')).json()).dueDate,
      ).toBe('2026-11-02 09:30')
    })
  },
)
