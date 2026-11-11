// @ts-check
'use strict'

// ─── Demo API (hackathon) ─────────────────────────────────────────────────────
//   GET    /demo/info                 public: limits, sandbox buyer login
//   POST   /demo/session              start a session {mode: guided|explore} (rate-limited per IP)
//   GET    /demo/session              session status + time left        [session token]
//   DELETE /demo/session              end + wipe                         [session token]
//   GET    /demo/inbox?role=&since=   this session's inbox messages      [session token]
//   POST   /demo/inbox/read           mark messages read                 [session token]
//   GET    /demo/trace?since=         "Under the hood" timeline          [session token]
//   POST   /demo/chat                 customer web chat (real AI + tools)[session token]
//   GET    /demo/me                   the customer's bookings/payments   [session token]
//   GET    /demo/setup                AI setup state, sample documents   [session token]
//   POST   /demo/setup/generate       AI draft from description + docs   [session token]
//   POST   /demo/setup/apply          create the salon {source: ai|template} [session token]
//   POST   /demo/setup/learn/preview  what the documents become in Claude, before saving [session token]
//   POST   /demo/setup/learn          add documents to the knowledge base [session token]
//   GET    /demo/inbox/file?f=        one message attachment (signed link, no header needed)
//   GET    /demo/photo?f=             a reference photo on a booking (signed link, no header needed)
//   GET    /demo/alexa                Alexa: the linking code and whether it's linked [session token]
//   DELETE /demo/alexa                unlink Alexa from this session    [session token]
//   POST   /demo/alexa/beta           add an Amazon account to the Alexa beta {email} [session token]
// Session token = Authorization: Bearer <sessionToken> from POST /demo/session.

const crypto = require('crypto')
const demo = require('../core/demoSession')
const inbox = require('../services/demoInbox')
const trace = require('../services/trace')
const { store } = require('../services/demoStore')
const { respond } = require('../utils/response')
const log = require('../utils/logger')

const MAX_MESSAGE_CHARS = 1000
const MAX_HISTORY_TURNS = 20

