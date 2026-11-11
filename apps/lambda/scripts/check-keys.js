'use strict'

// ─── Check the keys in apps/lambda/.env (docs/KEYS.md) ──────────────
// One small real call per service, then ✓ or ✗ with the reason. Never prints a
// key. The AI checks cost a fraction of a cent.
//
//   node apps/lambda/scripts/check-keys.js
//
// Like the local API, an empty ANTHROPIC_API_KEY / GOOGLE_API_KEY / REDIS_URL
// falls back to the value stored in AWS (SSM), when the AWS CLI can read it.

const { execFileSync } = require('child_process')
const { loadEnv } = require('./loadEnv')

loadEnv()
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1'

const source = {}
function ssm(name) {
  try {
    return execFileSync('aws', ['ssm', 'get-parameter', '--name', name, '--with-decryption', '--region', process.env.AWS_REGION, '--query', 'Parameter.Value', '--output', 'text'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim()
  } catch { return '' }
}
for (const [env, param] of [['ANTHROPIC_API_KEY', '/flow/anthropic/apiKey'], ['GOOGLE_API_KEY', '/flow/google/apiKey'], ['REDIS_URL', '/flow/redis/url']]) {
  if (process.env[env]) source[env] = '.env'
  else if ((process.env[env] = ssm(param))) source[env] = 'AWS'
}

const ok = (what, note = '') => console.log(`  ✓ ${what}${note ? `: ${note}` : ''}`)
const bad = (what, note) => { console.log(`  ✗ ${what}: ${note}`); process.exitCode = 1 }
const skip = (what, note) => console.log(`  – ${what}: ${note}`)
const from = env => (source[env] ? ` (key from ${source[env]})` : '')

async function json(url, opts) {
  const r = await fetch(url, opts)
  let body = {}
  try { body = await r.json() } catch {}
  return { status: r.status, ok: r.ok, body }
}

async function claude() {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return skip('Claude (the thinking)', 'no ANTHROPIC_API_KEY; Gemini will do the thinking')
  const r = await json('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.AI_MODEL && /^claude/.test(process.env.AI_MODEL) ? process.env.AI_MODEL : 'claude-haiku-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'Say OK.' }] })
  })
  if (r.ok) return ok('Claude (the thinking)', `answers, so the key works and has credit${from('ANTHROPIC_API_KEY')}`)
  const msg = String(r.body?.error?.message || '')
  if (/credit balance/i.test(msg)) return bad('Claude (the thinking)', `no credit on this account: top up at console.anthropic.com → Plans & Billing${from('ANTHROPIC_API_KEY')}`)
  if (r.status === 401) return bad('Claude (the thinking)', `the key isn't valid${from('ANTHROPIC_API_KEY')}`)
  bad('Claude (the thinking)', `HTTP ${r.status} ${msg.slice(0, 120)}`)
}

