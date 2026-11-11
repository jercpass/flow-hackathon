// @ts-check
'use strict'

// ─── Demo sessions (hackathon) ────────────────────────────────────────────────
// "Start session" on the demo home page creates an isolated sandbox world:
//   • its own copy of the demo salon (businessId demo-<sid>)
//   • a customer persona (John Doe) and two web inboxes, customer and owner (services/demoInbox)
//   • a session token (customer side) + an owner token (business side), both
//     expiring with the session
// It ends on "End session" or 24h after creation; ending wipes everything we
// stored (business, customer, bookings, inbox, timeline, knowledge base). Rate
// limits keep random traffic and AI spend bounded.
//
// Two modes:
//   guided  — the judge's salon starts NOT set up; they build it with AI
//             (core/demoSetup), then book it as John.
//   explore — everything prebuilt, as before.

const crypto = require('crypto')
const { store } = require('../services/demoStore')
const inbox = require('../services/demoInbox')
const trace = require('../services/trace')
const { createToken, verifyToken } = require('../utils/jwt')
const { saveBusiness, deleteBusiness } = require('../services/dynamo/businesses')
const { saveCustomer, deleteCustomer } = require('../services/dynamo/customers')
const { getAppointmentsForBusiness, deleteAppointment, createAppointment } = require('../services/dynamo/appointments')
const { CATALOG, PERSONA, demoPaypal } = require('../demo/templates')
const log = require('../utils/logger')

const SESSION_MS = 24 * 60 * 60 * 1000

// Fair-use limits (also shown on the demo home page).
const LIMITS = {
  // 3, not 1: ending a session and starting a fresh one right away must work.
  sessionsPerIpPerMinute: 3,
  sessionsPerIpPerDay:    10,
  sessionsPerDay:         500,
  chatPerSessionPerHour:  40,
  checkoutsPerSessionPerHour: 5,
  mediaPerSessionPerHour: 10,
  mcpCallsPerSessionPerHour: 150,
  setupCallsPerSessionPerHour: 8,
  aiCallsPerDay:          3000
}

class DemoLimitError extends Error {
  constructor(message) { super(message); this.code = 'DEMO_LIMIT' }
}

function newSid() {
  return crypto.randomBytes(10).toString('hex')   // 20 chars, [a-f0-9]
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(`${ip}|${process.env.FLOW_LINK_SECRET || ''}`).digest('hex').slice(0, 16)
}

// Fixed-window counter; true = over the limit.
async function overLimit(key, windowSec, limit) {
  const window = Math.floor(Date.now() / 1000 / windowSec)
  return store().hit(key, window, limit, windowSec + 60)
}

async function createSession({ ip, mode = 'explore' }) {
  mode = mode === 'guided' ? 'guided' : 'explore'
  const ipHash = hashIp(ip || 'unknown')
  if (await overLimit(`sess-ip-min:${ipHash}`, 60, LIMITS.sessionsPerIpPerMinute)) throw new DemoLimitError('Please wait a minute before starting another session.')
  if (await overLimit(`sess-ip-day:${ipHash}`, 86400, LIMITS.sessionsPerIpPerDay)) throw new DemoLimitError('Daily demo limit reached for your network — please try again tomorrow.')
  if (await overLimit('sess-global-day', 86400, LIMITS.sessionsPerDay)) throw new DemoLimitError('The demo is very busy today — please try again tomorrow.')

  const sid = newSid()
  const createdAt = Date.now()
  const expiresAt = createdAt + SESSION_MS
  const businessId = `demo-${sid}`

  // A private copy of the whole demo city. Willow (demo-<sid>) is the judge's own
  // salon (guided setup, welcome note); the judge can run the others too
  //, so every one has an owner inbox and is paid
  // into the same demo PayPal account.
  // In a guided session the judge's salon has no services, staff or policies
  // until they set it up with AI.
  const businesses = CATALOG.map(c => {
    const b = c.build()
    if (c.owned && mode === 'guided') {
      b.config = { currency: b.config.currency, ai_config: b.config.ai_config, services: [], staff: [], resources: [], availability: b.config.availability, policies: null }
      b.setupDone = false
    }
    return c.owned
      ? { ...b, businessId, ownerInbox: true, ownerPhone: '+15125550100', demoSessionId: sid, createdVia: 'demo' }
      : { ...b, ...demoPaypal(), businessId: `${businessId}-${c.slug}`, ownerInbox: true, ownerPhone: null, demoSessionId: sid, createdVia: 'demo' }
  })
  await Promise.all(businesses.map(b => saveBusiness(b)))
  const business = businesses[0]

  const customer = {
    customerId: `demo-${sid}-c`, businessId, phone: `web:${sid}`, name: PERSONA.name,
    demoSessionId: sid, createdAt: new Date(createdAt).toISOString()
  }
  await saveCustomer(customer)
  await seedHistory(businesses, customer)
  // Other customers' bookings, so the owner side doesn't open on zeros (demo/seedBookings).
  // A guided salon has no services yet: it gets them when it's set up (core/demoSetup).
  const { seedOthers } = require('../demo/seedBookings')
  await Promise.all(businesses.map(b => seedOthers(b, { sid }).catch(() => 0)))

  const session = {
    sid, status: 'active', mode, setupDone: mode !== 'guided', createdAt, expiresAt, businessId, businessName: business.name,
    businessIds: businesses.map(b => b.businessId),
    customerId: customer.customerId, customerName: customer.name, ipHash,
    location: { ...PERSONA.home, source: 'persona' }
  }
  await store().putSession(session)
  // The customer's name is a token on Under the hood from the first event (services/pii).
  await require('../services/pii').vaultFor(session).catch(() => {})

  await trace.run(`sess:${sid}`, async () => {
    trace.event('session', 'Demo session started', { business: business.name, customer: customer.name, endsAt: new Date(expiresAt).toISOString() })
  })
  // Welcome notes in both web inboxes.
  await inbox.storeMessage(sid, {
    role: 'customer', to: customer.name, from: 'Flow demo', kind: 'welcome',
    subject: 'Welcome: this is your customer inbox',
    text: `This inbox is yours, the customer's. Log in with PayPal on the customer side to book under your PayPal name (the demo's sandbox buyer is John Doe).\n\nEverything the Austin businesses you book with send you shows up here: booking confirmations with receipt PDFs, payment links, and refund notices. Your demo home is in Travis Heights, and you usually get haircuts at ${business.name} with Ana.\n\nThe session and everything in it is deleted after 24 hours, or when you click End session.`
  })
  await inbox.storeMessage(sid, {
    role: 'owner', to: `${business.name} (owner)`, from: 'Flow demo', kind: 'welcome', businessId: business.businessId,
    subject: `Welcome: you run ${business.name} in this demo`,
    text: `This inbox belongs to the owner of ${business.name}.\n\n${mode === 'guided' ? 'First, set the salon up with AI from its description and documents. After that, y' : 'Y'}ou'll get new-booking and refund alerts here. Switch to Business to see the calendar, policies and payments.`
  })

  log.info('demo_session_created', { sid, mode })
  return { session, ...tokensFor(session) }
}

