'use strict'

// Alexa skill "Flow Bookings": a 4-digit code links
// the Alexa user to the demo session; after that Alexa's requests become Flow
// Voice requests (core/voice), and the replies Alexa responses. Voice is mocked.

jest.mock('../core/voice', () => ({ handle: jest.fn() }))
jest.mock('../core/concierge', () => ({ sessionContext: jest.fn(async () => ({ channel: 'speaker' })) }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn(async id => ({ businessId: id, name: 'Willow & Co. Salon' })) }))
jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn(async id => ({ customerId: id, name: 'Sam Rivera' })) }))

const { setStore, memory, store } = require('../services/demoStore')
const voice = require('../core/voice')
const alexa = require('../core/alexa')
const { handler } = require('../handlers/alexa')

const session = { sid: 'S1', status: 'active', expiresAt: Date.now() + 3600_000, customerId: 'C1', customerName: 'Sam Rivera', businessId: 'B1', businessIds: ['B1'] }
const req = (request, attributes = {}, extra = {}) => ({
  version: '1.0',
  session: { new: false, application: { applicationId: 'amzn1.ask.skill.flow' }, user: { userId: 'amzn1.ask.account.USER1' }, attributes },
  context: { System: { application: { applicationId: 'amzn1.ask.skill.flow' }, user: { userId: 'amzn1.ask.account.USER1' }, ...extra } },
  request: { requestId: 'r1', ...request }
})
const intent = (name, slots = {}) => ({ type: 'IntentRequest', intent: { name, slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v }])) } })
const speech = r => r.response.outputSpeech.text

beforeEach(async () => {
  jest.clearAllMocks()
  setStore(memory())
  await store().putSession({ ...session })
  delete process.env.ALEXA_SKILL_ID
  voice.handle.mockResolvedValue({ voice: { session: { attributes: { history: [{ role: 'user', content: 'x' }] } }, reply: { speech: 'Ana has 11 AM open on Monday. Shall I book it?', reprompt: 'Shall I book it?', card: { title: 'Flow', text: 'Ana, 11 AM' }, end: false } } })
})

async function linkedCode() {
  const { code } = await alexa.codeFor(await store().getSession('S1'))
  await handler(req(intent('LinkIntent', { code })))
  return code
}

test('each session gets one 4-digit code', async () => {
  const a = await alexa.codeFor(await store().getSession('S1'))
  expect(a).toMatchObject({ code: expect.stringMatching(/^\d{4}$/), linked: false, skill: 'Flow Bookings' })
  expect((await alexa.codeFor(await store().getSession('S1'))).code).toBe(a.code)
})

test('the customer side gets no code until the skill is set up', async () => {
  expect(await alexa.status(await store().getSession('S1'))).toEqual({ configured: false, skill: 'Flow Bookings' })
  expect((await store().getSession('S1')).alexaCode).toBeUndefined()
  process.env.ALEXA_SKILL_ID = 'amzn1.ask.skill.flow'
  expect(await alexa.status(await store().getSession('S1'))).toMatchObject({ configured: true, code: expect.stringMatching(/^\d{4}$/), linked: false })
})

