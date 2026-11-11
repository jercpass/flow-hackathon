// @ts-check
'use strict'

// ─── Alexa skill "Flow Bookings" ─────────────────
// A thin adapter: Alexa's request becomes a Flow Voice request (core/voice), so
// the AI, tools, PayPal and timeline are the browser voice assistant's. The
// conversation rides in Alexa's session attributes, as Flow Voice expects.
//
// Who's speaking: the first time, Alexa asks for the 4-digit code shown on the
// customer side ("Talk on Alexa"). The code ties this Alexa user to the demo
// session and its customer until the session ends (simpler than OAuth linking).
//
// Payments by voice follow the voice assistant's rules: within the AI spending
// allowance with saved PayPal it pays at once; otherwise it asks for a yes, or
// sends the PayPal link to the Flow inbox.

const crypto = require('crypto')
const demo = require('./demoSession')
const voice = require('./voice')
const trace = require('../services/trace')
const { store } = require('../services/demoStore')
const log = require('../utils/logger')

const SKILL_NAME = 'Flow Bookings'
const userKey = userId => `ALX#${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)}`

// ── Linking ──────────────────────────────────────────────────────────────────

// Linked: when, and as whom (the customer side's "Linked as John Doe"); false until then.
const linkedView = session => session.alexa ? { at: session.alexa.linkedAt, as: session.customerName || null } : false

/** The session's 4-digit code (unique among live codes) and whether Alexa is linked. */
async function codeFor(session) {
  if (session.alexaCode) {
    const rec = await store().getKey(`ALXCODE#${session.alexaCode}`, 'C')
    if (rec?.owner === session.sid) return { code: session.alexaCode, linked: linkedView(session), skill: SKILL_NAME }
  }
  for (let i = 0; i < 30; i++) {
    const code = String(crypto.randomInt(1000, 10000))
    const claim = await store().claimKey(`ALXCODE#${code}`, 'C', session.sid, session.expiresAt)
    if (claim.claimed) {
      await store().updateSession(session.sid, { alexaCode: code })
      return { code, linked: linkedView(session), skill: SKILL_NAME }
    }
  }
  throw new Error('No free Alexa code')
}

/**
 * What the customer side shows under "Talk on Alexa": nothing until the skill
 * exists (its id is set), since the skill only ever calls the deployed Lambda.
 */
async function status(session) {
  if (!process.env.ALEXA_SKILL_ID) return { configured: false, skill: SKILL_NAME }
  return { configured: true, ...(await codeFor(session)), beta: await require('./alexaBeta').view(session) }
}

/** Tie this Alexa user to the session whose code they said. */
async function link(userId, code) {
  const c = String(code || '').replace(/\D/g, '')
  if (!/^\d{4}$/.test(c)) return null
  const rec = await store().getKey(`ALXCODE#${c}`, 'C')
  const session = rec?.owner ? await demo.getActiveSession(rec.owner) : null
  if (!session) return null
  await store().putKey(userKey(userId), 'U', { sid: session.sid }, session.expiresAt)
  // user: which Alexa user record to delete on Unlink.
  await store().updateSession(session.sid, { alexa: { linkedAt: Date.now(), user: userKey(userId) } })
  await trace.run(`sess:${session.sid}`, async () => trace.event('session', 'Alexa linked to this session', { skill: SKILL_NAME }))
  return session
}

/** Unlink (DELETE /demo/alexa): Alexa asks for the code again next time. */
async function unlink(session) {
  if (session.alexa?.user) await store().deleteKey(session.alexa.user, 'U')
  await store().updateSession(session.sid, { alexa: null })
  await trace.run(`sess:${session.sid}`, async () => trace.event('session', 'Alexa unlinked from this session', { skill: SKILL_NAME }))
}

// A session that was unlinked no longer answers to that Alexa user, even if its
// user record (linked before Unlink existed) is still there.
async function sessionFor(userId) {
  const rec = userId ? await store().getKey(userKey(userId), 'U') : null
  const session = rec?.sid ? await demo.getActiveSession(rec.sid) : null
  return session?.alexa ? session : null
}

// ── Requests ─────────────────────────────────────────────────────────────────

function say(text, { reprompt, end = false, card, attributes = {} } = {}) {
  return {
    version: '1.0',
    sessionAttributes: attributes,
    response: {
      outputSpeech: { type: 'PlainText', text: String(text || '').slice(0, 7000) },
      ...(card ? { card: { type: 'Simple', title: card.title || SKILL_NAME, content: String(card.text || '').slice(0, 7000) } } : {}),
      ...(reprompt ? { reprompt: { outputSpeech: { type: 'PlainText', text: reprompt } } } : {}),
      shouldEndSession: !!end
    }
  }
}

const ASK_CODE = 'Welcome to Flow. To get started, say the four digit code on the Alexa page of your Flow demo. For example: my code is one two three four.'

