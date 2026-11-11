// @ts-check
'use strict'

// ─── Refund requests ──────────────────────
// A customer asks for money back without cancelling (a bad haircut, a long wait).
// Asking moves no money: the request is saved on the booking and the business is
// told. The business refunds any amount (ownerOps.refundBooking, quoted then
// confirmed) or declines; the customer hears either way.

const { getAppointmentsForBusiness, updateAppointment } = require('../services/dynamo/appointments')
const { formatMoney, round2, currencyOf } = require('../utils/money')
const { fmtLocal, tzOf } = require('../utils/time')
const trace = require('../services/trace')
const log = require('../utils/logger')

const WINDOW_DAYS = 60   // a visit up to 60 days ago, or one coming up

const refundable = a => round2(Number(a.amountPaid || 0) - Number(a.refundAmount || 0))
// A real PayPal payment is behind it (made-up history has "hist-" ids). Counts in
// totals, the ledger and PayPal lookups, sample bookings included.
const paidThroughPayPal = a => a.paymentProvider === 'paypal' && !!a.paymentId && !/^(membership:|hist-)/.test(String(a.paymentId))
// …and its money may be sent back through PayPal. A sample booking's payment is
// shared by every demo session, so never.
const paidWithPayPal = a => paidThroughPayPal(a) && !a.seeded

/** What the customer (or owner) sees about a request, in words. */
function statusText(a, cur) {
  const r = a.refundRequest
  if (!r) return null
  const money = formatMoney(r.amount, cur)
  if (r.status === 'open') return `asked for ${money} back, waiting for the business`
  if (r.status === 'declined') return `asked for ${money} back; the business said no${r.answer ? `: ${r.answer}` : ''}`
  return `asked for ${money} back; ${formatMoney(r.refunded || 0, cur)} refunded`
}

async function paidBookingsOf(business, customerId, { service_name, date } = {}) {
  const from = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  const to = new Date(Date.now() + WINDOW_DAYS * 86_400_000).toISOString()
  return (await getAppointmentsForBusiness(business.businessId, from, to))
    .filter(a => a.customerId === customerId && a.status !== 'blocked' && paidWithPayPal(a) && refundable(a) > 0)
    .filter(a => !date || a.startTime.startsWith(date))
    .filter(a => !service_name || (a.serviceName || '').toLowerCase().includes(String(service_name).toLowerCase()))
}

/**
 * The customer asks. `businesses` is where to look: the one they named, or every
 * business in the demo city.
 */
async function request({ businesses, customer, args, dryRun }) {
  const reason = String(args.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!reason) return { error: 'Why do they want money back? Pass reason, in their words.' }
  const found = []
  for (const b of businesses) for (const a of await paidBookingsOf(b, customer.customerId, args)) found.push({ b, a })
  if (!found.length) return { error: 'No PayPal payment from the last 60 days with money left to refund. (Payments made in person are refunded by the business directly.)' }
  if (found.length > 1) {
    return { message: 'More than one paid booking: which one? Pass business_name, service_name or date.', bookings: found.map(({ b, a }) => ({ business: b.name, service: a.serviceName, when: fmtLocal(a.startTime, tzOf(b)), paid: formatMoney(a.amountPaid, a.currency || currencyOf(b)) })) }
  }
  const { b: business, a } = found[0]
  const cur = a.currency || currencyOf(business)
  const left = refundable(a)
  const amount = args.amount == null ? left : round2(Number(args.amount))
  if (!(amount > 0) || amount > left) return { error: `Ask for between ${formatMoney(0.01, cur)} and ${formatMoney(left, cur)} (what's left of the payment).` }
  if (a.refundRequest?.status === 'open') return { error: `There's already a request on this booking: ${statusText(a, cur)}.`, booking: { business: business.name, service: a.serviceName } }
  const when = fmtLocal(a.startTime, tzOf(business))
  if (dryRun) return { simulated: true, message: `(Test) I'd ask ${business.name} for ${formatMoney(amount, cur)} back on your ${a.serviceName}.` }

  const refundRequest = { amount, reason, at: new Date().toISOString(), status: 'open' }
  await updateAppointment(business.businessId, a.startTime, a.appointmentId, { refundRequest })
  trace.event('policy', `Refund asked: ${formatMoney(amount, cur)} (no money moves until the business decides)`, { service: a.serviceName, when })
  const notify = require('../services/notify')
  const told = await notify.notifyOwner({
    business, kind: 'refund_request',
    subject: `Refund asked: ${formatMoney(amount, cur)}, ${a.serviceName} ${when}`,
    text: `${a.customerName || customer.name || 'A customer'} asks for ${formatMoney(amount, cur)} back on their ${a.serviceName} (${when}). They paid ${formatMoney(a.amountPaid, cur)} with PayPal${a.refundAmount ? `, ${formatMoney(a.refundAmount, cur)} already refunded` : ''}.\n\nTheir reason: ${reason}\n\nRefund any amount or decline, from Bookings or by asking your AI (booking ${String(a.appointmentId).slice(0, 8)}).`
  }).catch(err => { log.warn('refund_request_alert_failed', { err: err.message }); return false })
  return {
    requested: true, business: business.name, service: a.serviceName, when, amount: formatMoney(amount, cur), owner_told: !!told,
    message: `Asked ${business.name} for ${formatMoney(amount, cur)} back. Nothing is refunded yet: the business decides, and the answer comes to your Flow inbox.`
  }
}