// John's past visits (completed + paid), so "book my usual" has a real answer.
// Read from the template, not the live config: a guided salon has no services
// yet, and its AI-made ones get the template IDs back (core/demoSetup.reconcile).
async function seedHistory(businesses, customer) {
  const { atLocal, dayjs } = require('../utils/time')
  const { randomUUID: uuid } = require('crypto')
  for (const h of PERSONA.history) {
    const biz = businesses.find(b => b.demoTemplate === h.slug)
    const svc = CATALOG.find(c => c.slug === h.slug)?.build().config.services.find(x => x.serviceId === h.serviceId)
    if (!biz || !svc) continue
    const date = dayjs().tz(biz.timezone).subtract(h.weeksAgo, 'week').format('YYYY-MM-DD')
    const start = atLocal(date, `${String(h.hour).padStart(2, '0')}:00`, biz.timezone)
    await createAppointment({
      appointmentId: uuid(), businessId: biz.businessId, customerId: customer.customerId,
      customerPhone: customer.phone, customerName: customer.name,
      serviceId: svc.serviceId, serviceName: svc.name, unitId: h.staffId,
      startTime: start.utc().toISOString(), endTime: start.add(svc.duration, 'minute').utc().toISOString(),
      status: 'completed', totalAmount: svc.price, amountPaid: svc.price, depositPaid: svc.price,
      paymentStatus: 'paid', paymentId: `hist-${uuid()}`, paymentProvider: 'paypal', currency: 'USD',
      createdVia: 'web', seeded: true
    })
  }
}

function tokensFor(session) {
  const secondsLeft = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000))
  return {
    sessionToken: createToken({ typ: 'demo', demoSid: session.sid }, secondsLeft),
    // A normal dashboard token for the session's own salon — the Business side
    // uses the regular dashboard API; it stops working when the session ends.
    ownerToken:   ownerTokenFor(session, session.businessId)
  }
}

// The Business side for any business in this session (the top bar's switcher).
// Null for a business that isn't part of the session.
function ownerTokenFor(session, businessId) {
  if (!ownsBusiness(session, businessId)) return null
  const secondsLeft = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000))
  return createToken({ businessId, phone: 'demo', demoSid: session.sid }, secondsLeft)
}

function ownsBusiness(session, businessId) {
  return !!businessId && (session.businessIds || [session.businessId]).includes(businessId)
}

// MCP links: a signed token per role in the URL, expiring with the session.
// businessId: which business the owner link runs (default: Willow, the session's own).
function mcpLinks(session, businessId) {
  const secondsLeft = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000))
  const base = String(process.env.API_URL || '').replace(/\/$/, '')
  const bid = businessId && businessId !== session.businessId && ownsBusiness(session, businessId) ? businessId : undefined
  const link = role => `${base}/mcp/${createToken({ typ: 'mcp', demoSid: session.sid, role, ...(role === 'business' && bid ? { bid } : {}) }, secondsLeft)}`
  return { customer: link('customer'), business: link('business'), expiresAt: session.expiresAt }
}

