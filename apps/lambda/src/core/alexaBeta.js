// @ts-check
'use strict'

// ─── Self-serve Alexa beta (docs/alexa/README.md) ───────────────────
// "Flow Bookings" is a development skill, so only Amazon accounts on its beta
// test can use it, and Amazon has no public beta link: every tester is added by
// email. On the Alexa page a visitor (a judge) types the email of their Amazon
// account; Flow adds it to the beta through Amazon's Skill Management API and
// shows the invitation link, which works for that account straight away.
//
// Flow acts as the skill's developer with a Login with Amazon refresh token
// from the ASK CLI (SSM /flowhq/alexa/lwaRefreshToken), swapped here for an
// access token that lasts an hour. The full email goes to Amazon only: Flow
// keeps it masked (j***@gmail.com) on the session and in the timeline.

const crypto = require('crypto')
const trace = require('../services/trace')
const { store } = require('../services/demoStore')
const log = require('../utils/logger')

const SMAPI = 'https://api.amazonalexa.com/v1/skills'
// The ASK CLI's own Login with Amazon client (published in the ask-cli package):
// the refresh token was issued to it, so it's the one that can refresh it.
const CLI_CLIENT_ID = 'amzn1.application-oa2-client.aad322b5faab44b980c8f87f94fbac56'
const CLI_CLIENT_SECRET = '1642d8869b829dda3311d6c6539f3ead55192e3fc767b9071c888e60ef151cf9'
const MAX_PER_SESSION = 3
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/i

let cached = null   // { token, until }: the access token, kept while the Lambda is warm

const configured = () => !!(process.env.ALEXA_SKILL_ID && process.env.ALEXA_LWA_REFRESH_TOKEN)
const masked = email => require('./savedPaypal').masked(email)
// Same account added twice? Compared by a hash: masked emails can collide (jane@, john@ → j***@).
const keyOf = email => crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)

async function accessToken() {
  if (cached && cached.until > Date.now() + 60_000) return cached.token
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(process.env.ALEXA_LWA_REFRESH_TOKEN), client_id: CLI_CLIENT_ID, client_secret: CLI_CLIENT_SECRET }),
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) throw new Error(`Login with Amazon refused the refresh (${res.status})`)
  const j = await res.json()
  cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 }
  return cached.token
}

async function smapi(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${SMAPI}/${process.env.ALEXA_SKILL_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000)
  })
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { message: text.slice(0, 200) } }
  if (!res.ok) throw Object.assign(new Error(data.message || `Amazon answered ${res.status}`), { status: res.status })
  return data
}

// The skill's beta invitation link (one link for every tester: it opens Flow Bookings in
// the Alexa app for an account on the tester list). Asked of Amazon once per warm Lambda.
let invite = null   // { url, at }
async function invitationUrl() {
  if (!configured()) return null
  if (invite && Date.now() - invite.at < 6 * 3600_000) return invite.url
  try {
    const beta = await smapi('/betaTest')
    invite = { url: beta.status === 'RUNNING' ? beta.invitationUrl || null : null, at: Date.now() }
  } catch (err) {
    log.warn('alexa_beta_invite_failed', { status: err.status, err: String(err.message).slice(0, 120) })
    return invite?.url || null
  }
  return invite.url
}

/** What the Alexa page shows: whether sign-up is open here, the skill's link, and who this session added (masked). */
async function view(session) {
  const added = Array.isArray(session.alexaBeta) ? session.alexaBeta : []
  return { available: configured(), invitationUrl: await invitationUrl(), added: added.map(({ email, at, invitationUrl }) => ({ email, at, invitationUrl })) }
}

/** POST /demo/alexa/beta {email}: add an Amazon account to the beta; returns the invitation link. */
async function join(session, email) {
  if (!configured()) return { error: 'not_available', message: 'Alexa beta sign-up isn’t set up on this server.' }
  const e = String(email || '').trim().toLowerCase()
  if (e.length > 254 || !EMAIL.test(e)) return { error: 'bad_email', message: 'Enter the email of your Amazon account.' }
  const added = Array.isArray(session.alexaBeta) ? session.alexaBeta : []
  const again = added.find(a => a.key === keyOf(e))
  if (again) return { ok: true, email: again.email, invitationUrl: again.invitationUrl }
  if (added.length >= MAX_PER_SESSION) return { error: 'limit', message: `One demo session can add up to ${MAX_PER_SESSION} Amazon accounts.` }
  try {
    const beta = await smapi('/betaTest')
    if (beta.status !== 'RUNNING') return { error: 'not_available', message: 'The Alexa beta isn’t open right now.' }
    if (beta.invitesRemaining === 0) return { error: 'full', message: 'The Alexa beta is full (500 testers).' }
    await smapi('/betaTest/testers/add', { method: 'POST', body: { testers: [{ emailId: e }] } })
    const entry = { email: masked(e), key: keyOf(e), at: Date.now(), invitationUrl: beta.invitationUrl || null }
    await store().updateSession(session.sid, { alexaBeta: [...added, entry] })
    await trace.run(`sess:${session.sid}`, async () => trace.event('session', 'Amazon account added to the Alexa beta', { email: entry.email }))
    return { ok: true, email: entry.email, invitationUrl: entry.invitationUrl }
  } catch (err) {
    log.warn('alexa_beta_failed', { status: err.status, err: String(err.message).slice(0, 160) })
    return { error: 'amazon', message: 'Amazon didn’t accept that just now. Try again in a minute.' }
  }
}

module.exports = { join, view, invitationUrl, configured, MAX_PER_SESSION, _reset: () => { cached = null; invite = null } }