// Alexa's intent → a Flow Voice request type (and the words, for "say").
function voiceRequest(req) {
  if (req.type === 'LaunchRequest') return { type: 'start' }
  if (req.type === 'SessionEndedRequest') return { type: 'end' }
  const intent = req.intent?.name
  if (intent === 'AMAZON.HelpIntent') return { type: 'help' }
  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') return { type: 'stop' }
  if (intent === 'ChatIntent') return { type: 'say', text: req.intent.slots?.text?.value || '' }
  if (intent === 'AMAZON.YesIntent') return { type: 'say', text: 'Yes.' }
  if (intent === 'AMAZON.NoIntent') return { type: 'say', text: 'No.' }
  return { type: 'say', text: '' }    // FallbackIntent, NavigateHome…: "Sorry, I didn't catch that"
}

// Alexa waits about 8 seconds: say "One moment" while the AI works (best effort).
function progressive(event, text) {
  const sys = event.context?.System
  if (!sys?.apiEndpoint || !sys?.apiAccessToken || !event.request?.requestId) return Promise.resolve()
  return fetch(`${sys.apiEndpoint}/v1/directives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sys.apiAccessToken}` },
    body: JSON.stringify({ header: { requestId: event.request.requestId }, directive: { type: 'VoicePlayer.Speak', speech: text } }),
    signal: AbortSignal.timeout(1500)
  }).catch(() => {})
}

// ── Long turns ───────────────────────────────────────────────────────────────
// Alexa waits about 8 seconds for an answer, and a booking with payment (think,
// search, check, book, pay) can take longer: the booking went through but Alexa
// showed "Skill response was marked as failure". So on AWS the AI turn runs in
// a background (asynchronous) run of this same function, which isn't on
// Alexa's clock. Done within REPLY_WITHIN_MS: Alexa answers as usual. Longer:
// Alexa says "I'm on it", the run finishes the work, and whatever the person
// says next gets its answer. Locally and in tests the turn runs inline.

const REPLY_WITHIN_MS = () => Number(process.env.ALEXA_REPLY_WITHIN_MS) || 6000
const POLL_MS = () => Number(process.env.ALEXA_POLL_MS) || 250
const RESULT_TTL_MS = 15 * 60 * 1000
const STUCK_AFTER_MS = 2 * 60 * 1000     // a pending turn with no answer by then never finished
const ON_IT = 'I’m on it. This one takes a few more seconds. Say go on, and I’ll tell you how it went.'
const STILL_ON_IT = 'Still working on it. Say go on in a few seconds.'
const GO_ON = 'Say go on to hear how it went.'
const ENDED = 'Your Flow demo session has ended. Start a new one on the Flow site, then say its code.'
const pendingKey = who => `ALXPEND#${who}`
const resultKey = id => `ALXRES#${id}`

/** One voice turn as Alexa: the AI, the tools, PayPal. Returns what to say. */
async function voiceTurn(session, env) {
  const { getBusiness } = require('../services/dynamo/businesses')
  const { getCustomer } = require('../services/dynamo/customers')
  const [business, customer] = await Promise.all([getBusiness(session.businessId), getCustomer(session.customerId)])
  if (!business || !customer) return { missing: true }
  return trace.run(`sess:${session.sid}`, async () => {
    const ctx = await require('./concierge').sessionContext(session, business, customer, 'speaker')
    const out = await voice.handle(env, { business, customer, ctx, via: 'Alexa' })
    const r = out.voice.reply || {}
    return { speech: r.speech || 'Okay.', reprompt: r.end ? null : (r.reprompt || null), end: !!r.end, card: r.card || null, attributes: out.voice.session?.attributes || {} }
  })
}

const spoken = r => say(r.speech, { reprompt: r.end ? undefined : r.reprompt || undefined, end: r.end, card: r.card || undefined, attributes: r.attributes || {} })

/** The background run (handlers/alexa.js routes { flowAlexaWork } here): do the turn, keep its answer. */
async function runWork(job) {
  let r
  try {
    const session = job?.sid ? await demo.getActiveSession(job.sid) : null
    r = session ? await voiceTurn(session, job.env) : { missing: true }
    if (r.missing) r = { speech: ENDED, end: true, attributes: {} }
  } catch (err) {
    log.error('alexa_work_failed', err, {})
    r = { speech: 'Sorry, something went wrong on my side. Please try again in a moment.', reprompt: 'What would you like to do?', end: false, attributes: job?.env?.session?.attributes || {} }
  }
  await store().putKey(resultKey(job.id), 'R', r, Date.now() + RESULT_TTL_MS)
  return r
}

let invoker = null   // tests: stands in for the Lambda invoke
/** Start the background run. False when there's none (local, tests without an invoker, or AWS refused). */
async function startWork(job) {
  try {
    if (invoker) { await invoker(job); return true }
    if (!process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.STAGE === 'local' || process.env.ALEXA_ASYNC === 'off') return false
    const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda')
    await new LambdaClient({}).send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ flowAlexaWork: job }))
    }))
    return true
  } catch (err) {
    log.warn('alexa_background_unavailable', { err: String(err?.message || err).slice(0, 160) })
    return false
  }
}

