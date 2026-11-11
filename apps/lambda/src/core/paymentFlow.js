// @ts-check
'use strict'

// ─── Payment request flow (provider-agnostic) ───────────────────────────────
// Holds the seat, creates a checkout with the business's payment provider
// (services/payments — PayPal by default, Cashfree for the India build) and
// delivers the pay link on the customer's channel:
//   whatsapp/voice → Pay Now button (or approved template outside the 24h window)
//   web            → returned to the caller; the chat UI renders a PayPal button
// PayPal: buyer approves → /pay/paypal/return → core/paymentConfirm.finalizeOrder
// re-checks the seat, captures, confirms. Cashfree: its webhook confirms.
//
// The pending intent is keyed by the provider's order id (PayPal's order id
// comes back on the return URL and in every webhook).

const { randomUUID: uuid } = require('crypto')
const { getService } = require('./engine')
const { getFreeUnitsForSlot, priceForUnit } = require('./units')
const { resolveAmountDue } = require('./paymentModes')
const { savePendingPayment } = require('../services/dynamo/pendingPayments')
const { getPaymentProvider } = require('../services/payments')
const { currencyOf, formatMoney } = require('../utils/money')
const trace = require('../services/trace')
const redis = require('../services/redis')
const savedPaypal = require('./savedPaypal')
const log = require('../utils/logger')

// Thrown when the seat is gone (booked or held by another customer mid-payment),
// so the caller can tell the customer instead of sending a doomed payment link.
class SlotUnavailableError extends Error {
  constructor() { super('SLOT_UNAVAILABLE'); this.code = 'SLOT_UNAVAILABLE' }
}

// Thrown when a saved-PayPal payment would charge something other than what the
// customer agreed to (e.g. the stylist picked has another price): quote again.
class PriceChangedError extends Error {
  constructor(amount) { super('PRICE_CHANGED'); this.code = 'PRICE_CHANGED'; this.amount = amount }
}

/**
 * useSaved + expectedAmount: the customer agreed to pay expectedAmount with their
 * saved PayPal, so charge it now (no PayPal page). Anything else, or a saved
 * account PayPal refuses, falls back to the normal PayPal link.
 */
