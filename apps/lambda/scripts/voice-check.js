'use strict'

// ─── Does the voice say what the screen says? ─────────────────────────────────
// Transcribes audio back to text and compares the words.
//
//   node scripts/voice-check.js            the guided demo's clips (public/demo/voice):
//                                          each WAV against its text in clips.json.
//                                          Run it after replacing a clip with your own audio.
//   node scripts/voice-check.js --replies  the assistant's voice: sample replies are
//                                          spoken (services/cloudTts) and transcribed back.
//
// A clip passes when at least 90% of its words are heard and under 10% of what's
// heard is extra. Needs GOOGLE_API_KEY
// (apps/lambda/.env, else SSM /flow/google/apiKey, as demo-assets.js does).

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
process.env.TRACE_STORE = 'memory'

const VOICE_DIR = path.join(__dirname, '..', '..', 'dashboard', 'public', 'demo', 'voice')
const PASS = 0.9

// Replies like the assistant's: times, money, a question it might be tempted to answer.
const SAMPLE_REPLIES = [
  'Ana has 11 AM open on Monday, October 26. Shall I book a Haircut with her at Willow & Co. Salon for $40?',
  'Is there parking? Yes, there are four free spots behind the salon, and street parking on Elizabeth Street.',
  'Your haircut on Sunday at 2:30 PM is cancelled. The refund is $40, back to your PayPal in a few days.',
  'Would you like me to book it? Say yes and I will pay with your saved PayPal.'
]

// Spelling the transcriber may choose differently: "a.m.", "26th", "$40", "&".
const words = s => String(s || '').toLowerCase()
  .replace(/&/g, ' and ').replace(/\$(\d+)/g, '$1 dollars').replace(/(\d+):(\d\d)/g, '$1 $2')
  .replace(/\b([ap])\.\s?m\.?/g, '$1m').replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
  .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)

function overlap(a, b) {
  const pool = new Map()
  for (const w of b) pool.set(w, (pool.get(w) || 0) + 1)
  let hit = 0
  for (const w of a) if (pool.get(w)) { hit++; pool.set(w, pool.get(w) - 1) }
  return hit
}

/** Share of the expected words heard, and share of what was heard that was expected (order ignored). */
function heard(expected, transcript) {
  const want = words(expected)
  const got = words(transcript)
  const hit = overlap(want, got)
  return { found: want.length ? hit / want.length : 1, extra: got.length ? 1 - hit / got.length : 0 }
}

async function check(label, expected, buffer) {
  const { transcribeAudio } = require('../src/services/media')
  const { text } = await transcribeAudio({ buffer, mimeType: 'audio/wav' })
  const { found, extra } = heard(expected, text)
  // Every word said, and nothing added (a read-out instruction, an answer to the text).
  const ok = found >= PASS && extra <= 1 - PASS
  console.log(`${ok ? '✓' : '✗'} ${label}  ${Math.round(found * 100)}% of the words heard, ${Math.round(extra * 100)}% extra`)
  if (!ok) console.log(`    expected: ${expected}\n    heard:    ${text}`)
  return ok
}

async function main() {
  let failed = 0
  if (process.argv.includes('--replies')) {
    const { synthesize } = require('../src/services/cloudTts')
    for (const [i, text] of SAMPLE_REPLIES.entries()) {
      const audio = await synthesize(text)
      if (!audio) { console.log(`✗ reply ${i + 1}: the voice service didn't answer`); failed++; continue }
      if (!await check(`reply ${i + 1}`, text, Buffer.from(audio.data, 'base64'))) failed++
    }
  } else {
    const clips = JSON.parse(fs.readFileSync(path.join(VOICE_DIR, 'clips.json'), 'utf8'))
    for (const c of clips) {
      const file = path.join(VOICE_DIR, path.basename(c.src))
      if (!fs.existsSync(file)) { console.log(`✗ ${c.id}: ${path.basename(c.src)} is missing`); failed++; continue }
      if (!await check(`${c.id} (${c.voice || 'audio'})`, c.text, fs.readFileSync(file))) failed++
    }
  }
  if (failed) { console.error(`${failed} didn't match`); process.exitCode = 1 } else console.log('All match.')
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1 })

module.exports = { heard, words }
