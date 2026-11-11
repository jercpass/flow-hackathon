'use strict'

// Voice providers: Groq's Whisper hears voice
// notes with Gemini as its backup; Amazon Polly speaks voice-page replies in
// the reply's language. Groq (fetch), Polly and Gemini are mocked.

const mockSend = jest.fn()
jest.mock('@aws-sdk/client-polly', () => ({
  PollyClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  SynthesizeSpeechCommand: jest.fn().mockImplementation(input => ({ input }))
}))
jest.mock('../services/ai', () => ({
  transcribe: jest.fn(),
  models: jest.fn(() => ({ main: 'gemini-3.5-flash', backup: 'gemini-3.5-flash-lite' })),
  errorReason: jest.fn(err => (err?.status ? `HTTP ${err.status}` : 'error'))
}))

const trace = require('../services/trace')
const ai = require('../services/ai')
const stt = require('../services/speechToText')
const tts = require('../services/cloudTts')
const { detectLang } = require('../utils/lang')

const events = []
const realFetch = global.fetch
beforeEach(() => {
  jest.clearAllMocks()
  events.length = 0
  jest.spyOn(trace, 'event').mockImplementation((kind, title, detail) => { events.push({ kind, title, detail }) })
  process.env.GROQ_API_KEY = 'gsk_test'
  process.env.GOOGLE_API_KEY = 'g'
  global.fetch = jest.fn()
})
afterAll(() => { global.fetch = realFetch })

const groqReply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body })

describe('the reply language', () => {
  test.each([
    ['Ana has 11 AM open on Monday. Shall I book it?', 'en'],
    ['¡Claro! Ana tiene una cita libre el lunes a las 11. ¿Quieres que la reserve?', 'es'],
    ['Bonjour ! Ana est libre lundi à 11 h. Voulez-vous que je réserve ?', 'fr'],
    ['Ana hat am Montag um 11 Uhr einen Termin frei. Soll ich ihn für Sie buchen?', 'de'],
    ['Ana tem um horário livre na segunda às 11. Quer que eu reserve para você?', 'pt'],
    ['Ana ha un appuntamento libero lunedì alle 11. Vuoi che lo prenoti?', 'it'],
    ['आना सोमवार को 11 बजे खाली हैं। क्या मैं बुक कर दूँ?', 'hi'],
    ['アナさんは月曜日の11時が空いています。予約しますか？', 'ja'],
    ['安娜周一上午11点有空。要我帮你预约吗？', 'zh'],
    ['아나는 월요일 11시에 시간이 있어요. 예약할까요?', 'ko'],
    ['آنا متاحة يوم الاثنين الساعة 11. هل أحجز لك؟', 'ar'],
    ['', 'en']
  ])('%s → %s', (text, lang) => {
    expect(detectLang(text)).toBe(lang)
  })
})

