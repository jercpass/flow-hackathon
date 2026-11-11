// @ts-check
'use strict'

// ─── Customer media: voice notes, photos, PDFs, documents ─────────────────────
// What a customer sends in chat is turned into text the booking AI can use:
//   • voice note → transcript (Groq's Whisper, Gemini as backup; the browser sends 16 kHz mono WAV)
//   • photo / PDF → a short, booking-relevant summary from the configured AI
//     provider (services/ai), which also handles retries and the backup model
//   • Word / Excel / text file → its text (services/docText), then the same summary
// Files are processed in memory and never stored. Each step lands on the
// "Under the hood" timeline.

const trace = require('./trace')
const ai = require('./ai')
const docs = require('./docText')

// Limits every channel shares (web chat, Telegram). The web chat checks them
// first too (dashboard lib/media.js), so people hear them before uploading.
const MAX_VOICE_SECONDS = 60
const MAX_FILE_MB = 4
const MAX_DOC_CHARS = 30_000     // what the AI reads of a long document
const LIMITS = {
  audio: 3_000_000,    // ~90 s of 16 kHz mono WAV (the duration check comes first)
  image: MAX_FILE_MB * 1_000_000,
  pdf:   MAX_FILE_MB * 1_000_000,
  doc:   MAX_FILE_MB * 1_000_000
}
const VOICE_TOO_LONG = `Voice notes can be up to ${MAX_VOICE_SECONDS / 60} minute. Send a shorter one, or type it.`
const FILE_TOO_BIG = `That file is too large (max ${MAX_FILE_MB} MB).`

const MIME = {
  audio: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/flac'],
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  pdf:   ['application/pdf']
}

class MediaError extends Error {
  constructor(message) { super(message); this.code = 'MEDIA_INVALID' }
}

/**
 * Validate an uploaded attachment and decode it. A document's text is pulled
 * out here, so an unreadable file is the customer's error, not a busy AI.
 * @param {{ kind?: string, mimeType?: string, data?: string, name?: string, durationSec?: number }} a
 * @returns {{ kind: 'audio'|'image'|'pdf'|'doc', mimeType: string, buffer: Buffer, name: string, durationSec: number|null, docType?: string, text?: string, truncated?: boolean }}
 */
