import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { requestOnce } from '../scripts/mcp-client.ts'
import { paceTarget } from './ynab.ts'

const BUDGET = '11111111-2222-3333-4444-555555555555'
describe('paceTarget', () => {
  test.each([
    ['2026-10-03', 15, '2026-10-15'],
    ['2026-10-14', 15, '2026-10-15'],
    ['2026-10-15', 15, '2026-11-15'],
    ['2026-10-24', 15, '2026-11-15'],
    ['2026-12-20', 15, '2027-01-15'],
    ['2026-01-31', 31, '2026-02-28'],
    ['2026-02-10', 31, '2026-02-28'],
    ['2026-02-28', 31, '2026-03-31'],
    ['2026-03-31', 1, '2026-04-01'],
  ])('from %s with day %d is %s', (today, day, expected) => {
    expect(paceTarget(Temporal.PlainDate.from(today), day).toString()).toBe(
      expected,
    )
  })
})

let server: Bun.Server<undefined>
let toBeBudgeted = 0
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url)
      if (req.headers.get('authorization') !== 'Bearer ynab-test') {
        return Response.json(
          {
            error: {
              id: '401',
              name: 'unauthorized',
              detail: 'Unauthorized',
            },
          },
          { status: 401 },
        )
      }
      if (pathname !== `/plans/${BUDGET}/months/current`) {
        return Response.json(
          {
            error: {
              id: '404.2',
              name: 'resource_not_found',
              detail: 'Resource not found',
            },
          },
          { status: 404 },
        )
      }
      return Response.json({
        data: {
          month: {
            month: '2026-10-01',
            income: 0,
            budgeted: 0,
            activity: 0,
            to_be_budgeted: toBeBudgeted,
            deleted: false,
            categories: [],
          },
        },
      })
    },
  })
})
afterAll(() => server.stop(true))

const callPace = async (env: Record<string, string>) => {
  // bun test loads the repo's .env; drop every YNAB variable so a real token never reaches the server under test.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('YNAB_')),
  )
  const reply = await requestOnce(
    'tools/call',
    { name: 'ynab_daily_pace', arguments: {} },
    {
      env: {
        ...base,
        SWISS_YNAB_API_URL: server.url.href.replace(/\/$/, ''),
        ...env,
      },
    },
  )
  return reply.result
}

const configured = { YNAB_ACCESS_TOKEN: 'ynab-test', YNAB_BUDGET_ID: BUDGET }
describe('ynab_daily_pace', () => {
  // Pacing to tomorrow's day of the month always makes days 1, so expected values can be literal.
  const tomorrow = Temporal.Now.plainDateISO().add({ days: 1 })
  const toTomorrow = { ...configured, YNAB_PACE_DAY: String(tomorrow.day) }

  test.each([
    [290, 0.29, 0.29],
    [1000019, 1000.01, 1000.019],
    [-300000, -300, -300],
  ])(
    '%d milliunits over one day paces at %d',
    async (milliunits, dailyPace, readyToAssign) => {
      toBeBudgeted = milliunits

      const result = await callPace(toTomorrow)

      expect(result.isError).toBe(false)
      expect(result.structuredContent).toEqual({
        dailyPace,
        days: 1,
        targetDate: tomorrow.toString(),
        readyToAssign,
        budgetId: BUDGET,
      })
    },
  )

  test('rounds a share of a cent down, toward negative', async () => {
    toBeBudgeted = -10

    const result = await callPace(toTomorrow)

    expect(result.structuredContent.dailyPace).toBe(-0.01)
  })

  test.each([
    [{ YNAB_BUDGET_ID: BUDGET }, 'YNAB_ACCESS_TOKEN'],
    [{ YNAB_ACCESS_TOKEN: 'ynab-test' }, 'YNAB_BUDGET_ID'],
    [{ ...configured, YNAB_PACE_DAY: '32' }, 'YNAB_PACE_DAY'],
    [{ ...configured, YNAB_PACE_DAY: '15th' }, 'YNAB_PACE_DAY'],
  ])('reports missing or invalid configuration %#', async (env, variable) => {
    const result = await callPace(env)

    expect(result.isError).toBe(true)
    const { error, message } = JSON.parse(result.content[0].text)
    expect({ error, names: message.includes(variable) }).toEqual({
      error: 'YnabNotConfigured',
      names: true,
    })
  })

  test("passes YNAB's error name through", async () => {
    const result = await callPace({ ...configured, YNAB_BUDGET_ID: 'nope' })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'YnabApiError:resource_not_found',
      message: 'Resource not found',
    })
  })
})
