'use strict'

// ─── Guided demo assets ───────────────────────────────────────────────────────
// Writes the files the guided demo serves as static assets from the dashboard
//:
//   apps/dashboard/public/demo/docs/<id>.txt|pdf   the sample salon documents
//   apps/dashboard/public/demo/voice/<id>.wav      pre-recorded customer clips
//   apps/dashboard/public/demo/voice/clips.json    their transcripts + lengths
// The clips are spoken once, word for word from their text, so judges can listen,
// read and send them as real voice notes instead of acting out a booking.
//
//   node scripts/demo-assets.js                 (keeps natural-voice clips that match their text)
//   node scripts/demo-assets.js --force         (re-records every clip)
//   node scripts/demo-assets.js --clips-only    (leaves the sample documents alone)
// Voice, in order: Groq's Orpheus (GROQ_API_KEY; voice DEMO_CLIP_GROQ_VOICE, default
// "troy", a man's voice unlike the assistant's), then Gemini TTS (GOOGLE_API_KEY),
// then Windows' built-in voice as a placeholder ("voice": "windows" in clips.json).

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { loadEnv } = require('./loadEnv')

loadEnv()
if (!process.env.GOOGLE_API_KEY) {
  try {
    process.env.GOOGLE_API_KEY = execFileSync('aws', ['ssm', 'get-parameter', '--name', '/flow/google/apiKey', '--with-decryption',
      '--region', process.env.AWS_REGION || 'ap-south-1', '--query', 'Parameter.Value', '--output', 'text'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {}
}

const PUBLIC = path.join(__dirname, '..', '..', 'dashboard', 'public', 'demo')
const FORCE = process.argv.includes('--force')
const CLIPS_ONLY = process.argv.includes('--clips-only')
const GROQ_VOICE = process.env.DEMO_CLIP_GROQ_VOICE || 'troy'
// A different voice from the assistant's (Kore), so it's clear who is talking.
const CUSTOMER_VOICE = process.env.DEMO_CLIP_VOICE || 'Puck'

// Where each clip is used: the web chat script card or the voice assistant.
const CLIPS = [
  { id: 'chat-question', use: 'chat', label: 'Ask about parking and colour', text: 'Quick question before my appointment. Is there parking? And I might add colour next time. Is there anything I need to do first?' },
  { id: 'chat-cancel', use: 'chat', label: 'Cancel the booking', text: 'Hey, something came up. I need to cancel my haircut.' },
  { id: 'va-bookings', use: 'voice', label: 'What have I got booked?', text: 'What bookings do I have coming up?' },
  { id: 'va-book', use: 'voice', label: 'Book my usual for Sunday', text: 'Book my usual haircut at Willow for Sunday at eleven in the morning.' },
  { id: 'va-parking', use: 'voice', label: 'Ask about parking', text: 'Is there parking at Willow and Co?' }
]

async function writeDocs() {
  const { DOCS, docFile } = require('../src/demo/setupDocs')
  const dir = path.join(PUBLIC, 'docs')
  fs.mkdirSync(dir, { recursive: true })
  for (const d of DOCS) {
    const file = await docFile(d.id)
    const out = path.join(dir, `${d.id}.${d.kind === 'pdf' ? 'pdf' : 'txt'}`)
    fs.writeFileSync(out, file.buffer)
    console.log(`doc   ${path.relative(process.cwd(), out)} (${file.buffer.length} bytes)`)
  }
}

async function writeClips() {
  process.env.TTS_VOICE = CUSTOMER_VOICE
  const { synthesize } = require('../src/services/cloudTts')
  const dir = path.join(PUBLIC, 'voice')
  fs.mkdirSync(dir, { recursive: true })
  const manifestPath = path.join(dir, 'clips.json')
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : []
  const manifest = []
  let failed = 0

  for (const c of CLIPS) {
    const file = path.join(dir, `${c.id}.wav`)
    const old = previous.find(p => p.id === c.id)
    const current = old && old.text === c.text && fs.existsSync(file)
    // Natural-voice clips are kept; placeholders get another try.
    if (!FORCE && current && old.voice !== 'windows') {
      manifest.push(old)
      console.log(`clip  ${c.id}: kept`)
      continue
    }
    const groq = await groqSpeak(c.text)
    if (groq) {
      fs.writeFileSync(file, groq)
      manifest.push({ ...c, src: `/demo/voice/${c.id}.wav`, seconds: wavSeconds(groq), voice: `groq-orpheus-${GROQ_VOICE}` })
      console.log(`clip  ${c.id}: ${wavSeconds(groq)}s (Groq Orpheus, ${GROQ_VOICE})`)
      continue
    }
    const audio = process.env.GOOGLE_API_KEY ? await synthesize(c.text) : null
    if (!audio && current) {
      manifest.push(old)
      console.log(`clip  ${c.id}: Gemini TTS unavailable, kept the ${old.voice} placeholder`)
      continue
    }
    if (audio) {
      fs.writeFileSync(file, Buffer.from(audio.data, 'base64'))
      manifest.push({ ...c, src: `/demo/voice/${c.id}.wav`, seconds: audio.seconds, voice: 'gemini' })
      console.log(`clip  ${c.id}: ${audio.seconds}s (Gemini TTS)`)
    } else if (windowsVoice(c.text, file)) {
      manifest.push({ ...c, src: `/demo/voice/${c.id}.wav`, seconds: wavSeconds(fs.readFileSync(file)), voice: 'windows' })
      console.log(`clip  ${c.id}: Gemini TTS unavailable, recorded with the Windows voice (placeholder)`)
      continue
    } else { console.error(`clip  ${c.id}: no TTS available; run again later`); failed++; continue }
    // Stay well inside the TTS per-minute quota.
    await new Promise(r => setTimeout(r, 7000))
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return failed
}

// Groq's Orpheus text-to-speech (WAV, up to 200 characters), or null if unavailable.
async function groqSpeak(text) {
  if (!process.env.GROQ_API_KEY || text.length > 200) return null
  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'canopylabs/orpheus-v1-english', voice: GROQ_VOICE, input: text, response_format: 'wav' }),
      signal: AbortSignal.timeout(30000)
    })
    if (!res.ok) { console.error(`groq  ${res.status}: ${(await res.text()).slice(0, 160)}`); return null }
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > 1000 ? buf : null
  } catch (err) {
    console.error(`groq  ${String(err.message).slice(0, 160)}`)
    return null
  }
}

// Offline placeholder: System.Speech (Windows only). Text goes in through an
// environment variable so nothing needs quoting.
function windowsVoice(text, file) {
  if (process.platform !== 'win32') return false
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.SetOutputToWaveFile($env:CLIP_FILE); $s.Speak($env:CLIP_TEXT); $s.Dispose()'],
    { env: { ...process.env, CLIP_FILE: file, CLIP_TEXT: text }, stdio: 'ignore', timeout: 30000 })
    return fs.existsSync(file) && fs.statSync(file).size > 1000
  } catch {
    return false
  }
}

// Length from the WAV header: the data chunk's size over the byte rate.
function wavSeconds(buf) {
  const rate = buf.readUInt32LE(28) || 32000
  let at = 12, data = buf.length - 44
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    if (id === 'data') { data = Math.min(size, buf.length - at - 8); break }
    at += 8 + size
  }
  return Math.round((data / rate) * 10) / 10
}

;(async () => {
  if (!CLIPS_ONLY) await writeDocs()
  const failed = await writeClips()
  if (failed) { console.error(`${failed} clip(s) missing`); process.exitCode = 1 }
})()
