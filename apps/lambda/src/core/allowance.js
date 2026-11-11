// @ts-check
'use strict'

// ─── AI spending mandate (was "AI allowance") ─
// The customer lets their AI pay with their saved PayPal without asking each
// time, on terms they sign in Profile, the way AP2 (Agent Payments Protocol)
// splits it:
//   • the OPEN mandate: per booking and per month limits, an expiry, and the
//     kinds of places it covers. Flow signs the terms (HMAC), so they can't be
//     changed quietly; the AI can only read them.
//   • a CLOSED payment mandate for each payment made under it: the exact amount,
//     business, service, time and channel, signed too, and linked to the PayPal
//     order (its id rides as the order's invoice_id). PayPal is told Flow started
//     the charge on agreed terms (stored_credential MERCHANT, paymentFlow).
// Code checks every payment against the open mandate; outside it nothing is
// charged and the quote-then-confirm rule stands (tools.js, core/approvals).
//
// Stored on the customer: aiAllowance { on, perBooking, perMonth, setAt,
// expiresAt, categories, mandateId, signature }. Older records without an
// expiry or categories mean "no expiry, any place".
// Spent this month = what bookings paid under it (allowancePaid), less what was
// refunded on them: a refund gives the room back.

const crypto = require('crypto')
const { updateCustomer } = require('../services/dynamo/customers')
const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const { round2, formatMoney } = require('../utils/money')
const trace = require('../services/trace')

const MAX_PER_BOOKING = 500
const MAX_PER_MONTH = 2000
const DAYS = [7, 30, 90]
const CATEGORIES = ['salon', 'barber', 'spa']
const CATEGORY_WORDS = { salon: 'salons', barber: 'barbers', spa: 'spas' }

const monthOf = iso => String(iso || '').slice(0, 7)   // UTC month, e.g. 2026-10
const store = () => require('../services/demoStore').store()
const categoryOf = b => String(b?.category || b?.type || '').toLowerCase()
const placesText = cats => cats?.length ? cats.map(c => CATEGORY_WORDS[c] || c).join(' and ') : 'any place on Flow'
const dateText = iso => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' })

// ── Signing ──────────────────────────────────────────────────────────────────

function key() {
  return crypto.createHash('sha256').update(`flow-mandate:${process.env.FLOW_LINK_SECRET || 'local-dev'}`).digest()
}
// Sorted keys, so the same terms always give the same bytes.
function canonical(o) {
  return JSON.stringify(Object.keys(o).sort().reduce((a, k) => { a[k] = o[k]; return a }, {}))
}
const sign = terms => crypto.createHmac('sha256', key()).update(canonical(terms)).digest('base64url')

function openTerms(customerId, a) {
  return { type: 'open_mandate', mandateId: a.mandateId, customerId, perBooking: a.perBooking, perMonth: a.perMonth, currency: 'USD', categories: a.categories || [], setAt: a.setAt, expiresAt: a.expiresAt || null }
}

/** Do the stored terms still match Flow's signature? (Older records have none.) */
function verify(customerId, a) {
  if (!a?.signature) return !a?.mandateId
  const want = sign(openTerms(customerId, a))
  return want.length === a.signature.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(a.signature))
}

function settings(customer) {
  const a = customer?.aiAllowance
  return a?.on && a.perBooking > 0 && a.perMonth > 0 ? a : null
}

