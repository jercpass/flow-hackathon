'use strict'

// Voice assistant (Flow Voice): the request/response shape, start / help /
// stop, the concierge turn, speech cleanup, and the TTS WAV wrapper.

jest.mock('../services/aiRouter', () => ({ routeMessage: jest.fn() }))
const { routeMessage } = require('../services/aiRouter')
const voice = require('../core/voice')
const { pcmToWav } = require('../services/cloudTts')

const env = (type, attributes = {}, text) => ({ version: 1, session: { new: type === 'start', attributes }, request: { type, ...(text !== undefined ? { text } : {}) } })
const c = { business: { businessId: 'b' }, customer: { name: 'Sam Rivera' }, ctx: { systemPrompt: 'CITY PROMPT', channel: 'web' } }

beforeEach(() => jest.clearAllMocks())

test('start greets by name without calling the AI', async () => {
  const r = await voice.handle(env('start'), c)
  expect(r.speech).toBe('Hi Sam! Flow here. What would you like to book?')
  expect(r.voice).toMatchObject({ version: 1, reply: { speech: r.speech, end: false, reprompt: 'You can say, book me a haircut.' } })
  expect(routeMessage).not.toHaveBeenCalled()
})

test('"say" runs the concierge in voice style and carries the history in the session', async () => {
  routeMessage.mockResolvedValue({ reply: '**Your usual** — Willow & Co. with Ana?\n- 3pm\n- 4pm', toolEvents: [] })
  const prior = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
  const r = await voice.handle(env('say', { history: prior }, 'book me a haircut'), c)
  const [, history, text, rag, ctx] = routeMessage.mock.calls[0]
  expect(history).toEqual(prior)
  expect(text).toBe('book me a haircut')
  expect(rag).toEqual([])
  expect(ctx.channel).toBe('speaker')
  expect(ctx.systemPrompt).toMatch(/^CITY PROMPT[\s\S]*SPEAKING out loud through a voice assistant/)
  expect(r.speech).toBe('Your usual, Willow & Co. with Ana? 3pm, 4pm')                   // no markdown; the list is spoken as a list
  expect(r.voice.reply.card).toEqual({ title: 'Flow', text: r.speech })
  expect(r.voice.session.attributes.history.slice(-2)).toEqual([
    { role: 'user', content: 'book me a haircut' },
    { role: 'assistant', content: '**Your usual** — Willow & Co. with Ana?\n- 3pm\n- 4pm' }
  ])
})

test('a paid booking returns the PayPal link for the card and says it is in the inbox', async () => {
  routeMessage.mockResolvedValue({ reply: "I've sent a secure PayPal link to your Flow inbox.", toolEvents: [{ name: 'book_appointment', result: { paymentUrl: 'https://sandbox.paypal.com/x', amount: 40, currency: 'USD', service: 'Haircut', holdMinutes: 10 } }] })
  const r = await voice.handle(env('say', {}, 'yes, 3pm'), c)
  expect(r.payment).toEqual({ url: 'https://sandbox.paypal.com/x', amount: 40, currency: 'USD', service: 'Haircut', holdMinutes: 10, kind: 'booking' })
  expect(r.voice.reply.card.title).toBe('Pay to confirm: Haircut')
  expect(r.bookingsChanged).toBe(true)
})

test('stop ends the session, help explains, empty speech re-prompts', async () => {
  const stop = await voice.handle(env('stop'), c)
  expect(stop.voice.reply.end).toBe(true)
  const help = await voice.handle(env('help'), c)
  expect(help.speech).toMatch(/book me a haircut/)
  const empty = await voice.handle(env('say', {}, '  '), c)
  expect(empty.speech).toMatch(/didn't catch that/)
  expect(routeMessage).not.toHaveBeenCalled()
})

test('rejects anything that is not a Flow Voice request', async () => {
  await expect(voice.handle({ version: 2, request: { type: 'say' } }, c)).rejects.toMatchObject({ code: 'VOICE_INVALID' })
  await expect(voice.handle(env('order_pizza'), c)).rejects.toThrow('Unsupported request type')
  await expect(voice.handle(null, c)).rejects.toThrow('Not a Flow Voice request')
})

test('speakable strips links, markdown and bullets', () => {
  expect(voice.speakable('Pay here: https://paypal.com/abc\n- **Fast**')).toBe('Pay here: the link, Fast')
})

test('raw PCM from TTS is wrapped in a valid WAV header', () => {
  const pcm = Buffer.alloc(48000)   // 1 s of 24 kHz 16-bit mono
  const wav = pcmToWav(pcm, 24000)
  expect(wav.subarray(0, 4).toString()).toBe('RIFF')
  expect(wav.subarray(8, 12).toString()).toBe('WAVE')
  expect(wav.readUInt32LE(24)).toBe(24000)
  expect(wav.readUInt32LE(40)).toBe(48000)
  expect(wav.length).toBe(48044)
})

test('speakable turns symbols into pauses, so nothing is read out as a symbol', () => {
  expect(voice.speakable('Booked \u2705 Haircut \u00b7 Tue, Nov 3 \u00b7 9 AM (with Ana) \u2014 $40 paid.')).toBe('Booked Haircut, Tue, Nov 3, 9 AM, with Ana, $40 paid.')
  expect(voice.speakable('Two times work:\n- 3 PM\n- 4 PM\nWhich one?')).toBe('Two times work: 3 PM, 4 PM. Which one?')
})

test('the timeline gets "<channel> replied" with what was said, not a raw request type', async () => {
  const trace = require('../services/trace')
  const spy = jest.spyOn(trace, 'event')
  routeMessage.mockResolvedValue({ reply: 'Ana is free at 9 AM. Shall I book it?', toolEvents: [] })
  await voice.handle(env('say', {}, 'book me a haircut'), { ...c, via: 'Alexa' })
  expect(spy).toHaveBeenCalledWith('session', 'Alexa replied', { reply: 'Ana is free at 9 AM. Shall I book it?' })
  expect(spy.mock.calls.map(x => x[1])).not.toContain('Voice: say')
  await voice.handle(env('start'), c)
  expect(spy).toHaveBeenCalledWith('session', 'Flow Voice: opened', {})
  spy.mockRestore()
})