async function requestPayment({ business, serviceId, startIso, customer, channel, preferredUnitId, notes, photos, discountPercent = 0, useSaved = false, expectedAmount, underAllowance = false, clientMetadataId = null, paymentMandate = null }) {
  const service = getService(business, serviceId)
  let { amountDue, requiresPayment } = resolveAmountDue(service)

  if (!requiresPayment) {
    throw new Error('this service does not require payment — call engine.createBooking directly')
  }

  const provider = getPaymentProvider(business)
  if (!provider.isConfigured(business)) {
    throw new Error(`business ${business.businessId} has no ${provider.id} payments connected`)
  }
  const currency = currencyOf(business)

  // Soft-hold the seat for the payment window so two customers can't both be sent
  // a Pay Now link for the last seat and both pay (oversell). Queue services have
  // no finite seat, so nothing to hold. If Redis is down the hold degrades open —
  // the webhook's reserveSlot stays the authoritative final check.
  let reservedUnitId = preferredUnitId || null
  if (service.unitType !== 'queue') {
    const duration = service.duration || 60
    const endIso = new Date(new Date(startIso).getTime() + duration * 60_000).toISOString()
    const freeUnits = await getFreeUnitsForSlot(business, service, startIso, endIso)
    if (!freeUnits.length) throw new SlotUnavailableError()
    reservedUnitId = (preferredUnitId && freeUnits.includes(preferredUnitId)) ? preferredUnitId : freeUnits[0]
    const hold = await redis.holdSlotForPayment(business.businessId, startIso, reservedUnitId, customer.customerId)
    if (!hold.held) throw new SlotUnavailableError()
  }

  // Charge the assigned staff's price if they have an override for this service.
  const priced = priceForUnit(service, business, reservedUnitId)
  if (priced.price !== service.price) amountDue = resolveAmountDue(priced).amountDue
  // A member discount (core/memberships) comes off what's charged now.
  if (discountPercent > 0) amountDue = Math.round(amountDue * (100 - discountPercent)) / 100

  const releaseSeat = () => service.unitType !== 'queue'
    ? redis.releaseSlot(business.businessId, startIso, reservedUnitId, customer.customerId).catch(() => {})
    : null
  const saved = useSaved ? savedPaypal.usable(business, customer) : null
  if (saved && expectedAmount != null && Math.abs(amountDue - expectedAmount) > 0.004) {
    await releaseSeat()
    throw new PriceChangedError(amountDue)
  }

  const referenceId = `flow_${uuid()}`
  const description = `${service.name} — ${business.name}`
  // The owner calendar shows the held seat until PayPal settles it (core/holds).
  const showHold = orderId => service.unitType === 'queue' ? null : require('./holds').add(business, {
    orderId, startIso, minutes: service.duration || 60, unitId: reservedUnitId, serviceName: service.name,
    customerName: customer.name, amount: amountDue, currency, channel
  })

  // (Cashfree: the vendor split is computed in its webhook AFTER payment, when the
  // method is known — gateway cost passthrough + Flow margin; see cashfree.feeBreakdown.)
  const intent = {
    provider:    provider.id,
    referenceId,
    currency,
    traceScope:  trace.currentScope(),
    // Set only when the order explicitly paid a connected business (refunds then act on its behalf).
    payeeMerchantId: provider.id === 'paypal' ? (business.paypalMerchantId || null) : null,
    businessId:  business.businessId,
    serviceId,
    serviceName: service.name,
    startIso,
    customerId:  customer.customerId,
    amountDue,
    channel:     channel || 'web',
    // The exact seat held for this payment — the webhook books THIS unit so the
    // confirmed booking matches what was reserved.
    preferredUnitId: reservedUnitId,
    // Customer details for the business (e.g. what a photo they sent shows).
    customerNotes: notes || null,
    customerPhotos: Array.isArray(photos) && photos.length ? photos : null,
    memberDiscountPct: discountPercent || null
  }

  if (saved) {
    const paid = await payWithSaved({ provider, business, saved, referenceId, amount: amountDue, currency, description, intent, underAllowance, clientMetadataId, paymentMandate })
    if (paid?.savedNeedsApproval) await showHold(paid.orderId)
    if (paid) return { ...paid, amountDue, currency, provider: provider.id }
  }

  let orderId, paymentUrl
  try {
    const checkout = await provider.createCheckout({
      referenceId, amount: amountDue, currency, business, customer, description,
      // The first PayPal payment also saves PayPal for one-step booking next time.
      saveForLater: provider.id === 'paypal' && savedPaypal.canSave(business) && !customer.savedPaypal?.vaultId,
      ...checkoutUrls(provider.id)
    })
    orderId = checkout.providerOrderId
    paymentUrl = checkout.approveUrl
  } catch (err) {
    // Don't keep a seat held for an order that never got created.
    await releaseSeat()
    throw err
  }
  await savePendingPayment(orderId, intent)
  await showHold(orderId)

  if ((channel === 'speaker' || channel === 'mcp') && require('../services/demoInbox').customerInbox(customer)) {
    // Voice booking: a speaker can't show a Pay button, so the link goes to their inbox.
    const money = formatMoney(amountDue, currency)
    await require('../services/notify').notifyCustomer({
      business, customer, channel: 'inbox', kind: 'payment_link',
      subject: `Pay ${money} to confirm your ${service.name} at ${business.name}`,
      text: `You asked Flow (${channel === 'mcp' ? 'via your AI assistant' : 'voice'}) to book ${service.name} at ${business.name}. Pay ${money} with PayPal to confirm — the slot is held for 10 minutes:\n${paymentUrl}`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:460px"><h2 style="margin:0 0 6px">Confirm your booking</h2><p>${service.name} at ${business.name}. The slot is held for 10 minutes.</p><p><a href="${paymentUrl}" style="display:inline-block;background:#ffc439;color:#111;text-decoration:none;border-radius:999px;padding:10px 22px;font-weight:600">Pay ${money} with PayPal</a></p></div>`
    })
  }

  return { orderId, amountDue, currency, paymentUrl, provider: provider.id }
}

/**
 * Charge a saved PayPal, then hand the paid order to the same finalizeOrder every
 * PayPal payment goes through (exactly-once booking, auto-refund if the booking
 * fails). Returns null when PayPal refuses the saved account, so the caller sends
 * the normal link instead; returns a link when PayPal wants the buyer again.
 */
