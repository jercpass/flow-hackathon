// @ts-check
'use strict'

// ─── Voice notes → text ───────────────────
// Groq's Whisper first: free, fast, any language, over plain HTTP. If Groq has
// no key or fails, Gemini transcribes as before, so a voice note still works.
// Claude can't take audio, so it gets the transcript.

const trace = require('./trace')
const ai = require('./ai')
const log = require('../utils/logger')
const { withRetry } = require('../utils/retry')
const { modelName } = require('../utils/modelName')

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo'
const GROQ_TIMEOUT_MS = 12000
// Whisper's own "nothing was said" signal for a segment; above this, it's silence or noise.
const NO_SPEECH_PROB = 0.6
const NO_SPEECH = '[no speech]'

// Whisper reads the format from the file name.
const EXT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/aac': 'm4a', 'audio/flac': 'flac', 'audio/webm': 'webm' }

async function groq({ buffer, mimeType, hint }) {
  const body = await withRetry(async () => {
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimeType }), `voice.${EXT[mimeType] || 'wav'}`)
    form.append('model', GROQ_MODEL)
    form.append('response_format', 'verbose_json')
    form.append('temperature', '0')
    // The customer's name as a spelling hint, so the transcript spells it as the name vault does (services/pii).
    if (hint) form.append('prompt', String(hint).slice(0, 200))
    const r = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form, signal: AbortSignal.timeout(GROQ_TIMEOUT_MS) })
    const json = await r.json().catch(() => ({}))
    if (!r.ok) throw Object.assign(new Error(`Groq HTTP ${r.status} ${json?.error?.message || ''}`.trim()), { status: r.status })
    return json
  }, { delays: [500] })
  const segments = Array.isArray(body.segments) ? body.segments : []
  const silent = segments.length > 0 && segments.every(s => Number(s.no_speech_prob) > NO_SPEECH_PROB)
  return { text: silent ? '' : String(body.text || '').trim(), provider: 'groq', model: GROQ_MODEL, language: body.language || null }
}

async function gemini({ buffer, mimeType }) {
  const r = await ai.transcribe({
    data: buffer,
    mimeType,
    prompt: `Transcribe this voice message from a customer to a small business, word for word, in the language spoken. Return only the transcript. If no words are clearly spoken, return exactly ${NO_SPEECH} and never guess.`
  })
  const raw = r.text.replace(/^"|"$/g, '').trim()
  return { text: raw.toLowerCase() === NO_SPEECH ? '' : raw, provider: r.provider, model: r.model, language: null }
}

/** What the timeline calls the transcriber: "Whisper Large v3 Turbo on Groq", "Gemini 3.5 Flash". */
const label = r => (r.provider === 'groq' ? `${modelName(r.model)} on Groq` : modelName(r.model))

/**
 * @param {{ buffer: Buffer, mimeType: string }} audio
 * @returns {Promise<{ text: string, provider: string|null, model: string|null, language: string|null }>}
 */
async function transcribe(audio) {
  if (process.env.GROQ_API_KEY) {
    try {
      return await groq(audio)
    } catch (err) {
      log.warn('groq_stt_failed', { status: err?.status, message: String(err?.message || '').slice(0, 160) })
      if (!process.env.GOOGLE_API_KEY) throw err
      trace.event('media', `Groq unavailable → ${modelName(ai.models('gemini').main)} transcribes`, { reason: ai.errorReason(err) })
    }
  }
  return gemini(audio)
}

module.exports = { transcribe, label }