exports.handler = async (event) => {
  if (event?.warm) return { warm: true }   // keep-warm ping (serverless.yml custom.warm)
  if (event.httpMethod === 'OPTIONS') return respond(200, {})
  const path = (event.pathParameters?.proxy || event.path?.replace(/^\/?demo\/?/, '') || '').replace(/\/$/, '')
  const method = event.httpMethod
  const query = event.queryStringParameters || {}
  let body = {}
  try { body = event.body ? JSON.parse(event.body) : {} } catch { return respond(400, { error: 'Invalid JSON' }) }

  try {
    if (path === 'info' && method === 'GET') return respond(200, info())
    if (path === 'session' && method === 'POST') return await startSession(event)
    // A signed link to one inbox attachment: works as a plain <a href>, no header needed.
    if (path === 'inbox/file' && method === 'GET') return await inboxFile(query)
    if (path === 'photo' && method === 'GET') return await require('../services/photos').serve(query)

    // Everything else needs a live session.
    const sid = demo.sidFromToken(bearer(event))
    const session = await demo.getActiveSession(sid)
    if (!session) return respond(401, { error: 'Session ended or expired', ended: true })

    if (path === 'session' && method === 'GET') return respond(200, sessionView(session))
    if (path === 'session' && method === 'DELETE') return respond(200, await demo.endSession(session.sid, 'user'))
    if (path === 'inbox' && method === 'GET') return await getInbox(session, query)
    if (path === 'inbox/read' && method === 'POST') { await store().markRead(session.sid, (body.sks || []).slice(0, 50)); return respond(200, { ok: true }) }
    if (path === 'trace' && method === 'GET') return await getTrace(session, query)
    if (path === 'chat' && method === 'POST') return await chat(session, body)
    if (path === 'me' && method === 'GET') return await me(session)
    if (path.startsWith('paypal/saved') && method === 'POST') return await savedPaypalRoute(session, path)
    if (path === 'allowance' && method === 'POST') return await setAllowance(session, body)
    // Telegram (core/telegramBot): the demo bot's link and status, and a store's own bot.
    if (path === 'telegram' && method === 'GET') return respond(200, await require('../core/telegramBot').linkStatus(session))
    if (path === 'telegram' && method === 'DELETE') { await require('../core/telegramBot').unlinkSession(session); return respond(200, { ok: true }) }
    if (path === 'telegram/bots' && method === 'POST') {
      const r = await trace.run(`sess:${session.sid}`, () => require('../core/telegramBot').connectStoreBot(session, { token: body.token, businessId: body.businessId }))
      return respond(r.error ? 400 : 200, r)
    }
    if (path.startsWith('telegram/bots/') && method === 'DELETE') {
      const r = await require('../core/telegramBot').disconnectStoreBot(session, path.slice('telegram/bots/'.length))
      return respond(r.error ? 400 : 200, r)
    }
    // Alexa (core/alexa): the 4-digit code that links the skill to this session.
    if (path === 'alexa' && method === 'GET') return respond(200, await require('../core/alexa').status(session))
    if (path === 'alexa' && method === 'DELETE') { await require('../core/alexa').unlink(session); return respond(200, { ok: true }) }
    // Self-serve Alexa beta (core/alexaBeta): a visitor's Amazon account joins the skill's beta test.
    if (path === 'alexa/beta' && method === 'POST') {
      const r = await require('../core/alexaBeta').join(session, body.email)
      return respond(r.error ? (r.error === 'amazon' ? 502 : 400) : 200, r)
    }
    // Approve in Flow (core/approvals): only this session's own browser can see or decide its approvals.
    if (path.startsWith('approvals/')) return await approvalRoute(session, path.slice('approvals/'.length), method, body)
    if (path === 'login/paypal' && method === 'POST') return respond(200, await trace.run(`sess:${session.sid}`, () => require('../core/paypalLogin').start(session)))
    if (path === 'places' && method === 'GET') return await places(session)
    if (path === 'voice' && method === 'POST') return await voice(session, body)
    if (path === 'mcp' && method === 'GET') return respond(200, await mcpInfo(session, query.business))
    if (path === 'businesses' && method === 'GET') return await businesses(session)
    if (path.startsWith('businesses/') || (path === 'businesses' && method === 'POST')) return await addedBusiness(session, path, method, body, query)
    if (path === 'owner' && method === 'POST') return await switchOwner(session, body)
    if (path.startsWith('setup')) return await setup(session, path, method, body)
    return respond(404, { error: 'Not found' })
  } catch (err) {
    if (err.code === 'DEMO_LIMIT') return respond(429, { error: err.message, limit: true })
    log.error('demo_api_error', err, { path, method })
    return respond(500, { error: 'Something went wrong' })
  }
}

// Scheduled: wipe sessions past their 24h limit that nobody ended.
exports.sweep = async () => ({ wiped: await demo.sweepExpired() })

