// @ts-check
'use strict'

// ─── Other customers' bookings for a fresh demo
// So the owner side doesn't open on "0 bookings, $0": a few made-up customers
// booked yesterday, today and the next days, on real slots. Paid like any
// booking (in full, or a deposit up front: there's no paying at the visit).
//
// The money is a real PayPal sandbox payment from a pool made once by
// scripts/paypal-samples.js: each sample takes
// a pool payment of its business, amount and state. The same payment backs a
// sample in every session, so samples stay `seeded` and read-only: nothing may
// refund them, and only the judge's own bookings move money. Without a matching
// pool payment a sample falls back to made-up money (paymentProvider 'demo').

const { randomUUID: uuid } = require('crypto')
const { createAppointment } = require('../services/dynamo/appointments')
const log = require('../utils/logger')
const { resolveAmountDue } = require('../core/paymentModes')

const OTHERS = ['Maya Patel', 'Luis Ortega', 'Grace Kim', 'Tom Becker', 'Aisha Bello', 'Ravi Menon', 'Elena Rossi', 'Sam Carter', 'Priya Nair', 'Diego Alvarez']
const CHANNELS = ['web', 'speaker', 'mcp', 'web', 'manual', 'mcp']

// Day offsets and hours after opening; what happened for the past ones.
const PLAN = [
  { day: -1, after: 1, past: 'no_show' },
  { day: -1, after: 3, past: 'completed' },
  { day: 0, after: 1, past: 'completed' },
  { day: 0, after: 7 },   // not 3 PM: the guided script books 3 PM (ScriptCard)
  { day: 1, after: 1 },
  { day: 1, after: 4 },
  { day: 2, after: 2 },
  { day: 3, after: 5, cancelled: true }
]
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * The sample bookings a business gets at `now`, without writing anything.
 * scripts/paypal-samples.js calls it for every hour and weekday a session can
 * start, to know which payments the pool needs.
 * @returns {Array<{ i: number, svc: any, person: any, start: any, startIso: string, status: string, paid: number }>}
 */
function planOthers(business, { now = Date.now() } = {}) {
  const services = (business.config?.services || []).filter(s => s.active !== false && s.unitType !== 'queue' && s.duration)
  if (!services.length) return []
  const { dayjs, atLocal, tzOf } = require('../utils/time')
  const tz = tzOf(business)
  const av = business.config.availability || {}
  const open = parseInt(String(av.open || '09:00'), 10)
  const close = parseInt(String(av.close || '18:00'), 10)
  const workDays = av.workingDays || DAYS
  const staff = business.config.staff || []
  const taken = new Set()
  const out = []

  for (const [i, p] of PLAN.entries()) {
    const svc = services[i % services.length]
    const able = staff.filter(s => (s.services || []).includes(svc.serviceId))
    const person = able.length ? able[i % able.length] : null
    const day = dayjs(now).tz(tz).add(p.day, 'day')
    const hour = open + p.after
    if (!workDays.includes(DAYS[day.day()]) || hour * 60 + svc.duration > close * 60) continue
    const start = atLocal(day.format('YYYY-MM-DD'), `${String(hour).padStart(2, '0')}:00`, tz)
    const startIso = start.utc().toISOString()
    const key = `${person?.staffId || '-'}|${startIso}`
    if (taken.has(key)) continue
    // Opening days, hours and who does the service are checked above; the slots are
    // free because nothing else is booked yet (this runs as the session starts).
    const past = start.valueOf() + svc.duration * 60_000 <= now
    if (!past && start.valueOf() <= now) continue   // happening right now: skip
    taken.add(key)

    const status = past ? (p.past || 'completed') : p.cancelled ? 'cancelled' : 'confirmed'
    // Paid up front like any booking: a deposit or the full price; a past visit
    // that happened was paid in full. A cancellation got its money back.
    let upfront = 0
    try { upfront = resolveAmountDue(svc).amountDue } catch { upfront = svc.price || 0 }
    const paid = status === 'completed' ? (svc.price || 0) : upfront
    out.push({ i, svc, person, start, startIso, status, paid })
  }
  return out
}

// ── The pool of real sandbox payments ──────────────────────────────────────

/** The pool file, if it was made with this PayPal app in this PayPal environment. */
function loadPool() {
  let pool
  try { pool = require('./paypalSamples.json') } catch { return null }
  const env = process.env.PAYPAL_ENV || 'sandbox'
  const clientId = process.env.PAYPAL_CLIENT_ID || ''
  if (!pool || pool.env !== env || env !== 'sandbox' || !clientId) return null
  if (pool.clientIdHash !== clientIdHash(clientId)) return null
  return pool
}

// The file names the PayPal app by a short hash, never the client ID itself.
function clientIdHash(clientId) {
  return require('crypto').createHash('sha256').update(String(clientId)).digest('hex').slice(0, 12)
}

// The kind of payment a sample needs: its amount, and whether it was refunded.
const kindOf = (amount, currency, refunded) => `${Number(amount).toFixed(2)} ${currency} ${refunded ? 'refunded' : 'paid'}`

/** A business's pool payments, to take from (each one at most once per session). */
function poolFor(pool, business) {
  const list = (pool?.businesses || {})[business.demoTemplate] || []
  return list.map(x => ({ ...x }))
}

function take(available, amount, currency, refunded) {
  const want = kindOf(amount, currency, refunded)
  const at = available.findIndex(x => kindOf(x.amount, x.currency, !!x.refundId) === want)
  return at < 0 ? null : available.splice(at, 1)[0]
}

/** @returns {Promise<number>} how many bookings were added */
async function seedOthers(business, { sid, now = Date.now(), pool = loadPool() } = {}) {
  const currency = business.config?.currency || 'USD'
  const available = poolFor(pool, business)
  let added = 0
  for (const s of planOthers(business, { now })) {
    const { i, svc, person, start, startIso, status, paid } = s
    const createdAt = new Date(start.valueOf() - (3 + i) * 86_400_000).toISOString()
    const refunded = status === 'cancelled'
    const real = paid > 0 ? take(available, paid, currency, refunded) : null
    // A real sandbox payment from the pool, or made-up money when none matches.
    const money = real
      ? {
          paymentProvider: 'paypal', paymentId: real.captureId, providerOrderId: real.orderId, paidAt: createdAt,
          samplePayment: true,
          ...(refunded ? { refundId: real.refundId, refundStatus: 'COMPLETED', refundedAt: new Date(start.valueOf() - 86_400_000).toISOString() } : {})
        }
      : { paymentId: null, paymentProvider: 'demo' }
    await createAppointment({
      appointmentId: uuid(), businessId: business.businessId,
      customerId: `demo-${sid}-o${i}`, customerPhone: `web:${sid}-o${i}`, customerName: OTHERS[(i + business.businessId.length) % OTHERS.length],
      serviceId: svc.serviceId, serviceName: svc.name, unitId: person?.staffId || null,
      startTime: startIso, endTime: start.add(svc.duration, 'minute').utc().toISOString(),
      status, totalAmount: svc.price || 0, amountPaid: paid, refundAmount: refunded ? paid : 0,
      paymentStatus: paid >= (svc.price || 0) ? 'paid' : 'deposit_paid',
      ...money, currency,
      createdVia: CHANNELS[i % CHANNELS.length], seeded: true, seededOther: true,
      createdAt
    }).then(() => { added++ }).catch(err => log.warn('seed_other_failed', { err: err.message }))
  }
  return added
}

module.exports = { seedOthers, planOthers, loadPool, clientIdHash, kindOf, OTHERS, PLAN }