async function gemini() {
  const key = process.env.GOOGLE_API_KEY
  if (!key) return skip('Gemini (backup)', 'no GOOGLE_API_KEY; nothing falls back to Gemini')
  const H = { 'x-goog-api-key': key, 'Content-Type': 'application/json' }
  const base = 'https://generativelanguage.googleapis.com/v1beta/models'
  const why = r => (r.status === 429 ? 'free quota used up for today (resets at midnight Pacific)' : r.status === 400 || r.status === 403 ? 'the key isn\'t valid or the API isn\'t enabled' : `HTTP ${r.status}`)

  const text = await json(`${base}/gemini-3.5-flash:generateContent`, { method: 'POST', headers: H, body: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK.' }] }], generationConfig: { maxOutputTokens: 5 } }) })
  text.ok ? ok('Gemini (backup for voice notes and thinking)', `answers${from('GOOGLE_API_KEY')}`) : bad('Gemini (backup for voice notes and thinking)', `${why(text)}${from('GOOGLE_API_KEY')}`)

}

// Voice notes → text (services/speechToText.js).
async function groq() {
  const key = process.env.GROQ_API_KEY
  if (!key) return skip('Groq Whisper (voice notes)', 'no GROQ_API_KEY; Gemini transcribes voice notes instead')
  const r = await json('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } })
  if (!r.ok) return bad('Groq Whisper (voice notes)', r.status === 401 ? 'the key isn\'t valid' : `HTTP ${r.status}`)
  const has = (r.body?.data || []).some(m => m.id === (process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo'))
  has ? ok('Groq Whisper (voice notes)', 'the key works and the Whisper model is available') : bad('Groq Whisper (voice notes)', 'the key works, but the Whisper model isn\'t listed')
}

// Spoken replies (services/cloudTts.js): your AWS login, no key.
async function polly() {
  const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly')
  try {
    const c = new PollyClient({ region: process.env.POLLY_REGION || 'us-east-1' })
    const out = await c.send(new SynthesizeSpeechCommand({ Text: 'OK', OutputFormat: 'pcm', SampleRate: '16000', VoiceId: 'Joanna', Engine: 'neural' }))
    const bytes = (await out.AudioStream.transformToByteArray()).length
    bytes ? ok('Amazon Polly (spoken replies)', 'your AWS login can use it') : bad('Amazon Polly (spoken replies)', 'returned no audio')
  } catch (err) {
    bad('Amazon Polly (spoken replies)', `${err.name || 'error'}: ${String(err.message).slice(0, 100)}; the browser's built-in voice is used instead`)
  }
}

async function paypal() {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET
  if (!id || !secret) return bad('PayPal sandbox app', 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are empty')
  if ((process.env.PAYPAL_ENV || 'sandbox') !== 'sandbox') return bad('PayPal sandbox app', 'PAYPAL_ENV must be sandbox')
  const r = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }
  })
  if (!r.ok) return bad('PayPal sandbox app', r.status === 401 ? 'PayPal rejected the Client ID / Secret (are they the Sandbox ones?)' : `HTTP ${r.status}`)
  ok('PayPal sandbox app', 'PayPal accepted the Client ID and Secret')
  // What the app may do shows in its token's scopes (developer.paypal.com → the app → Features).
  const scopes = String((await r.json()).scope || '')
  ;/invoicing/.test(scopes) ? ok('PayPal Invoicing', 'switched on for the app') : bad('PayPal Invoicing', 'not switched on: the app → Features → tick Invoicing → Save (takes a few minutes)')
  ;/subscriptions/.test(scopes) ? ok('PayPal Subscriptions (memberships)', 'switched on for the app') : bad('PayPal Subscriptions (memberships)', 'not switched on: the app → Features → tick Subscriptions → Save')

  const merchantId = v => /^[A-Z0-9]{10,16}$/.test(String(v || ''))
  const v = process.env.PAYPAL_PARTNER_MERCHANT_ID
  if (!v) skip('Flow\'s Business account ID', 'PAYPAL_PARTNER_MERCHANT_ID is empty')
  else merchantId(v) ? ok('Flow\'s Business account ID', 'looks like a PayPal Account ID') : bad('Flow\'s Business account ID', 'PAYPAL_PARTNER_MERCHANT_ID doesn\'t look like a PayPal Account ID (13 letters/digits, from Sandbox Accounts → the account)')
  process.env.PAYPAL_PLATFORM_EMAIL ? ok('Flow\'s Business account login', 'used as the invoicer, and the login that shows the payments') : skip('Flow\'s Business account login', 'PAYPAL_PLATFORM_EMAIL is empty (invoices still work)')
  process.env.DEMO_BUYER_EMAIL && process.env.DEMO_BUYER_PASSWORD
    ? ok('Sandbox buyer login', 'shown to judges on the demo page')
    : skip('Sandbox buyer login', 'DEMO_BUYER_EMAIL / DEMO_BUYER_PASSWORD are empty (judges won\'t see a test login)')
}

async function redis() {
  const url = process.env.REDIS_URL
  if (!url) return skip('Redis (seat holds)', 'no REDIS_URL; seat holds use the backup store (the demo table), everything works')
  const Redis = require('ioredis')
  const c = new Redis(url, { lazyConnect: true, connectTimeout: 4000, maxRetriesPerRequest: 0, retryStrategy: () => null })
  c.on('error', () => {})
  try {
    await c.connect()
    const pong = await c.ping()
    pong === 'PONG' ? ok('Redis (seat holds)', `connected${from('REDIS_URL')}`) : bad('Redis (seat holds)', `unexpected reply ${pong}`)
  } catch (err) {
    skip('Redis (seat holds)', `can't connect (${String(err.message).slice(0, 60)}); seat holds use the backup store (the demo table), everything works${from('REDIS_URL')}`)
  } finally {
    c.disconnect()
  }
}

;(async () => {
  console.log('\nAI')
  await claude()
  await gemini()
  console.log('\nVoice')
  await groq()
  await polly()
  console.log('\nPayPal')
  await paypal()
  console.log('\nOptional')
  await redis()
  console.log(process.exitCode ? '\nSomething needs fixing (✗ above). See docs/KEYS.md.\n' : '\nAll set.\n')
})().catch(err => { console.error('check failed:', err.message); process.exit(1) })