function parseAttachment(a) {
  const kind = a?.kind
  if (kind !== 'audio' && kind !== 'image' && kind !== 'pdf' && kind !== 'doc') throw new MediaError('Unsupported attachment type.')
  const mimeType = String(a.mimeType || '').toLowerCase().split(';')[0].trim()
  const docType = kind === 'doc' ? docs.docTypeOf(a.name, mimeType) : null
  if (kind === 'doc' ? !docType : !MIME[kind].includes(mimeType)) throw new MediaError(kind === 'doc' ? docs.unsupportedMessage(a.name) : `That ${kind === 'pdf' ? 'file' : kind} format isn't supported.`)
  const durationSec = Number.isFinite(Number(a.durationSec)) ? Math.round(Number(a.durationSec)) : null
  if (kind === 'audio' && durationSec != null && durationSec > MAX_VOICE_SECONDS + 1) throw new MediaError(VOICE_TOO_LONG)
  const data = String(a.data || '')
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw new MediaError('The attachment was empty or corrupted.')
  const buffer = Buffer.from(data, 'base64')
  if (!buffer.length) throw new MediaError('The attachment was empty.')
  if (buffer.length > LIMITS[kind]) throw new MediaError(kind === 'audio' ? VOICE_TOO_LONG : FILE_TOO_BIG)
  if (kind === 'pdf' && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new MediaError('That file is not a valid PDF.')
  const name = String(a.name || (kind === 'audio' ? 'voice-note' : kind)).replace(/[^\w .()-]/g, '').slice(0, 80) || kind
  if (kind !== 'doc') return { kind, mimeType, buffer, name, durationSec }
  const text = docs.extractText(buffer, /** @type {'docx'|'xlsx'|'text'} */ (docType))
  if (!text) throw new MediaError('I couldn’t find any text in that file.')
  return { kind, mimeType, buffer, name, durationSec: null, docType, text: text.slice(0, MAX_DOC_CHARS), truncated: text.length > MAX_DOC_CHARS }
}

// ── Voice notes ──────────────────────────────────────────────────────────────

// Peak level of a 16-bit PCM WAV, or null for anything else.
function wavPeak(buffer) {
  if (buffer.length < 44 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null
  if (buffer.readUInt16LE(20) !== 1 || buffer.readUInt16LE(34) !== 16) return null
  for (let off = 12; off + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(off + 4)
    if (buffer.toString('latin1', off, off + 4) === 'data') {
      let peak = 0
      for (let i = off + 8, end = Math.min(buffer.length, off + 8 + size); i + 1 < end; i += 2) peak = Math.max(peak, Math.abs(buffer.readInt16LE(i)))
      return peak
    }
    off += 8 + size + (size % 2)
  }
  return null
}

const SILENCE_PEAK = 300      // ≈ -40 dBFS: nothing louder than a quiet noise floor

async function transcribeAudio({ buffer, mimeType, durationSec, hint }) {
  const t0 = Date.now()
  // Models can invent words for a silent clip (Gemini 3.5 Flash once returned a
  // French sentence for pure silence), so a near-silent WAV is never sent.
  const peak = wavPeak(buffer)
  if (peak !== null && peak < SILENCE_PEAK) {
    trace.event('media', 'Voice note was silent → not sent to the AI', { peak })
    return { text: '', provider: null, model: null }
  }
  // Groq's Whisper, or Gemini as its backup (services/speechToText).
  const stt = require('./speechToText')
  const r = await stt.transcribe({ buffer, mimeType, hint })
  trace.event('media', `Voice note${durationSec ? ` (${durationSec}s)` : ''} → transcribed by ${stt.label(r)}`, { transcript: r.text.slice(0, 160), ...(r.language ? { language: r.language } : {}) }, Date.now() - t0)
  return { text: r.text, provider: r.provider, model: r.model }
}

// ── Photos, PDFs & documents ─────────────────────────────────────────────────

/** "voice note", "photo", "PDF", "Word file", "Excel file" or "text file". */
function attachmentLabel({ kind, docType }) {
  return kind === 'audio' ? 'voice note' : kind === 'pdf' ? 'PDF' : kind === 'doc' ? docs.LABEL[docType] || 'file' : 'photo'
}

/** The label with its article: "an Excel file", "a photo". */
const withArticle = label => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`

function readerPrompt(what, businessName) {
  return `A customer of ${businessName || 'a small business'} attached this ${what} in a booking chat. ` +
    'In one to three short sentences, describe only what matters for booking an appointment (for example: a reference hairstyle, a requested treatment, a doctor\'s note, an insurance or membership card, a voucher, a list of people or services to book). ' +
    'Do not invent details. Never repeat card numbers, ID numbers or other sensitive numbers — say what kind of document it is instead.'
}

async function readAttachment(att, { businessName } = {}) {
  const { kind, buffer, mimeType, name } = att
  const t0 = Date.now()
  const label = attachmentLabel(att)
  // Word, Excel and text files go to the AI as their text; photos and PDFs as the file itself.
  const file = kind === 'doc'
    ? { text: `${label} "${name}"${att.truncated ? ` (the first ${MAX_DOC_CHARS.toLocaleString('en-US')} characters)` : ''}:\n\n${att.text}` }
    : { data: buffer, mimeType }
  const r = await ai.generate({ area: 'media', parts: [file, { text: readerPrompt(kind === 'pdf' ? 'PDF document' : label, businessName) }] })
  const title = kind === 'photo' || kind === 'image' ? 'Photo' : `${kind === 'pdf' ? 'PDF' : label.charAt(0).toUpperCase() + label.slice(1)} "${name}"`
  trace.event('media', `${title} → read by ${ai.modelLabel(r.model)}`, { summary: r.text.slice(0, 200), ...(kind === 'doc' ? { characters: att.text.length, cut: !!att.truncated } : {}) }, Date.now() - t0)
  return { summary: r.text, provider: r.provider, model: r.model }
}

module.exports = { parseAttachment, transcribeAudio, readAttachment, attachmentLabel, withArticle, MediaError, LIMITS, MAX_VOICE_SECONDS, MAX_FILE_MB }