/** Open requests for the owner, newest first. */
async function listOpen(business) {
  const from = new Date(Date.now() - (WINDOW_DAYS + 60) * 86_400_000).toISOString()
  const to = new Date(Date.now() + WINDOW_DAYS * 86_400_000).toISOString()
  const owner = require('./ownerOps')
  const open = (await getAppointmentsForBusiness(business.businessId, from, to)).filter(a => a.refundRequest?.status === 'open')
  open.sort((x, y) => y.refundRequest.at.localeCompare(x.refundRequest.at))
  const cur = currencyOf(business)
  return {
    requests: open.map(a => ({
      ...owner.view(business, a), asked: formatMoney(a.refundRequest.amount, a.currency || cur), reason: a.refundRequest.reason, refundable: formatMoney(refundable(a), a.currency || cur),
      // Plain numbers for the dashboard's amount box.
      asked_amount: a.refundRequest.amount, refundable_amount: refundable(a)
    })),
    ...(open.length ? { next: 'refund_booking (any amount; quote, then confirm=true) or decline_refund_request.' } : { message: 'No refund requests waiting.' })
  }
}

/** The owner says no. The customer is told, with the reason if one is given. */
async function decline(business, { booking_id, reason }) {
  const owner = require('./ownerOps')
  const a = await owner.findBooking(business, booking_id)
  if (!a || a.refundRequest?.status !== 'open') return { error: 'No open refund request on that booking. list_refund_requests shows them.' }
  const answer = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null
  await updateAppointment(business.businessId, a.startTime, a.appointmentId, { refundRequest: { ...a.refundRequest, status: 'declined', answer, answeredAt: new Date().toISOString() } })
  const cur = a.currency || currencyOf(business)
  trace.event('policy', 'Refund request declined by the business', { service: a.serviceName })
  const told = await tellCustomer(business, a, `About your ${a.serviceName}`,
    `${business.name} looked at your request for ${formatMoney(a.refundRequest.amount, cur)} back on your ${a.serviceName} (${fmtLocal(a.startTime, tzOf(business))}) and won't refund it.${answer ? ` Their reason: ${answer}` : ''}`)
  return { declined: true, ...owner.view(business, a), customer_notified: told }
}

/** A refund the owner sent answers an open request. Called after the PayPal refund went through. */
async function settle(business, a, amount) {
  if (a.refundRequest?.status !== 'open') return
  const refunded = round2(Number(a.refundRequest.refunded || 0) + Number(amount || 0))
  await updateAppointment(business.businessId, a.startTime, a.appointmentId, { refundRequest: { ...a.refundRequest, status: 'refunded', refunded, answeredAt: new Date().toISOString() } })
    .catch(err => log.warn('refund_request_settle_failed', { err: err.message }))
}

async function tellCustomer(business, a, subject, text) {
  try {
    const c = a.customerId ? await require('../services/dynamo/customers').getCustomer(a.customerId) : null
    if (!c) return false
    const sent = await require('../services/notify').notifyCustomer({ business, customer: c, channel: 'inbox', kind: 'refund_request', subject: `${subject} — ${business.name}`, text })
    return Array.isArray(sent) ? sent.includes('inbox') : !!sent
  } catch {
    return false
  }
}

module.exports = { request, listOpen, decline, settle, statusText, paidWithPayPal, paidThroughPayPal }
