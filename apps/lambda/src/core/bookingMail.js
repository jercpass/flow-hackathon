// @ts-check
'use strict'

// ─── Booking change messages ───────────────────────────────────────────────────
// When a booking is moved or cancelled, by the customer or by the business,
// both sides get a message in their inbox: the customer hears what changed and what happens to
// their money; the owner gets the same facts from their side. Never throws.

const { getCustomer } = require('../services/dynamo/customers')
const { formatMoney, currencyOf } = require('../utils/money')
const { fmtLocal, tzOf } = require('../utils/time')
const log = require('../utils/logger')

function staffName(business, unitId) {
  return (business.config?.staff || []).find(s => s.staffId === unitId)?.name || null
}

// Bookings made before serviceName was stored only carry the serviceId.
function serviceName(business, a) {
  return a.serviceName || (business.config?.services || []).find(s => s.serviceId === a.serviceId)?.name || 'booking'
}

async function send(business, a, customer, owner, attachments) {
  const notify = require('../services/notify')
  const out = { customer: false, owner: false }
  try {
    const c = a.customerId ? await getCustomer(a.customerId).catch(() => null) : null
    if (c && customer) {
      const sent = await notify.notifyCustomer({ business, customer: c, channel: 'inbox', subject: `${customer.subject} — ${business.name}`, text: customer.text, kind: 'booking_update', attachments })
      out.customer = Array.isArray(sent) ? sent.includes('inbox') : !!sent
    }
    if (owner) out.owner = !!(await notify.notifyOwner({ business, subject: owner.subject, text: owner.text, kind: 'booking_update', attachments }))
  } catch (err) {
    log.warn('booking_mail_failed', { err: err.message })
  }
  return out
}

/**
 * @param {object} p
 * @param {any} p.business
 * @param {any} p.appointment   the booking as it was before cancelling
 * @param {'customer'|'owner'} p.by
 * @param {{ kind: 'refunded'|'failed'|'manual'|'none'|'membership'|'unpaid', amount?: number, pct?: number, usesLeft?: number|null, invoiceStatus?: string }} p.refund
 * @param {string} [p.reason]
 */
async function cancelled({ business, appointment: a, by, refund, reason }) {
  const tz = tzOf(business)
  const when = fmtLocal(a.startTime, tz)
  const svc = serviceName(business, a)
  const who = a.customerName || 'The customer'
  const staff = staffName(business, a.unitId)
  const money = formatMoney(refund.amount || 0, a.currency || currencyOf(business))
  const plan = a.membershipPlan || 'membership'
  const left = refund.usesLeft != null ? ` (${refund.usesLeft} left)` : ''

  const toCustomer = {
    refunded: `${money} has been refunded to your PayPal account. PayPal refunds usually show at once; card refunds can take a few days.`,
    failed: `Your ${money} refund is being processed; the business will send it to you.`,
    manual: `The business will refund ${money} to you directly.`,
    none: by === 'customer' ? 'No refund applies under the cancellation policy.' : 'No refund was issued.',
    membership: `It goes back to your ${plan}${left}.`,
    unpaid: ''
  }[refund.kind]
  const toOwner = {
    refunded: `${money} was refunded to them through PayPal automatically${refund.pct != null && by === 'customer' ? ` (${refund.pct}% under your cancellation policy)` : ''}.`,
    failed: `The ${money} refund didn't go through automatically. Refund it from PayPal.`,
    manual: `They paid ${money} outside PayPal; refund them directly.`,
    none: by === 'customer' ? 'No refund applies under your cancellation policy.' : 'No refund was issued.',
    membership: `The ${svc} went back to their ${plan}${left}.`,
    unpaid: 'Nothing was paid, so there is no refund.'
  }[refund.kind]

  const customerText = by === 'customer'
    ? `You cancelled your ${svc} at ${business.name} on ${when}.`
    : `Your ${svc} at ${business.name} on ${when} was cancelled by the business.${reason ? ` Reason: ${reason}.` : ''}`
  const ownerText = by === 'customer'
    ? `${who} cancelled their ${svc} on ${when}${staff ? ` with ${staff}` : ''}. The time is free again.`
    : `You cancelled ${a.customerName ? `${a.customerName}'s` : 'the'} ${svc} on ${when}${staff ? ` with ${staff}` : ''}.${reason ? ` Reason given: ${reason}.` : ''} The time is free again${a.customerId ? ' and the customer was told in their inbox' : ''}.`

  // When money came back, both get the updated receipt (it shows the refund) and the invoice line.
  let receipt = null
  let after = a
  if (refund.kind === 'refunded') {
    const invoices = require('./invoices')
    after = { ...a, refundAmount: Number(a.refundAmount || 0) + Number(refund.amount || 0), ...(refund.invoiceStatus ? { invoiceStatus: refund.invoiceStatus } : {}) }
    receipt = await invoices.receiptForBooking(business, after)
  }
  const invoiceLine = who => (refund.kind === 'refunded' ? require('./invoices').invoiceLine(after, who) : '')

  return send(business, a,
    { subject: 'Your booking was cancelled', text: [customerText, toCustomer, invoiceLine('customer')].filter(Boolean).join('\n\n') },
    { subject: `${by === 'customer' ? 'Cancelled by the customer' : 'You cancelled'}: ${svc}, ${when}`, text: [ownerText, toOwner, invoiceLine('owner')].filter(Boolean).join('\n\n') },
    receipt ? [receipt] : undefined)
}

/**
 * @param {object} p
 * @param {any} p.business
 * @param {any} p.from   the booking before the move
 * @param {any} p.to     the booking after the move
 * @param {'customer'|'owner'} p.by
 */
async function moved({ business, from, to, by }) {
  const tz = tzOf(business)
  const was = fmtLocal(from.startTime, tz)
  const now = fmtLocal(to.startTime, tz)
  const svc = serviceName(business, to)
  const staff = staffName(business, to.unitId)
  const newStaff = to.unitId !== from.unitId && staff ? ` with ${staff}` : ''
  const customerText = by === 'customer'
    ? `Your ${svc} at ${business.name} has moved from ${was} to ${now}${staff ? ` with ${staff}` : ''}.`
    : `${business.name} moved your ${svc} from ${was} to ${now}${newStaff}. If that doesn't work for you, reply in the Flow chat and we'll find another time.`
  const ownerText = by === 'customer'
    ? `${to.customerName || 'A customer'} moved their ${svc} from ${was} to ${now}${staff ? ` with ${staff}` : ''}.`
    : `You moved ${to.customerName ? `${to.customerName}'s` : 'the'} ${svc} from ${was} to ${now}${newStaff}.${to.customerId ? ' The customer was told in their inbox.' : ''}`
  return send(business, to,
    { subject: `Your booking moved: ${now}`, text: customerText },
    { subject: `${by === 'customer' ? 'Moved by the customer' : 'You moved a booking'}: ${svc}, ${now}`, text: ownerText })
}

module.exports = { cancelled, moved }
