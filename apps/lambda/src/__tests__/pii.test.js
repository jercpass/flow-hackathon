'use strict'

// Customer names out of the AI's reach: the
// vault tokenizes and decodes names, is stored encrypted, the AI only ever gets
// tokens (prompt, history, message, tool results) while tools get real names and
// the customer gets a decoded reply, and Under the hood records tokens.

process.env.FLOW_LINK_SECRET = 'test-secret'

jest.mock('../services/ai', () => ({
  chat: jest.fn(),
  models: () => ({ main: 'claude-haiku-5-5' }),
  modelLabel: () => 'Claude Haiku 5.5',
  aiLabel: () => 'Claude Haiku 5.5',
  errorReason: () => 'error'
}))
jest.mock('../services/tools', () => ({ executeTool: jest.fn(), getTools: () => [], hasSideEffects: () => true }))

const { setStore, memory, store } = require('../services/demoStore')
const trace = require('../services/trace')
const pii = require('../services/pii')
const ai = require('../services/ai')
const { executeTool } = require('../services/tools')
const { routeMessage } = require('../services/aiRouter')

const session = { sid: 'S1', expiresAt: Date.now() + 3600_000, customerName: 'Maya Patel' }
const TOKEN = /⟦pii:[A-Z2-7]{8}⟧/

beforeEach(() => { jest.clearAllMocks(); setStore(memory()); pii.forget('S1'); pii.forget('S2') })

describe('the vault', () => {
  test('full names and first names become stable tokens, longest first, and decode back', () => {
    const v = new pii.Vault('S1')
    const full = v.add('Maya Patel')
    const text = 'Hi Maya! Maya Patel, your Haircut is booked. Mayana is someone else.'
    const t = v.tokenize(text)
    expect(t).not.toMatch(/\bMaya\b/)
    expect(t).toContain(full)
    expect(t).toMatch(/Mayana is someone else/)   // a different name, left alone
    expect(t.match(new RegExp(TOKEN.source, "g"))).toHaveLength(2)   // "Maya", then "Maya Patel" as one token
    expect(v.detokenize(t)).toBe(text)
    expect(v.add('Maya Patel')).toBe(full)
    expect(new pii.Vault('S2').add('Maya Patel')).not.toBe(full)
  })

  test('unknown tokens are found, and decode to what the caller chooses', () => {
    const v = new pii.Vault('S1')
    v.add('Maya Patel')
    expect(v.unknownTokens({ customer_name: '⟦pii:AAAAAAAA⟧' })).toEqual(['AAAAAAAA'])
    expect(v.detokenize('Hi ⟦pii:AAAAAAAA⟧!', '')).toBe('Hi !')
  })

  test('stored encrypted: the name is not readable in the store, and loads back', async () => {
    const v = await pii.vaultFor(session)
    const rec = await store().getKey('S#S1', 'PII')
    expect(JSON.stringify(rec)).not.toMatch(/Maya/)
    pii.forget('S1')
    const again = await pii.load('S1')
    expect(again.values()).toEqual(expect.arrayContaining(['Maya Patel', 'Maya']))
    expect(again.tokenize('Maya')).toBe(v.tokenize('Maya'))
  })
})

describe('the AI only sees tokens', () => {
  test('prompt, history, message and tool results go in as tokens; the tool gets the real name; the reply is decoded', async () => {
    const vault = await pii.vaultFor(session)
    const token = vault.tokenize('Maya Patel')
    executeTool.mockResolvedValue({ booked: true, message: 'Booked for Maya Patel.' })
    let seen
    ai.chat.mockImplementation(async (req) => {
      const shown = await req.runTool('book_appointment', { service_name: 'Haircut', customer_name: token })
      seen = { req, shown }
      return { reply: `Done, ${token}! See you Saturday.`, toolEvents: [{ name: 'book_appointment', result: shown }], model: 'claude-haiku-5-5' }
    })
    const ctx = { systemPrompt: 'You help Maya Patel book.', pii: vault, traceScope: null }
    const out = await routeMessage({ businessId: 'b1' }, [{ role: 'assistant', content: 'Hi Maya!' }], 'Book a haircut for Maya Patel', [], ctx)

    expect(JSON.stringify([seen.req.system, seen.req.history, seen.req.text, seen.shown])).not.toMatch(/Maya/)
    expect(seen.req.system).toMatch(/tokens like/)
    expect(executeTool.mock.calls[0][1]).toMatchObject({ customer_name: 'Maya Patel' })
    expect(out.reply).toBe('Done, Maya Patel! See you Saturday.')
  })

  test('a token the conversation never had is refused before any tool runs', async () => {
    const vault = await pii.vaultFor(session)
    let shown
    ai.chat.mockImplementation(async (req) => {
      shown = await req.runTool('book_appointment', { customer_name: '⟦pii:AAAAAAAA⟧' })
      return { reply: 'ok', toolEvents: [], model: 'm' }
    })
    await routeMessage({ businessId: 'b1' }, [], 'hi', [], { systemPrompt: 'x', pii: vault })
    expect(executeTool).not.toHaveBeenCalled()
    expect(shown.error).toMatch(/isn't one this conversation has/)
  })
})

test('Under the hood records a session\'s names as tokens', async () => {
  const sink = trace.memorySink()
  trace.setSink(sink)
  await pii.vaultFor(session)
  await trace.run('sess:S1', async () => {
    trace.event('session', 'The customer is now Maya Patel (logged in with PayPal)', { customer: 'Maya Patel', note: 'Hi Maya' })
  })
  expect(JSON.stringify(sink.events)).not.toMatch(/Maya/)
  expect(sink.events[0].title).toMatch(TOKEN)
  trace.setSink(null)
})