function mcpClaims(token) {
  try {
    const p = verifyToken(String(token || ''))
    return p.typ === 'mcp' && p.demoSid && (p.role === 'customer' || p.role === 'business') ? { sid: p.demoSid, role: p.role, ...(p.bid ? { bid: p.bid } : {}) } : null
  } catch {
    return null
  }
}

async function checkMcpLimit(sid) {
  if (await overLimit(`mcp:${sid}`, 3600, LIMITS.mcpCallsPerSessionPerHour)) throw new DemoLimitError(`Demo limit: ${LIMITS.mcpCallsPerSessionPerHour} MCP tool calls an hour.`)
}

function sidFromToken(token) {
  try {
    const p = verifyToken(String(token || ''))
    return p.typ === 'demo' && p.demoSid ? p.demoSid : null
  } catch {
    return null
  }
}

async function getActiveSession(sid) {
  if (!sid) return null
  const s = await store().getSession(sid)
  if (!s || s.status !== 'active') return null
  if (s.expiresAt <= Date.now()) {
    await endSession(sid, 'expired').catch(err => log.warn('demo_expire_wipe_failed', { sid, err: err.message }))
    return null
  }
  return s
}

// Wipe everything we stored for the session, web inbox included. PayPal
// sandbox transactions can't be deleted (fake data either way).
async function endSession(sid, reason = 'ended') {
  const s = await store().getSession(sid)
  const businessIds = s?.businessIds || [s?.businessId || `demo-${sid}`]
  // Each step is independent: one failing (e.g. already gone) must not stop the rest.
  const safe = async (fn, fallback) => { try { return await fn() } catch { return fallback } }
  let deleted = 0
  for (const businessId of businessIds) {
    const appts = (await safe(() => getAppointmentsForBusiness(businessId, '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z'), [])) || []
    await Promise.all(appts.map(a => safe(() => deleteAppointment(businessId, a.startTime, a.appointmentId))))
    deleted += appts.length
    await safe(() => deleteBusiness(businessId))
  }
  // A PayPal the customer saved is deleted at PayPal too (core/savedPaypal).
  await safe(() => require('./savedPaypal').forget(s?.customerId || `demo-${sid}-c`))
  await safe(() => deleteCustomer(s?.customerId || `demo-${sid}-c`))
  await safe(() => require('../services/photos').forget(s))
  // Every business's documents, deleted from Claude's Files API too (they'd expire on their own a little later).
  for (const businessId of businessIds) await safe(() => require('../services/rag').clearBusinessKnowledge(businessId))
  await store().deleteSessionItems(sid)
  await safe(() => trace.clear(`sess:${sid}`))
  log.info('demo_session_ended', { sid, reason, bookingsDeleted: deleted })
  return { ended: true, reason, bookingsDeleted: deleted }
}

// Scheduled safety net for sessions nobody came back to end.
async function sweepExpired() {
  const expired = await store().listExpiredSessions(Date.now())
  for (const s of expired) await endSession(s.sid, 'expired').catch(err => log.warn('demo_sweep_failed', { sid: s.sid, err: err.message }))
  return expired.length
}

async function checkChatLimits(sid) {
  if (await overLimit(`chat:${sid}`, 3600, LIMITS.chatPerSessionPerHour)) throw new DemoLimitError(`You've hit the demo limit of ${LIMITS.chatPerSessionPerHour} messages an hour — take a break and try again soon.`)
  if (await overLimit('ai-global-day', 86400, LIMITS.aiCallsPerDay)) throw new DemoLimitError('The demo is busy right now (daily AI limit reached). Please try again later.')
}

async function checkMediaLimit(sid) {
  if (await overLimit(`media:${sid}`, 3600, LIMITS.mediaPerSessionPerHour)) throw new DemoLimitError(`Demo limit: up to ${LIMITS.mediaPerSessionPerHour} voice notes or files an hour.`)
}

async function checkSetupLimit(sid) {
  if (await overLimit(`setup:${sid}`, 3600, LIMITS.setupCallsPerSessionPerHour)) throw new DemoLimitError(`Demo limit: ${LIMITS.setupCallsPerSessionPerHour} AI setup steps an hour. You can use the ready-made salon instead.`)
  if (await overLimit('ai-global-day', 86400, LIMITS.aiCallsPerDay)) throw new DemoLimitError('The demo is busy right now (daily AI limit reached). Please try again later.')
}

async function checkCheckoutLimit(sid) {
  return overLimit(`checkout:${sid}`, 3600, LIMITS.checkoutsPerSessionPerHour)
}

module.exports = {
  LIMITS, DemoLimitError, createSession, tokensFor, sidFromToken, getActiveSession,
  endSession, sweepExpired, checkChatLimits, checkCheckoutLimit, checkMediaLimit, checkSetupLimit,
  mcpLinks, mcpClaims, checkMcpLimit, ownerTokenFor, ownsBusiness
}