test('not linked yet: Alexa asks for the code; a wrong code is refused, the right one links', async () => {
  expect(speech(await handler(req({ type: 'LaunchRequest' })))).toMatch(/say the four digit code/)
  expect(speech(await handler(req(intent('LinkIntent', { code: '0000' }))))).toMatch(/didn’t match/)
  const { code } = await alexa.codeFor(await store().getSession('S1'))
  const r = await handler(req(intent('LinkIntent', { code })))
  expect(speech(r)).toMatch(/^Linked! Hi Sam, you're booking as Sam Rivera/)
  expect((await store().getSession('S1')).alexa).toMatchObject({ linkedAt: expect.any(Number) })
  expect(voice.handle).not.toHaveBeenCalled()
})

test('linked: what the person says is a Flow Voice "say" turn, and the reply an Alexa response', async () => {
  await linkedCode()
  const r = await handler(req(intent('ChatIntent', { text: 'book me a haircut with Ana on Monday' }), { history: [] }))
  expect(voice.handle).toHaveBeenCalledWith(
    { version: 1, session: { new: false, attributes: { history: [] } }, request: { type: 'say', text: 'book me a haircut with Ana on Monday' } },
    expect.objectContaining({ business: expect.objectContaining({ businessId: 'B1' }), customer: expect.objectContaining({ customerId: 'C1' }) })
  )
  expect(r).toEqual({
    version: '1.0',
    sessionAttributes: { history: [{ role: 'user', content: 'x' }] },
    response: {
      outputSpeech: { type: 'PlainText', text: 'Ana has 11 AM open on Monday. Shall I book it?' },
      card: { type: 'Simple', title: 'Flow', content: 'Ana, 11 AM' },
      reprompt: { outputSpeech: { type: 'PlainText', text: 'Shall I book it?' } },
      shouldEndSession: false
    }
  })
})

test('yes, help, stop and launch map to the voice assistant; session end needs no speech', async () => {
  await linkedCode()
  await handler(req(intent('AMAZON.YesIntent')))
  expect(voice.handle.mock.calls[0][0].request).toEqual({ type: 'say', text: 'Yes.' })
  await handler(req(intent('AMAZON.HelpIntent')))
  expect(voice.handle.mock.calls[1][0].request).toEqual({ type: 'help' })
  await handler(req(intent('AMAZON.StopIntent')))
  expect(voice.handle.mock.calls[2][0].request).toEqual({ type: 'stop' })
  await handler(req({ type: 'LaunchRequest' }))
  expect(voice.handle.mock.calls[3][0].request).toEqual({ type: 'start' })
  expect(await handler(req({ type: 'SessionEndedRequest' }))).toEqual({ version: '1.0', response: {} })
})

test('while the AI works, Alexa says "One moment" (progressive response)', async () => {
  await linkedCode()
  const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true })
  try {
    await handler(req(intent('ChatIntent', { text: 'book me a haircut' }), {}, { apiEndpoint: 'https://api.amazonalexa.com', apiAccessToken: 'tok' }))
    expect(fetchSpy).toHaveBeenCalledWith('https://api.amazonalexa.com/v1/directives', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"speech":"One moment."') }))
  } finally { fetchSpy.mockRestore() }
})

test('with ALEXA_SKILL_ID set, another skill is refused', async () => {
  process.env.ALEXA_SKILL_ID = 'amzn1.ask.skill.other'
  const r = await handler(req({ type: 'LaunchRequest' }))
  expect(r.response.shouldEndSession).toBe(true)
  expect(speech(r)).toMatch(/isn’t set up for Flow/)
})

test('the keep-warm ping is answered without work', async () => {
  expect(await handler({ warm: true })).toEqual({ warm: true })
})

test('the customer side sees who Alexa is linked as; Unlink makes Alexa ask for the code again', async () => {
  process.env.ALEXA_SKILL_ID = 'amzn1.ask.skill.flow'
  const code = await linkedCode()
  expect(await alexa.status(await store().getSession('S1'))).toMatchObject({ configured: true, code, linked: { at: expect.any(Number), as: 'Sam Rivera' } })
  await alexa.unlink(await store().getSession('S1'))
  expect(await alexa.status(await store().getSession('S1'))).toMatchObject({ code, linked: false })
  expect(await alexa.sessionFor('amzn1.ask.account.USER1')).toBeNull()
  expect(speech(await handler(req({ type: 'LaunchRequest' })))).toMatch(/say the four digit code/)
  // The same code links again.
  expect(speech(await handler(req(intent('LinkIntent', { code }))))).toMatch(/^Linked!/)
})

test('"disconnect my account" unlinks by voice, like Unlink on the Alexa page', async () => {
  process.env.ALEXA_SKILL_ID = 'amzn1.ask.skill.flow'
  const code = await linkedCode()
  const r = await handler(req(intent('UnlinkIntent')))
  expect(speech(r)).toMatch(/^Disconnected/)
  expect(r.response.shouldEndSession).toBe(true)
  expect(voice.handle).not.toHaveBeenCalled()
  expect(await alexa.sessionFor('amzn1.ask.account.USER1')).toBeNull()
  expect(await alexa.status(await store().getSession('S1'))).toMatchObject({ code, linked: false })
  // Saying it again, unlinked: nothing to disconnect.
  expect(speech(await handler(req(intent('UnlinkIntent'))))).toMatch(/nothing to disconnect/)
})

