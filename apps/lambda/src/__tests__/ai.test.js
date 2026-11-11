'use strict'

// The AI provider for the backend's thinking: Claude when an Anthropic key is
// set (else Gemini), the same provider's backup model only before a tool ran,
// AI_PROVIDER to force one, and speech always on Google with Gemini models.

const mockGenerate = jest.fn()
const mockGetModel = jest.fn(() => ({ generateContent: mockGenerate }))
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: mockGetModel }))
}))
const mockClaudeCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockClaudeCreate } })))
jest.mock('../services/tools', () => ({
  getTools: () => [{ name: 'check_availability', description: 'Open slots', parameters: { date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['date'] }],
  executeTool: jest.fn(),
  hasSideEffects: n => n === 'book_appointment'
}))

const ai = require('../services/ai')
const trace = require('../services/trace')
const { routeMessage } = require('../services/aiRouter')
const { executeTool } = require('../services/tools')

const text = t => ({ response: { text: () => t, functionCalls: () => undefined } })
const toolCall = (name, args) => ({ response: {
  text: () => '',
  functionCalls: () => [{ name, args }],
  candidates: [{ content: { parts: [{ functionCall: { name, args }, thoughtSignature: 'sig' }] } }]
} })
const notFound = () => Object.assign(new Error('[404 Not Found] model is not found'), { status: 404 })
const models = () => mockGetModel.mock.calls.map(c => c[0].model)

let sink
beforeEach(() => {
  jest.clearAllMocks()
  for (const k of ['AI_PROVIDER', 'AI_MODEL', 'AI_BACKUP_MODEL', 'ANTHROPIC_API_KEY']) delete process.env[k]
  sink = trace.memorySink(); trace.setSink(sink)
})
afterAll(() => trace.setSink(null))

describe('config', () => {
  test('Claude Haiku when an Anthropic key is set, else Gemini; AI_PROVIDER forces one', () => {
    expect(ai.provider()).toBe('gemini')
    expect(ai.models()).toEqual({ main: 'gemini-3.5-flash', backup: 'gemini-3.5-flash-lite' })
    process.env.ANTHROPIC_API_KEY = 'k'
    expect(ai.provider()).toBe('anthropic')
    expect(ai.models()).toEqual({ main: 'claude-haiku-5-5', backup: 'claude-sonnet-5-5' })
    process.env.AI_PROVIDER = 'gemini'
    expect(ai.provider()).toBe('gemini')
  })
  test('AI_MODEL / AI_BACKUP_MODEL only change the main provider\'s models', () => {
    process.env.ANTHROPIC_API_KEY = 'k'
    process.env.AI_MODEL = 'claude-sonnet-5-5'
    process.env.AI_BACKUP_MODEL = 'claude-opus-5-5'
    expect(ai.models()).toEqual({ main: 'claude-sonnet-5-5', backup: 'claude-opus-5-5' })
    // Google-only jobs (voice-note transcripts) keep Gemini models.
    expect(ai.models('gemini')).toEqual({ main: 'gemini-3.5-flash', backup: 'gemini-3.5-flash-lite' })
    process.env.AI_PROVIDER = 'gemini'
    process.env.AI_MODEL = 'gemini-3.6-flash'
    expect(ai.models().main).toBe('gemini-3.6-flash')
  })
  test('unknown provider is a clear error', () => {
    process.env.AI_PROVIDER = 'openai'
    expect(() => ai.provider()).toThrow('Unknown AI_PROVIDER')
  })
  test('the timeline names a model by its product name', () => {
    expect(ai.modelLabel('claude-haiku-5-5')).toBe('Claude Haiku 5.5')
    expect(ai.modelLabel('claude-sonnet-5-5-20261001')).toBe('Claude Sonnet 5.5')
    expect(ai.modelLabel('claude-opus-5')).toBe('Claude Opus 5')
    expect(ai.modelLabel('gemini-3.5-flash')).toBe('Gemini 3.5 Flash')
    expect(ai.aiLabel('gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash-Lite')
    expect(ai.modelLabel('gemini-3.8-flash-tts')).toBe('Gemini 3.8 Flash TTS')
    expect(ai.modelLabel('gemini-embedding-001')).toBe('Gemini Embedding 001')
    expect(ai.modelLabel('some-other-model')).toBe('some-other-model')
  })
})

describe('chat on Gemini', () => {
  test('runs the tool loop and echoes the model turn back', async () => {
    mockGenerate.mockResolvedValueOnce(toolCall('check_availability', { date: '2026-10-17' })).mockResolvedValueOnce(text('3pm or 4pm?'))
    const runTool = jest.fn().mockResolvedValue([{ time: '15:00' }])
    const r = await ai.chat({ system: 'sys', history: [{ role: 'assistant', content: 'Hi!' }], text: 'tomorrow?', tools: [{ name: 'check_availability', description: 'd', parameters: { date: { type: 'string', description: 'x' } }, required: ['date'] }], runTool })

    expect(r).toMatchObject({ reply: '3pm or 4pm?', model: 'gemini-3.5-flash', usedTools: true })
    expect(runTool).toHaveBeenCalledWith('check_availability', { date: '2026-10-17' })
    const opts = mockGetModel.mock.calls[0][0]
    expect(opts.tools[0].functionDeclarations[0]).toEqual({ name: 'check_availability', description: 'd', parameters: { type: 'OBJECT', properties: { date: { type: 'STRING', description: 'x' } }, required: ['date'] } })
    const second = mockGenerate.mock.calls[1][0].contents
    expect(second[0]).toEqual({ role: 'model', parts: [{ text: 'Hi!' }] })
    expect(second[2].parts[0].thoughtSignature).toBe('sig')
    expect(second[3].parts[0].functionResponse).toEqual({ name: 'check_availability', response: { items: [{ time: '15:00' }] } })
  })

  test('main model down before any tool → backup model answers', async () => {
    mockGenerate.mockRejectedValueOnce(notFound()).mockResolvedValueOnce(text('Hello!'))
    const r = await ai.chat({ system: 's', text: 'hi', runTool: jest.fn() })
    expect(r).toMatchObject({ reply: 'Hello!', model: 'gemini-3.5-flash-lite', backupUsed: true })
    expect(models()).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash-lite'])
  })

  test('main model out of quota → straight to the backup, no retries on the spent model', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('[429 Too Many Requests] You exceeded your current quota, please check your plan and billing details.')).mockResolvedValueOnce(text('Hi!'))
    const r = await ai.chat({ system: 's', text: 'hi', runTool: jest.fn() })
    expect(r).toMatchObject({ reply: 'Hi!', model: 'gemini-3.5-flash-lite' })
    expect(mockGenerate).toHaveBeenCalledTimes(2)
    expect(ai.errorReason(new Error('429 You exceeded your current quota'))).toBe('quota used up')
  })

  test('after only read-only lookups, the backup may redo the turn', async () => {
    mockGenerate.mockResolvedValueOnce(toolCall('search_businesses', { query: 'massage' })).mockRejectedValueOnce(notFound()).mockResolvedValueOnce(text('Barton Springs, 1.9 mi.'))
    const r = await ai.chat({ system: 's', text: 'massage near me', runTool: jest.fn().mockResolvedValue([]), safeToRepeat: n => n === 'search_businesses' })
    expect(r).toMatchObject({ reply: 'Barton Springs, 1.9 mi.', model: 'gemini-3.5-flash-lite', backupUsed: true })
  })

  test('main model fails AFTER a tool ran → no backup, so a booking step is never repeated', async () => {
    mockGenerate.mockResolvedValueOnce(toolCall('book_appointment', { slot: 'x' })).mockRejectedValueOnce(notFound())
    const runTool = jest.fn().mockResolvedValue({ ok: true })
    await expect(ai.chat({ system: 's', text: 'book it', runTool })).rejects.toThrow('404')
    expect(runTool).toHaveBeenCalledTimes(1)
    expect(models()).toEqual(['gemini-3.5-flash'])
  })
})

