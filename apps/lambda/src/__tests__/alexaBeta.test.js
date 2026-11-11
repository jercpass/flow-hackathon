'use strict'

// Self-serve Alexa beta (core/alexaBeta): a visitor's Amazon email is added to
// the skill's beta test through Amazon's API (mocked here); Flow keeps only a
// masked email and returns the invitation link.

const { setStore, memory, store } = require('../services/demoStore')
const beta = require('../core/alexaBeta')

const session = { sid: 'S1', status: 'active', expiresAt: Date.now() + 3600_000, customerId: 'C1' }
let calls, betaState

beforeEach(async () => {
  setStore(memory())
  await store().putSession({ ...session })
  beta._reset()
  process.env.ALEXA_SKILL_ID = 'amzn1.ask.skill.flow'
  process.env.ALEXA_LWA_REFRESH_TOKEN = 'Atzr|refresh'
  calls = []
  betaState = { status: 'RUNNING', invitesRemaining: 480, invitationUrl: 'https://alexa-skills.amazon.com/apis/custom/skills/amzn1.ask.skill.flow/beta-tests/invite' }
  jest.spyOn(global, 'fetch').mockImplementation(async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? String(opts.body) : '' })
    const json = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) })
    if (String(url).endsWith('/auth/o2/token')) return json(200, { access_token: 'Atza|access', expires_in: 3600 })
    if (String(url).endsWith('/betaTest')) return json(200, betaState)
    if (String(url).endsWith('/betaTest/testers/add')) return json(204, {})
    return json(404, { message: 'nope' })
  })
})
afterEach(() => { global.fetch.mockRestore(); delete process.env.ALEXA_LWA_REFRESH_TOKEN })

const sess = () => store().getSession('S1')

test('adds the Amazon email to the beta and returns the invitation link; Flow keeps it masked', async () => {
  const r = await beta.join(await sess(), ' Judge.One@Example.com ')
  expect(r).toEqual({ ok: true, email: 'j***@example.com', invitationUrl: betaState.invitationUrl })
  const add = calls.find(c => c.url.endsWith('/betaTest/testers/add'))
  expect(add).toMatchObject({ url: 'https://api.amazonalexa.com/v1/skills/amzn1.ask.skill.flow/betaTest/testers/add', method: 'POST' })
  expect(JSON.parse(add.body)).toEqual({ testers: [{ emailId: 'judge.one@example.com' }] })
  const view = await beta.view(await sess())
  expect(view).toEqual({ available: true, invitationUrl: betaState.invitationUrl, added: [{ email: 'j***@example.com', at: expect.any(Number), invitationUrl: betaState.invitationUrl }] })
  expect(JSON.stringify(await sess())).not.toContain('judge.one')
})

test('the same account again is not re-added; a different one with the same mask is', async () => {
  await beta.join(await sess(), 'jane@example.com')
  await beta.join(await sess(), 'JANE@example.com')
  expect(calls.filter(c => c.url.endsWith('/testers/add'))).toHaveLength(1)
  await beta.join(await sess(), 'john@example.com')
  expect(calls.filter(c => c.url.endsWith('/testers/add'))).toHaveLength(2)
})

test('one access token is reused while it lasts', async () => {
  await beta.join(await sess(), 'a@example.com')
  await beta.join(await sess(), 'b@example.com')
  expect(calls.filter(c => c.url.endsWith('/auth/o2/token'))).toHaveLength(1)
})

test('refuses a bad email, a fourth account per session, a closed or full beta, and when not set up', async () => {
  expect(await beta.join(await sess(), 'not-an-email')).toMatchObject({ error: 'bad_email' })
  for (const e of ['a@x.com', 'b@x.com', 'c@x.com']) await beta.join(await sess(), e)
  expect(await beta.join(await sess(), 'd@x.com')).toMatchObject({ error: 'limit' })
  await store().updateSession('S1', { alexaBeta: [] })
  betaState.status = 'ENDED'
  expect(await beta.join(await sess(), 'e@x.com')).toMatchObject({ error: 'not_available' })
  betaState = { ...betaState, status: 'RUNNING', invitesRemaining: 0 }
  expect(await beta.join(await sess(), 'e@x.com')).toMatchObject({ error: 'full' })
  delete process.env.ALEXA_LWA_REFRESH_TOKEN
  expect(await beta.view(await sess())).toMatchObject({ available: false, invitationUrl: null })
  expect(await beta.join(await sess(), 'e@x.com')).toMatchObject({ error: 'not_available' })
})

test('if Amazon refuses, the visitor gets a plain retry message', async () => {
  global.fetch.mockImplementation(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '{"message":"Unauthorized"}' }))
  expect(await beta.join(await sess(), 'a@example.com')).toMatchObject({ error: 'amazon', message: expect.stringMatching(/Try again/) })
})

test("the page always gets the skill's invitation link (asked of Amazon once, then kept)", async () => {
  expect(await beta.view(await sess())).toMatchObject({ available: true, invitationUrl: betaState.invitationUrl, added: [] })
  await beta.view(await sess())
  expect(calls.filter(c => c.url.endsWith('/betaTest'))).toHaveLength(1)
})
