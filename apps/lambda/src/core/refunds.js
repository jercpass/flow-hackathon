// @ts-check
'use strict'

// ─── Policy-driven refunds ────────────────────────────────────────────────────
// The business sets a refund schedule in the dashboard (policies.refundTiers,
// sanitised widest-window-first by dashboardApi.sanitizeRefundTiers). Each tier
// {hoursBefore, refundPct} means "cancel at least hoursBefore in advance →
// refundPct% of what was paid back". This module turns that schedule into real
// money movement. The AI never decides an amount: it gets a quote from here,
// reads it to the customer, and only a confirmed cancel executes the refund.

const { getProviderById, providerIdFor } = require('../services/payments')
const { updateAppointment } = require('../services/dynamo/appointments')
const { round2, currencyOf } = require('../utils/money')
const log = require('../utils/logger')

/**
 * Quote what a cancellation right now would refund.
 * No tiers configured → full refund before the start (cancellation notice is
 * enforced separately by booking_rules.cancellation_hours). At/after start → 0.
 *
 * @returns {{ refundable: number, pct: number, amount: number, hoursUntil: number, tier: object|null }}
 */
function quoteRefund(appointment, refundTiers, now = Date.now()) {
  const paid = round2(Number(appointment.amountPaid) || 0)
  const already = round2(Number(appointment.refundAmount) || 0)
  const refundable = Math.max(0, round2(paid - already))
  const hoursUntil = (new Date(appointment.startTime).getTime() - now) / 3_600_000

  let pct = 0
  let tier = null
  if (hoursUntil > 0) {
    const tiers = (Array.isArray(refundTiers) ? refundTiers : [])
      .filter(t => Number.isFinite(Number(t?.hoursBefore)) && Number.isFinite(Number(t?.refundPct)))
      .map(t => ({ hoursBefore: Number(t.hoursBefore), refundPct: Math.min(100, Math.max(0, Number(t.refundPct))) }))
      .sort((a, b) => b.hoursBefore - a.hoursBefore)
    if (!tiers.length) {
      pct = 100
    } else {
      tier = tiers.find(t => hoursUntil >= t.hoursBefore) || null
      pct = tier ? tier.refundPct : 0
    }
  }
  return { refundable, pct, amount: round2(refundable * pct / 100), hoursUntil: round2(hoursUntil), tier }
}

/**
 * Move the money back through the provider that took it, and record it on the
 * appointment. Idempotent per appointment (PayPal-Request-Id = ref_{appointmentId}
 * plus a suffix for deliberate follow-up refunds), so a retried cancel can't refund twice.
 *
 * @returns {Promise<{ refunded: boolean, amount: number, refundId?: string, status?: string, manual?: boolean, reason?: string }>}
 */
async function refundAppointment({ business, appointment, amount, reason, initiatedBy = 'customer', requestSuffix = '', notify = true }) {
  const value = round2(amount)
  if (!(value > 0)) return { refunded: false, amount: 0, reason: 'nothing_to_refund' }
  if (!appointment.paymentId) return { refunded: false, amount: value, manual: true, reason: 'no_payment_on_record' }
  // A sample booking's PayPal payment is shared by every demo session: never refund it.
  if (appointment.seeded) return { refunded: false, amount: value, reason: 'sample_booking' }

  const providerId = appointment.paymentProvider || providerIdFor(business)
  const provider = getProviderById(providerId)
  const currency = appointment.currency || currencyOf(business)

  let r
  try {
    r = await provider.refund({
      captureId: appointment.paymentId,
      amount:    value,
      currency,
      requestId: `ref_${appointment.appointmentId}${requestSuffix}`,
      note:      reason || `Refund for your ${appointment.serviceName || 'booking'} at ${business.name}`,
      merchantId: appointment.payeeMerchantId || undefined
    })
  } catch (err) {
    if (err.code === 'NOT_SUPPORTED') return { refunded: false, amount: value, manual: true, reason: 'provider_has_no_refund_api' }
    log.error('refund_failed', err, { businessId: business.businessId, appointmentId: appointment.appointmentId, providerId })
    throw err
  }

  const refundAmount = round2((Number(appointment.refundAmount) || 0) + r.amount)
  await updateAppointment(business.businessId, appointment.startTime, appointment.appointmentId, {
    refundId:     r.refundId,
    refundStatus: r.status,
    refundAmount,
    refundedAt:   new Date().toISOString(),
    refundReason: reason || null,
    refundInitiatedBy: initiatedBy,
    paymentStatus: refundAmount >= round2(Number(appointment.amountPaid) || 0) ? 'refunded' : 'partially_refunded'
  })
  // The booking's PayPal invoice shows the refund too (never throws).
  const inv = await require('./invoices').recordRefund({ business, appointment, amount: r.amount, refundId: r.refundId })
  // Cancel flows send one combined message per side instead (core/bookingMail).
  if (notify) await notifyRefund({ business, appointment: { ...appointment, refundAmount }, amount: r.amount, currency, initiatedBy, reason })
  require('../services/trace').event('db', 'Refund recorded on the booking', { refund: require('../services/trace').short(r.refundId), status: r.status, totalRefunded: refundAmount, paymentStatus: refundAmount >= round2(Number(appointment.amountPaid) || 0) ? 'refunded' : 'partially_refunded' })
  log.info('refund_issued', { businessId: business.businessId, appointmentId: appointment.appointmentId, providerId, amount: r.amount, status: r.status })
  return { refunded: true, amount: r.amount, refundId: r.refundId, status: r.status, ...(inv.invoiceStatus ? { invoiceStatus: inv.invoiceStatus } : {}) }
}

// Customer gets the refund notice; the owner gets an alert. Never throws.
async function notifyRefund({ business, appointment, amount, currency, initiatedBy, reason }) {
  try {
    const { formatMoney } = require('../utils/money')
    const { notifyCustomer, notifyOwner } = require('../services/notify')
    const { getCustomer } = require('../services/dynamo/customers')
    const money = formatMoney(amount, currency)
    const svc = appointment.serviceName || 'booking'
    const customer = appointment.customerId ? await getCustomer(appointment.customerId) : null
    // The updated receipt (it shows the refund) goes to both sides.
    const receipt = await require('./invoices').receiptForBooking(business, appointment)
    const attachments = receipt ? [receipt] : undefined
    if (customer) {
      await notifyCustomer({
        business, customer, channel: appointment.createdVia, kind: 'refund', attachments,
        subject: `Refund issued: ${money} — ${business.name}`,
        text: `${money} has been refunded to your ${appointment.paymentProvider === 'paypal' ? 'PayPal account' : 'original payment method'} for your ${svc}.${reason ? `\nReason: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}` : ''}\nPayPal refunds usually show instantly; card refunds can take a few days.`
      })
    }
    await notifyOwner({
      business, kind: 'refund', attachments,
      subject: `Refund issued: ${money} — ${svc}`,
      text: `${money} was refunded to ${appointment.customerName || 'the customer'} for ${svc} (${initiatedBy === 'owner' ? 'issued by you' : 'customer cancelled; policy applied automatically'}).`
    })
  } catch (err) {
    log.warn('refund_notify_failed', { err: err.message })
  }
}

module.exports = { quoteRefund, refundAppointment }