/** Validate, sign and save (from the Profile page only). Returns the view or { error }. */
async function set(customer, { on, perBooking, perMonth, days, categories }) {
  if (!on) {
    await updateCustomer(customer.customerId, { aiAllowance: { on: false, setAt: new Date().toISOString() } })
    customer.aiAllowance = { on: false }
    return { on: false }
  }
  if (!customer.savedPaypal?.vaultId) return { error: 'Save PayPal first: the mandate pays with your saved PayPal.' }
  const pb = round2(Number(perBooking)), pm = round2(Number(perMonth))
  if (!(pb > 0) || pb > MAX_PER_BOOKING) return { error: `Per booking must be between $1 and ${formatMoney(MAX_PER_BOOKING)}.` }
  if (!(pm >= pb) || pm > MAX_PER_MONTH) return { error: `Per month must be at least the per-booking limit and at most ${formatMoney(MAX_PER_MONTH)}.` }
  const d = days == null ? 30 : Number(days)
  if (!DAYS.includes(d)) return { error: 'The mandate can last 7, 30 or 90 days.' }
  const cats = Array.isArray(categories) ? [...new Set(categories.map(c => String(c).toLowerCase()))] : []
  if (cats.some(c => !CATEGORIES.includes(c))) return { error: `Places can be ${CATEGORIES.join(', ')}.` }
  const now = new Date()
  const a = {
    on: true, perBooking: pb, perMonth: pm, setAt: now.toISOString(), expiresAt: new Date(now.getTime() + d * 86_400_000).toISOString(),
    // Every place picked = any place (new kinds of place included).
    categories: cats.length === CATEGORIES.length ? [] : cats,
    mandateId: `om_${crypto.randomBytes(6).toString('hex')}`
  }
  const aiAllowance = { ...a, signature: sign(openTerms(customer.customerId, a)) }
  await updateCustomer(customer.customerId, { aiAllowance })
  customer.aiAllowance = aiAllowance
  return view(customer, [])
}

/** Spent under the mandate this month, net of refunds, across the given businesses. */
async function spentThisMonth(customer, businesses, now = new Date()) {
  const month = monthOf(now.toISOString())
  const from = new Date(Date.now() - 120 * 86_400_000).toISOString()
  const to = new Date(Date.now() + 120 * 86_400_000).toISOString()
  let spent = 0
  for (const b of businesses || []) {
    const appts = await getAppointmentsForBusiness(b.businessId, from, to).catch(() => [])
    for (const a of appts) {
      if (a.customerId !== customer.customerId || !(Number(a.allowancePaid) > 0) || monthOf(a.allowanceAt) !== month) continue
      spent += Math.max(0, Number(a.allowancePaid) - Number(a.refundAmount || 0))
    }
  }
  return round2(spent)
}

/**
 * May the AI pay `amount` at `business` now without asking? Never throws;
 * { ok:false } = quote as usual, with the reason when the mandate says no.
 * @returns {Promise<{ ok: boolean, reason?: string, perBooking?: number, perMonth?: number, spent?: number, left?: number, mandateId?: string }>}
 */
async function check({ customer, amount, businesses, business = null }) {
  const a = settings(customer)
  if (!a || !customer.savedPaypal?.vaultId) return { ok: false }
  const base = { perBooking: a.perBooking, perMonth: a.perMonth, mandateId: a.mandateId || null }
  const refuse = (reason, extra = {}) => {
    trace.event('policy', `AI mandate check: ${formatMoney(amount)} is ${reason} → nothing charged; ask the customer first`, { mandate: a.mandateId || 'allowance' })
    return { ok: false, reason, ...base, ...extra }
  }
  if (!verify(customer.customerId, a)) return refuse("on terms that don't match the signed mandate")
  if (a.expiresAt && Date.parse(a.expiresAt) <= Date.now()) return refuse(`after your AI mandate ended (${dateText(a.expiresAt)})`)
  if (business && a.categories?.length && !a.categories.includes(categoryOf(business))) {
    return refuse(`at ${business.name}, outside your AI mandate (it covers ${placesText(a.categories)})`)
  }
  const spent = await spentThisMonth(customer, businesses)
  const left = round2(a.perMonth - spent)
  let reason = null
  if (amount > a.perBooking + 0.004) reason = `over your ${formatMoney(a.perBooking)} per-booking limit`
  else if (amount > left + 0.004) reason = `over what's left of your monthly allowance (${formatMoney(Math.max(0, left))} of ${formatMoney(a.perMonth)})`
  if (reason) return refuse(reason, { spent, left })
  trace.event('policy', `AI mandate check: ${formatMoney(amount)} ≤ ${formatMoney(a.perBooking)} per booking; ${formatMoney(spent + amount)} of ${formatMoney(a.perMonth)} this month${a.categories?.length ? `; ${placesText(a.categories)} only` : ''}${a.expiresAt ? `; valid until ${dateText(a.expiresAt)}` : ''} ✓ → pays without asking`, { mandate: a.mandateId || 'allowance' })
  return { ok: true, ...base, spent, left: round2(left - amount) }
}