describe('long turns finish in the background (Alexa waits about 8 seconds)', () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const booked = { voice: { session: { attributes: { history: [{ role: 'assistant', content: 'booked' }] } }, reply: { speech: 'You’re booked with Ana on Tuesday at 9 AM, paid with your saved PayPal.', reprompt: 'Anything else?', end: false } } }
  beforeEach(() => { process.env.ALEXA_REPLY_WITHIN_MS = '60'; process.env.ALEXA_POLL_MS = '5' })
  afterEach(() => { alexa._useInvoker(null); delete process.env.ALEXA_REPLY_WITHIN_MS; delete process.env.ALEXA_POLL_MS })

  test('a quick turn still answers in the same breath, and the AI runs once, as Alexa', async () => {
    await linkedCode()
    alexa._useInvoker(job => alexa.runWork(job))
    const r = await handler(req(intent('ChatIntent', { text: 'what are my bookings' })))
    expect(speech(r)).toBe('Ana has 11 AM open on Monday. Shall I book it?')
    expect(voice.handle).toHaveBeenCalledTimes(1)
    expect(voice.handle.mock.calls[0][1]).toMatchObject({ via: 'Alexa' })
  })

  test('a slow booking: "I’m on it", never a second run while it works, then the answer on the next turn', async () => {
    await linkedCode()
    voice.handle.mockImplementation(async () => { await sleep(150); return booked })
    let run
    alexa._useInvoker(job => { run = alexa.runWork(job) })      // started, not awaited: like an async Lambda invoke

    const first = await handler(req(intent('ChatIntent', { text: 'book my usual haircut for Tuesday at 9' })))
    expect(speech(first)).toMatch(/^I’m on it/)
    expect(first.response.shouldEndSession).toBe(false)
    expect(first.response.reprompt.outputSpeech.text).toBe('Say go on to hear how it went.')

    const meanwhile = await handler(req(intent('ChatIntent', { text: 'go on' })))
    expect(speech(meanwhile)).toMatch(/^Still working on it/)
    expect(voice.handle).toHaveBeenCalledTimes(1)                // no second booking

    await run
    const answer = await handler(req(intent('ChatIntent', { text: 'go on' })))
    expect(speech(answer)).toBe('You’re booked with Ana on Tuesday at 9 AM, paid with your saved PayPal.')
    expect(answer.sessionAttributes).toEqual({ history: [{ role: 'assistant', content: 'booked' }] })
    expect(voice.handle).toHaveBeenCalledTimes(1)

    voice.handle.mockResolvedValue(booked)                       // then turns run as usual again
    alexa._useInvoker(job => alexa.runWork(job))
    await handler(req(intent('ChatIntent', { text: 'thanks' })))
    expect(voice.handle).toHaveBeenCalledTimes(2)
  })

  test('a pending turn that never finished is dropped after two minutes, not forever', async () => {
    await linkedCode()
    const who = 'ALXPEND#' + require('crypto').createHash('sha256').update('amzn1.ask.account.USER1').digest('hex').slice(0, 32)
    await store().putKey(who, 'P', { id: 'lost', at: Date.now() - 3 * 60_000 }, Date.now() + 60_000)
    alexa._useInvoker(job => alexa.runWork(job))
    const r = await handler(req(intent('ChatIntent', { text: 'book me a haircut' })))
    expect(speech(r)).toBe('Ana has 11 AM open on Monday. Shall I book it?')
  })

  test('if the background run can’t start, the turn runs as before', async () => {
    await linkedCode()
    alexa._useInvoker(() => { throw new Error('AccessDenied') })
    const r = await handler(req(intent('ChatIntent', { text: 'book me a haircut' })))
    expect(speech(r)).toBe('Ana has 11 AM open on Monday. Shall I book it?')
    expect(voice.handle).toHaveBeenCalledTimes(1)
  })

  test('the background run comes in through the same Lambda handler', async () => {
    await linkedCode()
    const env = { version: 1, session: { new: false, attributes: {} }, request: { type: 'say', text: 'hi' } }
    const r = await handler({ flowAlexaWork: { id: 'job-1', sid: 'S1', env } })
    expect(r).toMatchObject({ speech: 'Ana has 11 AM open on Monday. Shall I book it?', end: false })
    expect(await store().getKey('ALXRES#job-1', 'R')).toMatchObject({ speech: 'Ana has 11 AM open on Monday. Shall I book it?' })
  })
})