describe('voice notes → text', () => {
  test('Groq Whisper first: the file, the model and verbose JSON; it tells us the language', async () => {
    global.fetch.mockResolvedValue(groqReply({ text: ' Quiero un corte el sábado ', language: 'spanish', segments: [{ no_speech_prob: 0.02 }] }))
    const r = await stt.transcribe({ buffer: Buffer.from('OggS'), mimeType: 'audio/ogg' })
    expect(r).toEqual({ text: 'Quiero un corte el sábado', provider: 'groq', model: 'whisper-large-v3-turbo', language: 'spanish' })
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(opts.headers.Authorization).toBe('Bearer gsk_test')
    expect(opts.body.get('model')).toBe('whisper-large-v3-turbo')
    expect(opts.body.get('response_format')).toBe('verbose_json')
    expect(opts.body.get('file').name).toBe('voice.ogg')
    expect(stt.label(r)).toBe('Whisper Large v3 Turbo on Groq')
    expect(ai.transcribe).not.toHaveBeenCalled()
  })

  test('silence: when Whisper says every segment is probably not speech, the text is empty', async () => {
    global.fetch.mockResolvedValue(groqReply({ text: 'Thank you for watching.', segments: [{ no_speech_prob: 0.92 }, { no_speech_prob: 0.88 }] }))
    expect((await stt.transcribe({ buffer: Buffer.from('OggS'), mimeType: 'audio/ogg' })).text).toBe('')
  })

  test('Groq down → Gemini transcribes, and the timeline says so', async () => {
    global.fetch.mockResolvedValue(groqReply({ error: { message: 'Service Unavailable' } }, 503))
    ai.transcribe.mockResolvedValue({ text: '"Book me a haircut"', provider: 'gemini', model: 'gemini-3.5-flash' })
    const r = await stt.transcribe({ buffer: Buffer.from('RIFF'), mimeType: 'audio/wav' })
    expect(r).toMatchObject({ text: 'Book me a haircut', provider: 'gemini' })
    expect(global.fetch).toHaveBeenCalledTimes(2)   // one retry on a 503
    expect(events.map(e => e.title)).toContain('Groq unavailable → Gemini 3.5 Flash transcribes')
    expect(stt.label(r)).toBe('Gemini 3.5 Flash')
  })

  test('no Groq key: Gemini, as before; "[no speech]" means empty', async () => {
    delete process.env.GROQ_API_KEY
    ai.transcribe.mockResolvedValue({ text: '[no speech]', provider: 'gemini', model: 'gemini-3.5-flash' })
    expect((await stt.transcribe({ buffer: Buffer.from('RIFF'), mimeType: 'audio/wav' })).text).toBe('')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('a bad Groq key with no Gemini to fall back on is an error', async () => {
    delete process.env.GOOGLE_API_KEY
    global.fetch.mockResolvedValue(groqReply({ error: { message: 'Invalid API Key' } }, 401))
    await expect(stt.transcribe({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' })).rejects.toThrow('Groq HTTP 401')
  })
})

describe('spoken replies', () => {
  const pcm = Buffer.alloc(32000)   // one second of 16 kHz, 16-bit audio
  const pollyReturns = buf => mockSend.mockResolvedValue({ AudioStream: { transformToByteArray: async () => new Uint8Array(buf) } })

  test('Polly speaks a Spanish reply with a Spanish Neural voice, as WAV', async () => {
    pollyReturns(pcm)
    const r = await tts.synthesize('¡Claro! Ana tiene una cita libre el lunes a las 11. ¿Quieres que la reserve?')
    const input = mockSend.mock.calls[0][0].input
    expect(input).toMatchObject({ VoiceId: 'Lupe', LanguageCode: 'es-US', Engine: 'neural', OutputFormat: 'pcm', SampleRate: '16000' })
    expect(r).toMatchObject({ mimeType: 'audio/wav', seconds: 1, lang: 'es-US' })
    const wav = Buffer.from(r.data, 'base64')
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(events[0].title).toBe('Reply spoken by Amazon Polly (Lupe, es-US, 1.0s of audio)')
  })

  test('English by default; Hindi by its script', async () => {
    pollyReturns(pcm)
    await tts.synthesize('Ana has 11 AM open on Monday.')
    await tts.synthesize('आना सोमवार को 11 बजे खाली हैं।')
    expect(mockSend.mock.calls.map(c => c[0].input.VoiceId)).toEqual(['Joanna', 'Kajal'])
  })

  test('Polly fails → no audio, so the browser reads it, told the language', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }))
    const text = 'Bonjour ! Ana est libre lundi à 11 h. Voulez-vous que je réserve ?'
    expect(await tts.synthesize(text)).toBeNull()
    expect(events[0]).toMatchObject({ title: 'Amazon Polly unavailable → the browser voice reads the reply', detail: { reason: 'AccessDeniedException', language: 'fr' } })
    expect(tts.localeFor(text)).toBe('fr-FR')
  })

  test('nothing to say → no call', async () => {
    expect(await tts.synthesize('   ')).toBeNull()
    expect(mockSend).not.toHaveBeenCalled()
  })

  test('a voice message (Telegram): MP3 in the reply\'s language, and the timeline says so', async () => {
    pollyReturns(Buffer.from('ID3mp3'))
    const r = await tts.voiceMessage('¿Pago $18 con tu PayPal guardado?')
    expect(mockSend.mock.calls[0][0].input).toMatchObject({ VoiceId: 'Lupe', LanguageCode: 'es-US', OutputFormat: 'mp3', Engine: 'neural' })
    expect(r).toMatchObject({ mimeType: 'audio/mpeg', lang: 'es-US', voice: 'Lupe' })
    expect(r.buffer.toString()).toBe('ID3mp3')
    expect(events[0].title).toBe('Reply spoken by Amazon Polly (Lupe, es-US) as a voice message')
    mockSend.mockRejectedValue(new Error('throttled'))
    expect(await tts.voiceMessage('Free parking behind the building.')).toBeNull()
    expect(events[1].title).toBe('Amazon Polly unavailable → the reply goes as text only')
  })
})
