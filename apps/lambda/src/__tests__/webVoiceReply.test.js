'use strict'

// Web chat, like Telegram: a voice note is answered with a spoken reply (Amazon
// Polly, mocked here) alongside the text; a typed message gets text only, and
// if Polly fails the text still goes.

process.env.FLOW_LINK_SECRET = 'test-secret'
process.env.DEMO_STORE = 'memory'

jest.mock('../core/demoSession', () => ({
  sidFromToken: jest.fn(t => (t === 'session-token' ? 'abcdef123456' : null)),
  getActiveSession: jest.fn(async sid => (sid === 'abcdef123456' ? { sid, status: 'active' } : null))
}))
jest.mock('../core/demoChat', () => ({ chatTurn: jest.fn() }))
jest.mock('../services/cloudTts', () => ({ voiceMessage: jest.fn() }))
// The upload checks have their own tests (media); here any voice note is accepted as is.
jest.mock('../services/media', () => ({ parseAttachment: jest.fn(a => ({ ...a, buffer: Buffer.from(a.data, 'base64') })) }))

const { chatTurn } = require('../core/demoChat')
const { voiceMessage } = require('../services/cloudTts')
const { handler } = require('../handlers/demo')

const post = body => handler({ httpMethod: 'POST', pathParameters: { proxy: 'chat' }, headers: { Authorization: 'Bearer session-token' }, body: JSON.stringify(body) })
const VOICE = { kind: 'audio', mimeType: 'audio/webm', data: Buffer.from('fake-opus').toString('base64'), name: 'voice-note', durationSec: 3 }

beforeEach(() => jest.clearAllMocks())

test('a voice note gets the reply spoken back, with the text', async () => {
  chatTurn.mockResolvedValue({ reply: '**Ana** has 3 PM free on Saturday. Shall I book it?', media: { kind: 'audio', transcript: 'haircut saturday' } })
  voiceMessage.mockResolvedValue({ mimeType: 'audio/mpeg', buffer: Buffer.from('mp3-bytes'), voice: 'Joanna', lang: 'en-US' })
  const body = JSON.parse((await post({ attachment: VOICE })).body)
  expect(voiceMessage).toHaveBeenCalledWith('Ana has 3 PM free on Saturday. Shall I book it?')
  expect(body.reply).toMatch(/Ana/)
  expect(body.voice).toEqual({ mimeType: 'audio/mpeg', data: Buffer.from('mp3-bytes').toString('base64'), voice: 'Joanna' })
})

test('a typed message gets text only', async () => {
  chatTurn.mockResolvedValue({ reply: 'Sure.', media: null })
  const body = JSON.parse((await post({ message: 'book me a haircut' })).body)
  expect(voiceMessage).not.toHaveBeenCalled()
  expect(body.voice).toBeUndefined()
})

test('if Polly has no audio, the text still goes', async () => {
  chatTurn.mockResolvedValue({ reply: 'Sure.', media: { kind: 'audio', transcript: 'hi' } })
  voiceMessage.mockResolvedValue(null)
  const r = await post({ attachment: VOICE })
  expect(r.statusCode).toBe(200)
  expect(JSON.parse(r.body)).toMatchObject({ reply: 'Sure.' })
  expect(JSON.parse(r.body).voice).toBeUndefined()
})