describe('AI_PROVIDER=anthropic', () => {
  beforeEach(() => { process.env.AI_PROVIDER = 'anthropic' })

  test('chat goes to Claude only, with tools and a cached system prompt', async () => {
    mockClaudeCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi there' }] })
    const r = await ai.chat({ system: 'sys', text: 'hi', tools: [{ name: 't', description: 'd', parameters: {}, required: [] }], runTool: jest.fn() })
    expect(r).toMatchObject({ reply: 'Hi there', model: 'claude-haiku-5-5' })
    const req = mockClaudeCreate.mock.calls[0][0]
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(req.tools[0]).toEqual({ name: 't', description: 'd', input_schema: { type: 'object', properties: {}, required: [] } })
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  test('low-token chat: effort low, room for thinking, the conversation cached too, the time as a note on the new message only', async () => {
    delete process.env.AI_EFFORT
    mockClaudeCreate
      .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'check_availability', input: { date: '2026-10-27' } }], usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 } })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: '2 PM is free.' }], usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 5300, cache_creation_input_tokens: 0 } })
    const r = await ai.chat({ system: 'sys', history: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi!' }], text: 'Is Tuesday free?', note: 'Local time now: Friday 1:47 PM (America/Chicago).',
      tools: [{ name: 'check_availability', description: 'd', parameters: {}, required: [] }], runTool: jest.fn().mockResolvedValue({ slots: ['14:00'] }) })
    const req = mockClaudeCreate.mock.calls[0][0]
    expect(req).toMatchObject({ max_tokens: 4096, output_config: { effort: 'low' }, cache_control: { type: 'ephemeral' } })
    expect(req.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }])
    // Earlier turns untouched; the note rides only on the new message.
    expect(req.messages[0]).toEqual({ role: 'user', content: 'hello' })
    expect(req.messages[2].content).toEqual([{ type: 'text', text: 'Is Tuesday free?' }, { type: 'text', text: '(Local time now: Friday 1:47 PM (America/Chicago).)' }])
    // Usage across both rounds, cache reads included.
    expect(r.usage).toEqual({ input_tokens: 420, output_tokens: 70, cache_read_input_tokens: 5300, cache_creation_input_tokens: 5000 })
    expect(require('../services/aiRouter').tokenSummary(r.usage)).toBe('in 10,720 (5,300 cached) · out 70')
  })

  test('text written beside a tool call is never shown, and the model is told so (no "correcting my earlier message")', async () => {
    mockClaudeCreate
      .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'Free parking out back!' }, { type: 'tool_use', id: 't1', name: 'check_availability', input: { date: '2026-10-27' } }] })
      .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'check_availability', input: { date: '2026-10-28' } }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Their FAQ says there is free parking behind the building.' }] })
    const r = await ai.chat({ system: 'sys', text: 'Is there parking?', tools: [{ name: 'check_availability', description: 'd', parameters: {}, required: [] }], runTool: jest.fn().mockResolvedValue({ ok: true }) })
    expect(r.reply).toBe('Their FAQ says there is free parking behind the building.')
    const msgs = mockClaudeCreate.mock.calls[2][0].messages
    // The model's own turn goes back unchanged; the note follows the tool result.
    expect(msgs[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Free parking out back!' }, { type: 'tool_use', id: 't1', name: 'check_availability', input: { date: '2026-10-27' } }] })
    expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' })
    expect(msgs[2].content[1]).toMatchObject({ type: 'text', text: expect.stringMatching(/has not seen/) })
    // A round with no text gets no note.
    expect(msgs[4].content).toHaveLength(1)
  })

  test('AI_EFFORT raises the effort without a code change', async () => {
    process.env.AI_EFFORT = 'medium'
    mockClaudeCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })
    await ai.chat({ system: 'sys', text: 'hi', runTool: jest.fn() })
    expect(mockClaudeCreate.mock.calls[0][0].output_config).toEqual({ effort: 'medium' })
    delete process.env.AI_EFFORT
  })

  test('a declined request, or a tool call cut off mid-way, goes to the backup model instead of being used', async () => {
    mockClaudeCreate
      .mockResolvedValueOnce({ stop_reason: 'refusal', content: [] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'From the backup' }] })
    const r = await ai.chat({ system: 'sys', text: 'hi', runTool: jest.fn() })
    expect(r).toMatchObject({ reply: 'From the backup', model: 'claude-sonnet-5-5', backupUsed: true })

    mockClaudeCreate.mockReset()
    const runTool = jest.fn()
    mockClaudeCreate
      .mockResolvedValueOnce({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 't1', name: 'check_availability', input: {} }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })
    await ai.chat({ system: 'sys', text: 'hi', tools: [{ name: 'check_availability', description: 'd', parameters: {}, required: [] }], runTool })
    expect(runTool).not.toHaveBeenCalled()
  })

  test('Claude out of credit: no second Claude try, Gemini answers instead', async () => {
    process.env.GOOGLE_API_KEY = 'g'
    mockClaudeCreate.mockRejectedValue(Object.assign(new Error('400 Your credit balance is too low to access the Anthropic API.'), { status: 400 }))
    mockGenerate.mockResolvedValue(text('Hi from Gemini'))
    const r = await trace.run('sess:credit', () => ai.chat({ system: 'sys', text: 'hi', runTool: jest.fn() }))
    expect(r).toMatchObject({ reply: 'Hi from Gemini', model: 'gemini-3.5-flash', providerFallback: 'gemini' })
    expect(mockClaudeCreate).toHaveBeenCalledTimes(1)
    expect(sink.events.map(e => e.title)).toContain('Anthropic unavailable → Gemini 3.5 Flash')
    // Photos and PDFs fall back the same way.
    const g = await ai.generate({ parts: [{ text: 'describe' }] })
    expect(g).toMatchObject({ text: 'Hi from Gemini', provider: 'gemini' })
  })

  test('no switch to Gemini once a booking step ran', async () => {
    process.env.GOOGLE_API_KEY = 'g'
    mockClaudeCreate
      .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'book_appointment', input: {} }] })
      .mockRejectedValue(Object.assign(new Error('529 overloaded'), { status: 529 }))
    await expect(ai.chat({ system: 'sys', text: 'book it', tools: [{ name: 'book_appointment', description: 'd', parameters: {}, required: [] }], runTool: jest.fn().mockResolvedValue({ ok: true }) })).rejects.toThrow()
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  test('photos become image blocks; speech still goes to Google, on a Gemini model', async () => {
    process.env.AI_MODEL = 'claude-haiku-5-5'
    mockClaudeCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'A bob.' }] })
    const r = await ai.generate({ parts: [{ data: Buffer.from('img'), mimeType: 'image/png' }, { text: 'describe' }] })
    expect(r).toMatchObject({ text: 'A bob.', provider: 'anthropic' })
    expect(mockClaudeCreate.mock.calls[0][0].messages[0].content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } })

    mockGenerate.mockResolvedValue(text('book me in'))
    const t = await ai.transcribe({ data: Buffer.from('RIFF'), mimeType: 'audio/wav', prompt: 'transcribe' })
    expect(t).toMatchObject({ text: 'book me in', provider: 'gemini', model: 'gemini-3.5-flash' })
  })
})