async function payWithSaved({ provider, business, saved, referenceId, amount, currency, description, intent, underAllowance = false, clientMetadataId = null, paymentMandate = null }) {
  let charge
  // Under the AI mandate Flow charges on terms the customer agreed to earlier
  // (MERCHANT); otherwise the customer just said yes (CUSTOMER). PAYPAL_GAPS.md §1.
  const startedBy = underAllowance
    ? { initiator: 'MERCHANT', usagePattern: 'UNSCHEDULED_PREPAID', ...(paymentMandate?.id ? { invoiceId: paymentMandate.id } : {}) }
    : { initiator: 'CUSTOMER', clientMetadataId }
  try {
    charge = await provider.chargeSaved({ referenceId, amount, currency, description, business, vaultId: saved.vaultId, ...startedBy, ...checkoutUrls(provider.id) })
  } catch (err) {
    log.warn('saved_paypal_charge_failed', { businessId: business.businessId, issue: err.code })
    trace.event('paypal', 'Saved PayPal refused → normal PayPal link instead (nothing charged)', { issue: err.code })
    return null
  }
  await savePendingPayment(charge.providerOrderId, intent)
  if (charge.approveUrl) return { orderId: charge.providerOrderId, paymentUrl: charge.approveUrl, savedNeedsApproval: true }
  const { finalizeOrder } = require('./paymentConfirm')
  const result = await finalizeOrder(charge.providerOrderId, { source: underAllowance ? 'allowance' : 'saved', captured: charge.captured })
  return { orderId: charge.providerOrderId, paidWithSaved: true, result }
}

// Where PayPal sends the buyer after approving / backing out. PayPal appends
// ?token={orderId}&PayerID=… to these.
function checkoutUrls(providerId) {
  if (providerId !== 'paypal') return {}
  const api = process.env.API_URL
  return { returnUrl: `${api}/pay/paypal/return`, cancelUrl: `${api}/pay/paypal/cancel` }
}

// Owner-initiated "collect the rest" for a deposit booking: a checkout for the
// balance, sent to the customer's inbox. On payment, paymentConfirm marks the
// appointment fully paid (kind 'balance').
// useSaved: the customer agreed to pay this balance with their saved PayPal.
async function requestBalancePayment({ business, appointment, customer, serviceName, balance, useSaved = false, underAllowance = false, paymentMandate = null, clientMetadataId = null }) {
  const provider = getPaymentProvider(business)
  const currency = appointment.currency || currencyOf(business)
  const referenceId = `flowbal_${uuid()}`
  const description = `Balance — ${serviceName} — ${business.name}`
  const intent = {
    provider: provider.id, referenceId, currency, channel: 'inbox', traceScope: trace.currentScope(),
    payeeMerchantId: provider.id === 'paypal' ? (business.paypalMerchantId || null) : null,
    kind: 'balance', businessId: business.businessId, appointmentId: appointment.appointmentId,
    startTime: appointment.startTime, amount: balance, totalAmount: appointment.totalAmount || 0,
    customerId: customer.customerId, customerPhone: customer.phone, serviceName
  }
  const saved = useSaved ? savedPaypal.usable(business, customer) : null
  if (saved) {
    const paid = await payWithSaved({ provider, business, saved, referenceId, amount: balance, currency, description, intent, underAllowance, paymentMandate, clientMetadataId })
    if (paid?.paidWithSaved) return { ...paid, currency }
    if (paid) return { orderId: paid.orderId, paymentUrl: paid.paymentUrl, currency }
  }
  const { providerOrderId: orderId, approveUrl: paymentUrl } = await provider.createCheckout({
    referenceId, amount: balance, currency, business, customer, description,
    saveForLater: provider.id === 'paypal' && savedPaypal.canSave(business) && !customer.savedPaypal?.vaultId,
    ...checkoutUrls(provider.id)
  })
  await savePendingPayment(orderId, intent)
  await require('../services/notify').notifyCustomer({
    business, customer, channel: 'inbox',
    subject: `Balance due: ${serviceName} at ${business.name}`,
    text: `Please pay the remaining ${formatMoney(balance, currency)} for your ${serviceName}: ${paymentUrl}`
  })
  return { orderId, paymentUrl, currency }
}

module.exports = { requestPayment, requestBalancePayment, SlotUnavailableError, PriceChangedError }