async function waitForResult(id, ms) {
  const until = Date.now() + ms
  for (;;) {
    const r = await store().getKey(resultKey(id), 'R')
    if (r) { await store().deleteKey(resultKey(id), 'R'); return r }
    if (Date.now() >= until) return null
    await new Promise(res => setTimeout(res, POLL_MS()))
  }
}

async function clearPending(who, id) {
  await store().deleteKey(pendingKey(who), 'P')
  await store().deleteKey(resultKey(id), 'R')
}

function _useInvoker(fn) { invoker = fn }

/** One Alexa skill request → the skill response. Never throws. */
async function handle(event) {
  try {
    const appId = event.session?.application?.applicationId || event.context?.System?.application?.applicationId
    if (process.env.ALEXA_SKILL_ID && appId !== process.env.ALEXA_SKILL_ID) return say('This skill isn’t set up for Flow.', { end: true })
    const req = event.request || {}
    const userId = event.session?.user?.userId || event.context?.System?.user?.userId
    if (req.type === 'SessionEndedRequest') return { version: '1.0', response: {} }

    let session = await sessionFor(userId)
    // Linking: "my code is 1234" (also accepted later, to switch sessions).
    if (req.type === 'IntentRequest' && req.intent?.name === 'LinkIntent') {
      const linked = await link(userId, req.intent.slots?.code?.value)
      if (!linked) return say('Sorry, that code didn’t match a Flow demo. Check the code on the Alexa page of your Flow demo and say it again.', { reprompt: 'What’s your four digit code?' })
      const first = (linked.customerName || 'there').split(' ')[0]
      return say(`Linked! Hi ${first}, you're booking as ${linked.customerName} in Flow's Austin demo. What would you like to book? To unlink later, say disconnect.`, { reprompt: 'You can say, book me a haircut.' })
    }
    // "Disconnect my account": the same as Unlink on the Alexa page.
    if (req.type === 'IntentRequest' && req.intent?.name === 'UnlinkIntent') {
      if (!session) return say('This Alexa isn’t linked to a Flow demo, so there’s nothing to disconnect.', { end: true })
      await unlink(session)
      return say('Disconnected. This Alexa is no longer linked to your Flow demo. To link again, open Flow Bookings and say your code.', { end: true })
    }
    if (!session) return say(ASK_CODE, { reprompt: 'What’s the four digit code on your Flow Alexa page?' })

    const vr = voiceRequest(req)
    const env = { version: 1, session: { new: !!event.session?.new, attributes: event.session?.attributes || {} }, request: vr }
    const who = userKey(userId)

    // A turn still running from before (it took longer than Alexa waits):
    // answer with its result now, or say it's still going. Never start a
    // second turn meanwhile, so a booking can't be made twice.
    const pending = await store().getKey(pendingKey(who), 'P')
    if (pending && vr.type !== 'stop') {
      const done = await store().getKey(resultKey(pending.id), 'R')
      if (done) { await clearPending(who, pending.id); return spoken(done) }
      if (Date.now() - pending.at < STUCK_AFTER_MS) return say(STILL_ON_IT, { reprompt: GO_ON, attributes: env.session.attributes })
      await clearPending(who, pending.id)   // that run never finished: start afresh
    }

    // A sentence from the customer runs the AI: on AWS in a background run,
    // off Alexa's clock (see Long turns, above).
    if (vr.type === 'say' && vr.text) {
      await trace.run(`sess:${session.sid}`, async () => trace.event('session', 'Alexa heard the customer', { utterance: vr.text.slice(0, 120) }))
      await progressive(event, 'One moment.')
      const job = { id: crypto.randomUUID(), sid: session.sid, env }
      if (await startWork(job)) {
        const r = await waitForResult(job.id, REPLY_WITHIN_MS())
        if (r) return spoken(r)
        await store().putKey(pendingKey(who), 'P', { id: job.id, at: Date.now() }, Date.now() + RESULT_TTL_MS)
        await trace.run(`sess:${session.sid}`, async () => trace.event('session', 'Alexa: still working; the answer comes on the next turn', { waited: `${Math.round(REPLY_WITHIN_MS() / 1000)} s` }))
        return say(ON_IT, { reprompt: GO_ON, attributes: env.session.attributes })
      }
    }
    // Quick turns (open, help, stop), and any turn when a background run isn't available.
    const r = await voiceTurn(session, env)
    return r.missing ? say(ENDED, { end: true }) : spoken(r)
  } catch (err) {
    log.error('alexa_request_failed', err, {})
    return say('Sorry, something went wrong on my side. Please try again in a moment.', { end: true })
  }
}

module.exports = { handle, runWork, codeFor, status, link, unlink, sessionFor, voiceRequest, SKILL_NAME, _useInvoker }