function bearer(event) {
  const h = event.headers?.Authorization || event.headers?.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

function clientIp(event) {
  return event.requestContext?.identity?.sourceIp || String(event.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
}

function info() {
  return {
    limits: demo.LIMITS,
    sessionHours: 24,
    // Shared PayPal SANDBOX buyer — fake money only, published on purpose so
    // judges can pay. Never a real account.
    sandboxBuyer: process.env.DEMO_BUYER_EMAIL ? { email: process.env.DEMO_BUYER_EMAIL, password: process.env.DEMO_BUYER_PASSWORD || null } : null
  }
}

function sessionView(s) {
  return {
    sid: s.sid, status: s.status, createdAt: s.createdAt, expiresAt: s.expiresAt, msLeft: Math.max(0, s.expiresAt - Date.now()),
    mode: s.mode || 'explore', setupDone: s.setupDone !== false, knowledge: s.knowledge || null,
    businessName: s.businessName, businessId: s.businessId, customerName: s.customerName,
    // Set once the customer logged in with PayPal (core/paypalLogin): name + masked email.
    paypalLogin: s.paypalLogin || null,
    // PayPal risk data (FraudNet) for saved-PayPal payments from the web chat.
    fraudnet: require('../core/riskData').fraudnet(s.sid),
    ...info()
  }
}

async function startSession(event) {
  let mode = 'explore'
  try { mode = JSON.parse(event.body || '{}').mode === 'guided' ? 'guided' : 'explore' } catch {}
  const created = await demo.createSession({ ip: clientIp(event), mode })
  return respond(201, { ...sessionView(created.session), sessionToken: created.sessionToken, ownerToken: created.ownerToken })
}

async function getInbox(session, query) {
  const role = query.role === 'owner' || query.role === 'customer' ? query.role : undefined
  const messages = await inbox.list(session.sid, { role, since: query.since || null })
  return respond(200, {
    messages: messages.map(m => ({
      sk: m.sk, ts: m.ts, role: m.role, from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html, kind: m.kind, read: !!m.read, businessId: m.businessId || null, action: m.action || null,
      ...(m.attachments?.length ? { attachments: m.attachments.map((a, i) => attachmentView(session.sid, m.sk, i, a)) } : {})
    })),
    cursor: messages.length ? messages[messages.length - 1].sk : (query.since || null)
  })
}

// Each attachment gets two signed links (valid an hour): open in the browser, or download.
function attachmentView(sid, sk, i, a) {
  const { createToken } = require('../utils/jwt')
  const url = `${process.env.API_URL || ''}/demo/inbox/file?f=${createToken({ typ: 'inboxfile', sid, sk, i }, 3600)}`
  return { filename: a.filename, contentType: a.contentType, size: Math.floor((a.data || '').length * 3 / 4), url, downloadUrl: `${url}&dl=1` }
}

async function inboxFile(query) {
  let p
  try { p = require('../utils/jwt').verifyToken(String(query.f || '')) } catch { return respond(403, { error: 'This link has expired. Open the message again.' }) }
  if (p.typ !== 'inboxfile') return respond(403, { error: 'Not a file link.' })
  if (!(await demo.getActiveSession(p.sid))) return respond(410, { error: 'Session ended.' })
  const m = (await inbox.list(p.sid)).find(x => x.sk === p.sk)
  const a = m?.attachments?.[Number(p.i)]
  if (!a?.data) return respond(404, { error: 'Attachment not found.' })
  const name = String(a.filename || 'attachment').replace(/[^\w.-]/g, '_')
  const disposition = `${query.dl ? 'attachment' : 'inline'}; filename="${name}"`
  // On AWS, API Gateway (REST) would hand the browser base64 text instead of the
  // PDF, so the file goes to S3 and the browser is sent to a 5-minute signed S3
  // link. Locally (scripts/local-api.js) the bytes are served directly.
  if (process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.S3_DOCUMENTS_BUCKET) {
    const s3 = require('../services/s3')
    const key = `demo-inbox/${p.sid}/${crypto.createHash('sha256').update(`${p.sk}|${p.i}`).digest('hex').slice(0, 24)}/${name}`
    await s3.putFile(key, Buffer.from(a.data, 'base64'), a.contentType || 'application/octet-stream')
    const url = await s3.signedGetUrl(key, { contentType: a.contentType || 'application/octet-stream', disposition, expiresIn: 300 })
    return { statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, body: '' }
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': a.contentType || 'application/octet-stream',
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*'
    },
    body: a.data,
    isBase64Encoded: true
  }
}

async function getTrace(session, query) {
  const events = await trace.read(`sess:${session.sid}`, query.since || null, 200)
  return respond(200, { events, cursor: events.length ? events[events.length - 1].sk : (query.since || null) })
}

// Asked by voice note, answered by voice, as on Telegram: Amazon Polly speaks the reply
// (MP3, the reply's language) and the chat plays it above the text. If Polly fails or
// has no voice for the language, the text alone goes, as before.
async function voiceReply(session, turn) {
  if (turn.media?.kind !== 'audio' || !turn.media.transcript || !turn.reply) return {}
  const spoken = await trace.run(`sess:${session.sid}`, () =>
    require('../services/cloudTts').voiceMessage(require('../core/voice').speakable(turn.reply)))
  return spoken ? { voice: { mimeType: spoken.mimeType, data: spoken.buffer.toString('base64'), voice: spoken.voice } } : {}
}

// Customer web chat: the same AI router and booking tools as every other channel
// (core/demoChat). A message may carry ONE attachment: a
// voice note (transcribed) or a photo/PDF (read into a short summary).
async function chat(session, body) {
  const typed = String(body.message || '').trim().slice(0, MAX_MESSAGE_CHARS)
  let attachment = null
  if (body.attachment) {
    try { attachment = require('../services/media').parseAttachment(body.attachment) } catch (err) {
      if (err.code === 'MEDIA_INVALID') return respond(400, { error: err.message })
      throw err
    }
  }
  if (!typed && !attachment) return respond(400, { error: 'message required' })

  const history = (Array.isArray(body.history) ? body.history : [])
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
    .slice(-MAX_HISTORY_TURNS * 2)
    .map(h => ({ role: h.role, content: h.content.slice(0, 2000) }))

  try {
    const turn = await require('../core/demoChat').chatTurn(session, { typed, attachment, history, channel: 'web' })
    return respond(200, { ...turn, ...(await voiceReply(session, turn)) })
  } catch (err) {
    if (err.code === 'MEDIA_BUSY') return respond(503, { error: err.message })
    if (err.code === 'SESSION_DATA_MISSING') return respond(410, { error: err.message, ended: true })
    throw err
  }
}

// City-wide concierge context (shared with voice and MCP): core/concierge.sessionContext.
function conciergeContext(session, business, customer, channel) {
  return require('../core/concierge').sessionContext(session, business, customer, channel)
}

// Voice assistant (core/voice): one Flow Voice request in, the reply out,
// plus the reply as natural speech (cloud TTS). Speech-to-text normally happens
// in the browser; when it can't, the client sends the recording instead.
async function voice(session, body) {
  const voiceCore = require('../core/voice')
  try { voiceCore.validate(body.voice) } catch (err) { return respond(400, { error: err.message }) }
  const env = body.voice
  let audio = null
  if (body.audio) {
    try { audio = require('../services/media').parseAttachment({ ...body.audio, kind: 'audio' }) } catch (err) {
      if (err.code === 'MEDIA_INVALID') return respond(400, { error: err.message })
      throw err
    }
  }
  if (env.request.type === 'say') await demo.checkChatLimits(session.sid)
  if (audio) await demo.checkMediaLimit(session.sid)

  const { getBusiness } = require('../services/dynamo/businesses')
  const { getCustomer } = require('../services/dynamo/customers')
  const business = await getBusiness(session.businessId)
  const customer = await getCustomer(session.customerId)
  if (!business || !customer) return respond(410, { error: 'Session data missing — please start a new session', ended: true })

  return trace.run(`sess:${session.sid}`, async () => {
    let transcript = null
    if (audio) {
      // Fallback speech-to-text (browser couldn't do it): transcribe the recording.
      try {
        transcript = (await require('../services/media').transcribeAudio({ ...audio, hint: customer.name })).text
      } catch (err) {
        log.error('voice_stt_failed', err)
        return respond(503, { error: "Couldn't hear that right now (speech service busy). Please try again." })
      }
      env.request = { type: 'say', text: transcript }
    } else if (env.request.type === 'say') {
      trace.event('media', 'Speech recognised in the browser', { utterance: String(env.request.text || '').slice(0, 120) })
    }

    const ctx = await conciergeContext(session, business, customer, 'speaker')
    const out = await voiceCore.handle(env, { business, customer, ctx })
    // Spoken by Amazon Polly in the reply's language; lang tells the browser's fallback voice the same.
    const tts = require('../services/cloudTts')
    const speech = out.speech ? await tts.synthesize(out.speech) : null
    return respond(200, { voice: out.voice, transcript, speech: out.speech, audio: speech, lang: out.speech ? tts.localeFor(out.speech) : null, payment: out.payment, connect: out.connect || null, bookingsChanged: out.bookingsChanged })
  })
}

// "Connect your own AI": this session's two MCP links and a ready Claude Desktop
// config. PayPal needs no extra server or token: the business link's paypal_*
// tools run through Flow's backend on the account the business connected.
async function mcpInfo(session, businessId) {
  const links = demo.mcpLinks(session, businessId)
  // Which business the owner link runs, so the page can name it.
  const bid = businessId && demo.ownsBusiness(session, businessId) ? businessId : session.businessId
  const b = await require('../services/dynamo/businesses').getBusiness(bid).catch(() => null)
  return {
    customer: links.customer,
    business: links.business,
    businessName: b?.name || session.businessName,
    ownBusiness: bid === session.businessId,
    expiresAt: links.expiresAt,
    claudeDesktop: {
      mcpServers: {
        'flow-customer': { command: 'npx', args: ['-y', 'mcp-remote', links.customer] },
        'flow-business': { command: 'npx', args: ['-y', 'mcp-remote', links.business] }
      }
    }
  }
}

// Every business the judge can run in this session (the Business side's switcher).
async function businesses(session) {
  // Straight from the table: a salon still being set up has no services yet but is still the judge's.
  const { getBusiness } = require('../services/dynamo/businesses')
  const all = (await Promise.all((session.businessIds || [session.businessId]).map(id => getBusiness(id)))).filter(Boolean)
  return respond(200, {
    businesses: all.map(b => ({
      businessId: b.businessId, name: b.name, category: b.category || null,
      neighborhood: b.location?.neighborhood || null, own: b.businessId === session.businessId,
      added: !!b.addedByJudge, setupDone: b.setupDone !== false
    })),
    // For "+ Add a business": John's home, the circle, the kinds, how many are left.
    add: require('../core/addedBusiness').options(session)
  })
}

// "+ Add a business" (core/addedBusiness): create it on the map, then set it up
// with Flow's AI. (Setting it up from the judge's own AI goes through MCP.)
async function addedBusiness(session, path, method, body, query) {
  const added = require('../core/addedBusiness')
  const out = r => respond(r?.error ? 400 : 200, r)
  if (path === 'businesses' && method === 'POST') {
    const r = await added.create(session, body)
    if (r.error) return out(r)
    // A dashboard token for it, so the Business side can switch straight to it.
    const fresh = await demo.getActiveSession(session.sid)
    return out({ ...r, ownerToken: demo.ownerTokenFor(fresh, r.businessId) })
  }
  if (path === 'businesses/spot' && method === 'GET') return out(added.randomSpot())
  if (path === 'businesses/place' && method === 'POST') return out(added.place(body))
  if (path === 'businesses/setup' && method === 'GET') return out(await added.state(session, query.business))
  try {
    if (path === 'businesses/setup/draft' && method === 'POST') return out(await added.draft(session, body.businessId, { description: body.description }))
  } catch (err) {
    if (err.code === 'DEMO_LIMIT') return respond(429, { error: err.message })
    throw err
  }
  if (path === 'businesses/setup/apply' && method === 'POST') return out(await added.apply(session, body.businessId))
  return respond(404, { error: 'Not found' })
}

// Switch the Business side to another business in the session: a dashboard token for it.
async function switchOwner(session, body) {
  const token = demo.ownerTokenFor(session, body.businessId)
  if (!token) return respond(404, { error: "That business isn't part of this demo session." })
  const b = await require('../services/dynamo/businesses').getBusiness(body.businessId)
  return respond(200, { ownerToken: token, businessId: body.businessId, businessName: b?.name || null })
}

// The customer's bookings across every business in the session's city.
// Guided demo: set the salon up with AI (core/demoSetup).
async function setup(session, path, method, body) {
  const demoSetup = require('../core/demoSetup')
  const docIds = Array.isArray(body.docIds) ? body.docIds.map(String).slice(0, 10) : undefined
  try {
    if (path === 'setup' && method === 'GET') return respond(200, await demoSetup.state(session))
    if (path === 'setup/generate' && method === 'POST') return respond(200, await demoSetup.generate(session, { description: typeof body.description === 'string' ? body.description : undefined, docIds }))
    if (path === 'setup/apply' && method === 'POST') return respond(200, await demoSetup.apply(session, { source: ['template', 'mcp'].includes(body.source) ? body.source : 'ai' }))
    if (path === 'setup/learn/preview' && method === 'POST') return respond(200, await demoSetup.learnPreview(session, { docIds }))
    if (path === 'setup/learn' && method === 'POST') return respond(200, await demoSetup.learn(session, { docIds }))
  } catch (err) {
    if (err.code === 'AI_UNAVAILABLE') return respond(503, { error: err.message, fallback: true })
    if (err.code === 'NO_DRAFT' || err.code === 'NO_DOCS') return respond(400, { error: err.message })
    if (err.code === 'SESSION_DATA_MISSING') return respond(410, { error: err.message, ended: true })
    throw err
  }
  return respond(404, { error: 'Not found' })
}

async function me(session) {
  const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
  const concierge = require('../core/concierge')
  const catalog = await concierge.loadCatalog(session.businessIds || [session.businessId])
  const from = new Date(Date.now() - 1 * 86_400_000).toISOString()
  const to = new Date(Date.now() + 60 * 86_400_000).toISOString()
  const rows = []
  const { fmtLocal, tzOf } = require('../utils/time')
  for (const b of catalog) {
    const all = (await getAppointmentsForBusiness(b.businessId, from, to)).filter(a => a.customerId === session.customerId && !a.seeded)
    // A moved booking is a new one plus the old one closed: show only where it is now.
    const movedAway = new Set(all.map(a => a.rescheduledFrom).filter(Boolean))
    for (const a of all.filter(x => !movedAway.has(x.appointmentId))) {
      const staff = (b.config.staff || []).find(s => s.staffId === a.unitId)
      rows.push({
        appointmentId: a.appointmentId, business: b.name, service: a.serviceName || a.serviceId, startTime: a.startTime, endTime: a.endTime,
        when: fmtLocal(a.startTime, tzOf(b)), moved: !!a.rescheduledFrom, paidWith: paidWith(a),
        staff: staff?.name || null, status: a.status, paymentStatus: a.paymentStatus, amountPaid: a.amountPaid, totalAmount: a.totalAmount,
        currency: a.currency || 'USD', paymentId: a.paymentId, refundAmount: a.refundAmount || 0, refundStatus: a.refundStatus || null,
        customerNotes: a.customerNotes || null, membershipPlan: a.membershipPlan || null, memberDiscountPct: a.memberDiscountPct || null
      })
    }
  }
  const customer = await require('../services/dynamo/customers').getCustomer(session.customerId).catch(() => null)
  return respond(200, {
    customer: {
      name: session.customerName, savedPaypal: require('../core/savedPaypal').view(customer),
      allowance: customer ? await require('../core/allowance').view(customer, catalog) : { on: false },
      // The signed terms and the payments made under them (core/allowance).
      mandateTerms: customer ? require('../core/allowance').signedTerms(customer) : null,
      mandatePayments: customer ? await require('../core/allowance').payments(customer, 5) : []
    },
    memberships: await require('../core/memberships').forCustomer(session.customerId, catalog).catch(() => []),
    bookings: rows.sort((x, y) => x.startTime.localeCompare(y.startTime))
  })
}

// The approval page: GET shows it, POST { decision: 'approve' | 'decline' } decides it.
// Approvals are stored under the session, so another session's id is simply not found.
async function approvalRoute(session, id, method, body) {
  const approvals = require('../core/approvals')
  if (method === 'GET') {
    const rec = await approvals.get(session.sid, id)
    return rec ? respond(200, { approval: approvals.view(rec, session) }) : respond(404, { error: 'This approval isn’t in this Flow session. Open the link in the browser where you use Flow.' })
  }
  if (method !== 'POST' || !['approve', 'decline'].includes(body.decision)) return respond(400, { error: 'decision must be approve or decline' })
  const r = await approvals.decide(session, id, body.decision)
  if (r.error === 'not_found') return respond(404, { error: 'This approval isn’t in this Flow session. Open the link in the browser where you use Flow.' })
  if (r.error) return respond(410, { error: 'Session data missing — please start a new session', ended: true })
  return respond(200, r)
}

// Profile → AI spending allowance: only the customer sets it, here (core/allowance).
async function setAllowance(session, body) {
  const customer = await require('../services/dynamo/customers').getCustomer(session.customerId)
  if (!customer) return respond(410, { error: 'Session data missing — please start a new session', ended: true })
  return trace.run(`sess:${session.sid}`, async () => {
    const r = await require('../core/allowance').set(customer, { on: !!body.on, perBooking: body.perBooking, perMonth: body.perMonth, days: body.days, categories: body.categories })
    if (r.error) return respond(400, r)
    const fm = require('../utils/money').formatMoney
    trace.event('policy', r.on ? `The customer signed an AI spending mandate (${r.mandateId}): up to ${fm(r.perBooking)} a booking, ${fm(r.perMonth)} a month, at ${r.places}, until ${new Date(r.expiresAt).toDateString()}; Flow signed the terms` : 'The customer turned the AI spending mandate off', {})
    const catalog = await require('../core/concierge').loadCatalog(session.businessIds || [session.businessId])
    return respond(200, { allowance: await require('../core/allowance').view(customer, catalog) })
  })
}

// Profile → PayPal: "Change account" (a PayPal link, nothing charged) and
// "Remove" (the page asks the customer first, so this one acts).
async function savedPaypalRoute(session, path) {
  const savedPaypal = require('../core/savedPaypal')
  const customer = await require('../services/dynamo/customers').getCustomer(session.customerId)
  if (!customer) return respond(410, { error: 'Session data missing — please start a new session', ended: true })
  return trace.run(`sess:${session.sid}`, async () => {
    if (path === 'paypal/saved/remove') {
      const r = await savedPaypal.remove({ customer, confirm: true })
      return respond(200, { ...r, savedPaypal: savedPaypal.view(customer) })
    }
    if (path === 'paypal/saved/change') {
      if (await demo.checkCheckoutLimit(session.sid)) return respond(429, { error: 'Demo limit: too many PayPal links this hour. Try again later.' })
      const r = await savedPaypal.startChange({ customer, returnTo: 'profile' })
      return respond(200, { url: r.approveUrl })
    }
    return respond(404, { error: 'Not found' })
  })
}

// How a booking was paid, in words: decides how a refund comes back.
function paidWith(a) {
  if (a.membershipId || String(a.paymentId || '').startsWith('membership:')) return 'membership'
  if (!(Number(a.amountPaid) > 0)) return null
  return a.paymentProvider === 'paypal' && a.paymentId ? 'paypal' : 'in_person'
}

// The demo city as John sees it: businesses with distance + visit history, for
// the Near you page and map. Distances are from John's made-up home (a test
// location); the visitor's real location is never asked for or used.
async function places(session) {
  const concierge = require('../core/concierge')
  const { CITY, PERSONA } = require('../demo/templates')
  const catalog = await concierge.loadCatalog(session.businessIds || [session.businessId])
  const history = await concierge.visitHistory(catalog, session.customerId)
  const location = { ...PERSONA.home, source: 'persona' }
  return respond(200, {
    city: CITY.name,
    center: CITY.center,
    location,
    places: catalog.map(b => concierge.describe(b, location, history[b.businessId])).sort((x, y) => (x.distanceMi ?? 99) - (y.distanceMi ?? 99))
  })
}

