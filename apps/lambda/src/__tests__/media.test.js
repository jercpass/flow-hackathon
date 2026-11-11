'use strict'

// Media: attachment validation, reading photos/PDFs and transcribing voice notes
// on the one configured provider (backup model when the main one is down),
// and retry on busy.

const mockGenerate = jest.fn()
const mockGetModel = jest.fn(() => ({ generateContent: mockGenerate }))
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: mockGetModel }))
}))

const media = require('../services/media')
const { withRetry, isTransient } = require('../utils/retry')

const b64 = s => Buffer.from(s).toString('base64')
const geminiText = t => ({ response: { text: () => t } })

beforeEach(() => {
  jest.clearAllMocks()
  process.env.GOOGLE_API_KEY = 'g'
  delete process.env.AI_PROVIDER
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.AI_MODEL
  delete process.env.AI_BACKUP_MODEL
})

describe('parseAttachment', () => {
  test('accepts a WAV voice note and normalises the fields', () => {
    const a = media.parseAttachment({ kind: 'audio', mimeType: 'audio/wav; codecs=1', data: b64('RIFF....WAVE'), durationSec: 6.4, name: 'v<o>ice' })
    expect(a).toMatchObject({ kind: 'audio', mimeType: 'audio/wav', durationSec: 6, name: 'voice' })
    expect(Buffer.isBuffer(a.buffer)).toBe(true)
  })
  test.each([
    [{ kind: 'video', mimeType: 'video/mp4', data: b64('x') }, 'Unsupported attachment type'],
    [{ kind: 'image', mimeType: 'image/svg+xml', data: b64('<svg/>') }, 'format'],
    [{ kind: 'pdf', mimeType: 'application/pdf', data: b64('not a pdf') }, 'not a valid PDF'],
    [{ kind: 'image', mimeType: 'image/png', data: '' }, 'empty'],
    [{ kind: 'image', mimeType: 'image/png', data: '<script>' }, 'corrupted']
  ])('rejects %o', (input, msg) => {
    expect(() => media.parseAttachment(input)).toThrow(msg)
  })
  test('enforces size limits', () => {
    const big = Buffer.alloc(media.LIMITS.image + 1).toString('base64')
    expect(() => media.parseAttachment({ kind: 'image', mimeType: 'image/png', data: big })).toThrow('too large (max 4 MB)')
    const bigDoc = Buffer.alloc(media.LIMITS.doc + 1, 'a').toString('base64')
    expect(() => media.parseAttachment({ kind: 'doc', mimeType: 'text/plain', name: 'big.txt', data: bigDoc })).toThrow('too large (max 4 MB)')
  })
  test('voice notes: up to 1 minute (a second of slack for rounding)', () => {
    expect(media.parseAttachment({ kind: 'audio', mimeType: 'audio/ogg', data: b64('OggS'), durationSec: 61 }).durationSec).toBe(61)
    expect(() => media.parseAttachment({ kind: 'audio', mimeType: 'audio/ogg', data: b64('OggS'), durationSec: 75 })).toThrow('Voice notes can be up to 1 minute')
  })
  test('a text document is read on arrival: its text, its type, and a cut for long ones', () => {
    const a = media.parseAttachment({ kind: 'doc', mimeType: 'application/vnd.ms-excel', name: 'guests.csv', data: b64('Name,Service\nSam,Cut') })
    expect(a).toMatchObject({ kind: 'doc', docType: 'text', name: 'guests.csv', text: 'Name,Service\nSam,Cut', truncated: false })
    const long = media.parseAttachment({ kind: 'doc', mimeType: 'text/plain', name: 'long.txt', data: b64('x'.repeat(40_000)) })
    expect(long).toMatchObject({ truncated: true })
    expect(long.text).toHaveLength(30_000)
  })
  test.each([
    [{ kind: 'doc', mimeType: 'application/msword', name: 'old.doc', data: b64('x') }, 'Save it as Word (.docx)'],
    [{ kind: 'doc', mimeType: 'application/zip', name: 'stuff.zip', data: b64('x') }, 'I can read photos, PDFs, Word'],
    [{ kind: 'doc', mimeType: 'text/plain', name: 'blank.txt', data: b64('  \n ') }, 'couldn’t find any text']
  ])('refuses document %o', (input, msg) => {
    expect(() => media.parseAttachment(input)).toThrow(msg)
  })
})

