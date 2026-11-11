// @ts-check
'use strict'

// ─── Cloud text-to-speech for the voice assistant
// Amazon Polly's Neural voices on Flow's own AWS account: no key, and no free
// tier to run out mid-demo. The voice matches the reply's language (utils/lang).
// Returns WAV (16 kHz PCM with a header), as the voice page expects. If Polly has
// no voice for the language or fails, the caller sends text only and the browser
// speaks it, in that language.
// (The India edition's Sarvam TTS lives in services/tts.js.)

const trace = require('./trace')
const log = require('../utils/logger')
const { detectLang } = require('../utils/lang')

const MAX_CHARS = 600
const RATE = 16000

// One voice per language: Neural where Polly has one. Spanish is US Spanish (the demo is in Austin).
const VOICES = {
  en: { id: 'Joanna', code: 'en-US', locale: 'en-US' },
  es: { id: 'Lupe', code: 'es-US', locale: 'es-US' },
  fr: { id: 'Lea', code: 'fr-FR', locale: 'fr-FR' },
  de: { id: 'Vicki', code: 'de-DE', locale: 'de-DE' },
  it: { id: 'Bianca', code: 'it-IT', locale: 'it-IT' },
  pt: { id: 'Camila', code: 'pt-BR', locale: 'pt-BR' },
  nl: { id: 'Laura', code: 'nl-NL', locale: 'nl-NL' },
  hi: { id: 'Kajal', code: 'hi-IN', locale: 'hi-IN' },
  ja: { id: 'Kazuha', code: 'ja-JP', locale: 'ja-JP' },
  ko: { id: 'Seoyeon', code: 'ko-KR', locale: 'ko-KR' },
  zh: { id: 'Zhiyu', code: 'cmn-CN', locale: 'zh-CN' },
  ar: { id: 'Hala', code: 'ar-AE', locale: 'ar-AE' },
  ru: { id: 'Tatyana', code: 'ru-RU', locale: 'ru-RU', engine: 'standard' }
}

function pcmToWav(pcm, rate = 24000) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

let _polly = null
function polly() {
  if (!_polly) {
    const { PollyClient } = require('@aws-sdk/client-polly')
    _polly = new PollyClient({ region: process.env.POLLY_REGION || 'us-east-1', maxAttempts: 2 })
  }
  return _polly
}

/** The browser's language tag for a reply, so its fallback voice matches too. */
function localeFor(text) {
  const lang = detectLang(text)
  return VOICES[lang]?.locale || 'en-US'
}

/**
 * @param {string} text
 * @returns {Promise<{ mimeType: string, data: string, seconds: number, lang: string } | null>}  base64 WAV, or null on failure
 */
async function synthesize(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS)
  if (!clean) return null
  const lang = detectLang(clean)
  const voice = VOICES[lang] || VOICES.en
  const t0 = Date.now()
  try {
    const { SynthesizeSpeechCommand } = require('@aws-sdk/client-polly')
    const out = await polly().send(new SynthesizeSpeechCommand({
      Text: clean, TextType: 'text', OutputFormat: 'pcm', SampleRate: String(RATE),
      VoiceId: /** @type {any} */ (voice.id), LanguageCode: /** @type {any} */ (voice.code), Engine: /** @type {any} */ (voice.engine || 'neural')
    }), { abortSignal: AbortSignal.timeout(8000) })
    const pcm = Buffer.from(await /** @type {any} */ (out.AudioStream).transformToByteArray())
    if (!pcm.length) throw new Error('Polly returned no audio')
    const wav = pcmToWav(pcm, RATE)
    const seconds = pcm.length / (RATE * 2)
    trace.event('media', `Reply spoken by Amazon Polly (${voice.id}, ${voice.code}, ${seconds.toFixed(1)}s of audio)`, { language: lang }, Date.now() - t0)
    return { mimeType: 'audio/wav', data: wav.toString('base64'), seconds: Math.round(seconds * 10) / 10, lang: voice.locale }
  } catch (err) {
    log.warn('tts_failed', { err: String(err?.message || err).slice(0, 160) })
    trace.event('media', 'Amazon Polly unavailable → the browser voice reads the reply', { reason: err?.name || 'error', language: lang }, Date.now() - t0)
    return null
  }
}

/**
 * A reply to a voice note as a voice message (Telegram plays MP3 as one): someone
 * driving asks by voice and hears the answer. Same voice choice as the voice page;
 * a language Polly has no voice for gets no audio (the text still goes).
 * @param {string} text  what to say (already without markdown)
 * @returns {Promise<{ mimeType: string, buffer: Buffer, lang: string, voice: string } | null>}
 */
async function voiceMessage(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS)
  if (!clean) return null
  const lang = detectLang(clean)
  const voice = VOICES[lang]
  if (!voice) return null
  const t0 = Date.now()
  try {
    const { SynthesizeSpeechCommand } = require('@aws-sdk/client-polly')
    const out = await polly().send(new SynthesizeSpeechCommand({
      Text: clean, TextType: 'text', OutputFormat: 'mp3', SampleRate: '24000',
      VoiceId: /** @type {any} */ (voice.id), LanguageCode: /** @type {any} */ (voice.code), Engine: /** @type {any} */ (voice.engine || 'neural')
    }), { abortSignal: AbortSignal.timeout(8000) })
    const buffer = Buffer.from(await /** @type {any} */ (out.AudioStream).transformToByteArray())
    if (!buffer.length) throw new Error('Polly returned no audio')
    trace.event('media', `Reply spoken by Amazon Polly (${voice.id}, ${voice.code}) as a voice message`, { language: lang, kb: Math.round(buffer.length / 1024) }, Date.now() - t0)
    return { mimeType: 'audio/mpeg', buffer, lang: voice.locale, voice: voice.id }
  } catch (err) {
    log.warn('tts_voice_message_failed', { err: String(err?.message || err).slice(0, 160) })
    trace.event('media', 'Amazon Polly unavailable → the reply goes as text only', { reason: err?.name || 'error', language: lang }, Date.now() - t0)
    return null
  }
}

module.exports = { synthesize, voiceMessage, pcmToWav, localeFor, VOICES }