/**
 * The closed payment mandate for one payment, written (and signed) before the
 * charge; its id goes to PayPal on the order. settle() records how it ended.
 */
async function authorize({ customer, amount, currency = 'USD', business, what, startIso = null, channel = null }) {
  const a = settings(customer)
  const rec = {
    type: 'payment_mandate', id: `pm_${crypto.randomBytes(8).toString('hex')}`, openMandateId: a?.mandateId || null, customerId: customer.customerId,
    amount: round2(amount), currency, businessId: business.businessId, businessName: business.name, what, startIso, channel, at: new Date().toISOString()
  }
  const signed = { ...rec, signature: sign(rec), status: 'authorized' }
  await store().putKey(`MANDATE#${customer.customerId}`, rec.id, signed, Date.now() + 120 * 86_400_000).catch(() => {})
  trace.event('policy', `Payment mandate ${rec.id}: ${formatMoney(amount, currency)} for ${what} at ${business.name}, signed under ${rec.openMandateId || 'the allowance'}`, { channel })
  return signed
}

async function settle(pm, { status, orderId = null, appointmentId = null }) {
  if (!pm?.id) return
  await store().putKey(`MANDATE#${pm.customerId}`, pm.id, { ...pm, status, orderId, appointmentId, settledAt: new Date().toISOString() }, Date.now() + 120 * 86_400_000).catch(() => {})
}

/** The payments made under the mandate, newest first (Profile). */
async function payments(customer, limit = 10) {
  const all = await store().listKeys(`MANDATE#${customer.customerId}`).catch(() => [])
  return all.filter(p => p.type === 'payment_mandate').sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, limit)
    .map(p => ({ id: p.id, amount: p.amount, currency: p.currency, what: p.what, business: p.businessName, at: p.at, status: p.status, channel: p.channel, orderId: p.orderId || null }))
}

/** After a payment under the mandate: mark the booking so it counts this month. */
async function record({ businessId, startTime, appointmentId, amount, existing = 0, paymentMandateId = null, mandateId = null }) {
  const { updateAppointment } = require('../services/dynamo/appointments')
  await updateAppointment(businessId, startTime, appointmentId, {
    allowancePaid: round2(Number(existing || 0) + amount), allowanceAt: new Date().toISOString(), paidUnder: 'allowance',
    ...(paymentMandateId ? { paymentMandateId } : {}), ...(mandateId ? { mandateId } : {})
  })
}

/** For Profile and the AI: the terms and what's left (read-only for the AI). */
async function view(customer, businesses) {
  const a = settings(customer)
  if (!a) return { on: false, savedPaypal: !!customer?.savedPaypal?.vaultId, ...(customer?.aiAllowance?.endedBy === 'paypal' ? { endedBy: 'paypal' } : {}) }
  const spent = await spentThisMonth(customer, businesses)
  const expired = !!a.expiresAt && Date.parse(a.expiresAt) <= Date.now()
  return {
    on: true, perBooking: a.perBooking, perMonth: a.perMonth, spent, left: round2(Math.max(0, a.perMonth - spent)), savedPaypal: !!customer.savedPaypal?.vaultId,
    mandateId: a.mandateId || null, expiresAt: a.expiresAt || null, expired, categories: a.categories || [], places: placesText(a.categories),
    signed: !!a.signature && verify(customer.customerId, a), setAt: a.setAt || null
  }
}

/** The signed terms as they'd be shown to anyone checking them (Profile → "View signed terms"). */
function signedTerms(customer) {
  const a = settings(customer)
  if (!a?.signature) return null
  return { ...openTerms(customer.customerId, a), signature: a.signature, signedBy: 'Flow (HMAC-SHA256)', valid: verify(customer.customerId, a) }
}

module.exports = { set, check, authorize, settle, payments, record, view, verify, signedTerms, spentThisMonth, placesText, MAX_PER_BOOKING, MAX_PER_MONTH, DAYS, CATEGORIES }