describe('time limits', () => {
  test('every model call carries a time limit (Gemini and Claude)', async () => {
    mockGenerate.mockResolvedValue(text('Hi!'))
    await ai.chat({ system: 's', text: 'hi', runTool: jest.fn() })
    const opts = mockGenerate.mock.calls[0][1]
    expect(opts.timeout).toBeGreaterThan(0)
    expect(opts.timeout).toBeLessThanOrEqual(15000)

    process.env.AI_PROVIDER = 'anthropic'
    mockClaudeCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi' }] })
    await ai.chat({ system: 's', text: 'hi', runTool: jest.fn() })
    expect(mockClaudeCreate.mock.calls[0][1]).toMatchObject({ timeout: expect.any(Number), maxRetries: 0 })
  })

  test('with the turn\'s time nearly used up, no backup or other provider is tried', async () => {
    process.env.GOOGLE_API_KEY = 'g'
    const t0 = 1_000_000
    let first = true
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => { if (first) { first = false; return t0 } return t0 + 23_000 })
    mockGenerate.mockRejectedValue(notFound())
    await expect(ai.chat({ system: 's', text: 'hi', runTool: jest.fn() })).rejects.toThrow()
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('routeMessage', () => {
  const business = { businessId: 'b1', name: 'Willow', type: 'salon', config: { services: [], availability: { open: '09:00', close: '18:00' } } }

  test('timeline names the model; tools run with the caller context', async () => {
    mockGenerate.mockResolvedValueOnce(toolCall('check_availability', { date: '2026-10-17' })).mockResolvedValueOnce(text('Free at 3pm.'))
    executeTool.mockResolvedValue({ slots: ['15:00'] })
    const ctx = { businessId: 'b1', channel: 'web', traceScope: 'sess:1' }
    const r = await routeMessage(business, [], 'tomorrow?', [], ctx)
    expect(r).toMatchObject({ reply: 'Free at 3pm.', model: 'gemini-3.5-flash' })
    expect(executeTool).toHaveBeenCalledWith('check_availability', { date: '2026-10-17' }, ctx)
    expect(sink.events.map(e => e.title)).toEqual(['Asked Gemini 3.5 Flash', 'Gemini 3.5 Flash replied'])
  })

  test('both models down → polite apology, never a crash', async () => {
    mockGenerate.mockRejectedValue(notFound())
    const r = await routeMessage(business, [], 'hi', [], { traceScope: 'sess:2' })
    expect(r.reply).toMatch(/technical issue/)
    expect(sink.events.map(e => e.title)).toEqual(['Asked Gemini 3.5 Flash', 'Gemini 3.5 Flash unavailable → Gemini 3.5 Flash-Lite', 'AI unavailable — apology sent'])
  })
})