test('a document reaches the AI as its text, named and labelled', async () => {
  mockGenerate.mockResolvedValue(geminiText('A list of two guests: Sam (cut) and Alex (color).'))
  const att = media.parseAttachment({ kind: 'doc', mimeType: 'text/csv', name: 'party.csv', data: b64('Sam,cut\nAlex,color') })
  const r = await media.readAttachment(att, { businessName: 'Willow' })
  expect(r.summary).toMatch(/two guests/)
  const parts = mockGenerate.mock.calls[0][0]
  expect(parts[0]).toEqual({ text: 'text file "party.csv":\n\nSam,cut\nAlex,color' })
  expect(parts[1].text).toMatch(/attached this text file/)
  expect(media.withArticle(media.attachmentLabel({ kind: 'doc', docType: 'xlsx' }))).toBe('an Excel file')
  expect(media.withArticle(media.attachmentLabel({ kind: 'image' }))).toBe('a photo')
})

test('photo is read by the main Gemini model, file before the instruction', async () => {
  mockGenerate.mockResolvedValue(geminiText('Reference photo: short layered bob.'))
  const r = await media.readAttachment({ kind: 'image', mimeType: 'image/jpeg', buffer: Buffer.from('img'), name: 'x.jpg' }, { businessName: 'Willow' })
  expect(r).toEqual({ summary: 'Reference photo: short layered bob.', provider: 'gemini', model: 'gemini-3.5-flash' })
  expect(mockGetModel.mock.calls[0][0].model).toBe('gemini-3.5-flash')
  const parts = mockGenerate.mock.calls[0][0]
  expect(parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('img').toString('base64') } })
  expect(parts[1].text).toMatch(/Willow/)
})

test('PDF goes inline as application/pdf', async () => {
  mockGenerate.mockResolvedValue(geminiText("A doctor's note."))
  await media.readAttachment({ kind: 'pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7'), name: 'n.pdf' })
  expect(mockGenerate.mock.calls[0][0][0]).toMatchObject({ inlineData: { mimeType: 'application/pdf' } })
})

test('main model gone (404) → the backup model of the same provider reads it', async () => {
  mockGenerate
    .mockRejectedValueOnce(Object.assign(new Error('[404 Not Found] models/gemini-3.5-flash is not found'), { status: 404 }))
    .mockResolvedValueOnce(geminiText('Reference photo of a bob.'))
  const r = await media.readAttachment({ kind: 'image', mimeType: 'image/png', buffer: Buffer.from('img'), name: 'x.png' })
  expect(r).toEqual({ summary: 'Reference photo of a bob.', provider: 'gemini', model: 'gemini-3.5-flash-lite' })
  expect(mockGetModel.mock.calls.map(c => c[0].model)).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash-lite'])
})

test('voice note transcription retries a busy model, then succeeds', async () => {
  mockGenerate
    .mockRejectedValueOnce(new Error('[503 Service Unavailable] This model is currently experiencing high demand'))
    .mockResolvedValueOnce(geminiText('"Can I get a haircut Friday?"'))
  const r = await media.transcribeAudio({ buffer: Buffer.from('RIFF'), mimeType: 'audio/wav', durationSec: 4 })
  expect(r).toEqual({ text: 'Can I get a haircut Friday?', provider: 'gemini', model: 'gemini-3.5-flash' })
  expect(mockGenerate).toHaveBeenCalledTimes(2)
  expect(mockGenerate.mock.calls[0][0][0]).toEqual({ inlineData: { mimeType: 'audio/wav', data: Buffer.from('RIFF').toString('base64') } })
})

test('a silent voice note never reaches the model; "[no speech]" means empty', async () => {
  const { pcmToWav } = require('../services/cloudTts')
  const silent = pcmToWav(Buffer.alloc(32000), 16000)
  expect(await media.transcribeAudio({ buffer: silent, mimeType: 'audio/wav', durationSec: 1 })).toEqual({ text: '', provider: null, model: null })
  expect(mockGenerate).not.toHaveBeenCalled()

  const loud = Buffer.alloc(32000); for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(i % 64 < 32 ? 8000 : -8000, i)
  mockGenerate.mockResolvedValue(geminiText('[no speech]'))
  expect((await media.transcribeAudio({ buffer: pcmToWav(loud, 16000), mimeType: 'audio/wav' })).text).toBe('')
  expect(mockGenerate).toHaveBeenCalledTimes(1)
})

test('withRetry only retries transient errors', async () => {
  expect(isTransient(new Error('[503 Service Unavailable]'))).toBe(true)
  expect(isTransient(new Error('400 bad request'))).toBe(false)
  // A spent quota needs ~a minute; don't burn seconds retrying the same model.
  expect(isTransient(new Error('[429 Too Many Requests] You exceeded your current quota, please check your plan'))).toBe(false)
  const permanent = jest.fn().mockRejectedValue(new Error('400 bad request'))
  await expect(withRetry(permanent, { delays: [1, 1] })).rejects.toThrow('400')
  expect(permanent).toHaveBeenCalledTimes(1)
  const flaky = jest.fn().mockRejectedValueOnce(new Error('429 rate')).mockResolvedValue('ok')
  await expect(withRetry(flaky, { delays: [1] })).resolves.toBe('ok')
})
