// @ts-check
'use strict'

// ─── Payment → booking confirmation (provider-agnostic) ───────────────────────
// One path from "money is in" to "booking confirmed + customer told", shared by
// every gateway:
//   • Cashfree charges in one step; its webhook calls confirmPaidBooking().
//   • PayPal separates approve from capture; finalizeOrder() runs when the buyer
//     returns from PayPal (or when the APPROVED/CAPTURE webhook arrives if they
//     closed the tab) and only CAPTURES after re-checking the seat is still ours.
//     So a slot that disappeared while the customer was on PayPal is never charged.
//
// Exactly-once: the pending intent is consumed with a conditional delete
// (consumePendingPayment), so the return redirect and webhook retries racing each
// other still produce a single booking. capture() itself is idempotent on PayPal.

const { getBusiness, getCustomer } = require('../services/dynamo')
const { getPendingPayment, consumePendingPayment } = require('../services/dynamo/pendingPayments')
const { saveResult, getResult } = require('../services/dynamo/processedMessages')
const { updateAppointment } = require('../services/dynamo/appointments')
const { getProviderById } = require('../services/payments')
const { createBooking, getService } = require('./engine')
const { getFreeUnitsForSlot } = require('./units')
const redis = require('../services/redis')
const { notifyCustomer, notifyOwner } = require('../services/notify')
const { buildReceipt, formatIST } = require('../utils/receipt')
const invoices = require('./invoices')
const { round2, formatMoney, currencyOf } = require('../utils/money')
const trace = require('../services/trace')
const log = require('../utils/logger')

const resultKey = providerOrderId => `payres:${providerOrderId}`

function tzOf(business) {
  return business?.timezone || 'Asia/Kolkata'
}

// Free a payment-time seat hold for an intent that won't be confirmed. Only frees
// it if this customer still owns the hold (never someone else's seat).
async function releaseHeldSeat(pending) {
  if (!pending || pending.kind || !pending.preferredUnitId || !pending.startIso) return
  await redis.releaseSlot(pending.businessId, pending.startIso, pending.preferredUnitId, pending.customerId).catch(() => {})
}

// Is the seat this intent was holding still bookable by THIS customer? Re-takes
// the hold if it simply expired while they were on PayPal and nobody else took it.
async function seatStillAvailable(business, pending) {
  if (pending.kind) return true                       // balance / provider charge: no seat
  const service = getService(business, pending.serviceId)
  if (service.unitType === 'queue') return true
  const duration = service.duration || 60
  const endIso = new Date(new Date(pending.startIso).getTime() + duration * 60_000).toISOString()
  const free = await getFreeUnitsForSlot(business, service, pending.startIso, endIso)
  if (pending.preferredUnitId && !free.includes(pending.preferredUnitId)) return false
  if (!free.length) return false
  const hold = await redis.holdSlotForPayment(business.businessId, pending.startIso, pending.preferredUnitId || free[0], pending.customerId)
  return hold.held
}

/**
 * Turn a paid intent into a confirmed booking (or mark an existing appointment
 * paid for balance/provider charges) and notify the customer.
 *
 * @param {object} pending  - the CONSUMED pending-payment intent
 * @param {object} payment  - { provider, paymentId, providerOrderId, amount, currency, paidAt, paymentGroup? }
 */
async function confirmPaidBooking(pending, payment) {
  const business = await getBusiness(pending.businessId)
  if (!business) throw new Error(`business ${pending.businessId} missing`)
  const currency = payment.currency || pending.currency || currencyOf(business)
  const amountPaid = payment.amount ?? pending.amountDue ?? pending.amount

  // Balance top-up: it targets an existing appointment (no new booking), just mark it paid.
  if (pending.kind === 'balance') {
    await updateAppointment(pending.businessId, pending.startTime, pending.appointmentId, {
      amountPaid: pending.totalAmount, paymentStatus: 'paid', balancePaymentId: payment.paymentId
    })
    const customer = (pending.customerId && await getCustomer(pending.customerId)) || { phone: pending.customerPhone }
    // The same PayPal invoice now shows the rest paid; both sides get the updated receipt.
    const booking = await paidBooking(business, pending, payment, currency)
    const receipt = booking ? await invoices.receiptForBooking(business, booking) : null
    const money = formatMoney(amountPaid, currency)
    await notifyCustomer({
      business, customer, channel: pending.channel, attachments: receipt ? [receipt] : undefined,
      subject: `Payment received — ${pending.serviceName}`,
      text: [`Payment received (${money}). Your ${pending.serviceName} is now fully paid. Thank you!`, booking ? invoices.invoiceLine(booking) : ''].filter(Boolean).join('\n\n')
    })
    await notifyOwner({
      business, kind: 'balance_paid', attachments: receipt ? [receipt] : undefined,
      subject: `Paid in full: ${pending.serviceName}`,
      text: [`${customer.name || 'The customer'} paid the remaining ${money} for ${pending.serviceName} with ${payment.provider === 'paypal' ? 'PayPal' : payment.provider} (payment ${payment.paymentId}).`, booking ? invoices.invoiceLine(booking, 'owner') : ''].filter(Boolean).join('\n\n')
    })
    log.info('payment_balance_paid', { businessId: pending.businessId, appointmentId: pending.appointmentId, provider: payment.provider })
    return { status: 'paid', channel: pending.channel, kind: pending.kind, appointmentId: pending.appointmentId, serviceName: pending.serviceName, amount: amountPaid, currency }
  }

  const customer = await getCustomer(pending.customerId)
  if (!customer) throw new Error(`customer ${pending.customerId} missing`)

  const appointment = await createBooking({
    business,
    serviceId:  pending.serviceId,
    startIso:   pending.startIso,
    customer,
    paymentId:  payment.paymentId,
    createdVia: pending.channel || 'web',
    preferredUnitId: pending.preferredUnitId || undefined,
    notes:      pending.customerNotes || undefined,
    photos:     pending.customerPhotos || undefined,
    payment:    { provider: payment.provider, providerOrderId: payment.providerOrderId, currency, payeeMerchantId: payment.payeeMerchantId, amount: amountPaid, memberDiscountPct: pending.memberDiscountPct || null }
  })

  const tz = tzOf(business)
  const when = formatIST(appointment.startTime, tz)
  const result = {
    status: 'confirmed', channel: pending.channel, appointmentId: appointment.appointmentId, serviceName: pending.serviceName,
    startTime: appointment.startTime, when, amount: amountPaid, currency, paymentId: payment.paymentId,
    businessName: business.name, duplicate: !!appointment.duplicate
  }

  // The booking now exists. Nothing after this point may throw: an error here
  // would reach finalizeOrder's auto-refund branch and refund a confirmed booking.
  try {
    await afterBooking({ business, customer, pending, payment, appointment, result, amountPaid, currency, tz, when })
  } catch (err) {
    log.error('post_booking_side_effects_failed', err, { appointmentId: appointment.appointmentId })
  }
  if (appointment.duplicate) return result

  log.info('payment_confirmed_booking', {
    businessId: business.businessId, appointmentId: appointment.appointmentId,
    provider: payment.provider, providerOrderId: payment.providerOrderId
  })
  return result
}

// Index, receipt and notification for a just-created (or duplicate) booking.
async function afterBooking({ business, customer, pending, payment, appointment, amountPaid, currency, tz, when }) {
  // capture → appointment pointer, so refund webhooks (including refunds the owner
  // issues from PayPal itself) can find the booking without a table scan.
  if (!appointment.duplicate && payment.paymentId) {
    try {
      await saveResult(`cap:${payment.paymentId}`, {
        businessId: business.businessId, startTime: appointment.startTime, appointmentId: appointment.appointmentId,
        amountPaid: appointment.amountPaid, traceScope: trace.currentScope()
      }, 400 * 24 * 60 * 60)
    } catch (err) {
      log.warn('capture_index_failed', { err: err.message })
    }
  }

  if (appointment.duplicate) {
    await notifyCustomer({ business, customer, channel: pending.channel, text: `Your booking is already confirmed for ${when}.` })
    return
  }

  // Deterministic receipt. India + GST "always invoice" keeps the GST tax invoice;
  // everyone else gets the plain receipt PDF (falls back to a text receipt).
  const receiptData = {
    businessName: business.name, serviceName: pending.serviceName,
    amount: amountPaid, currency, paymentId: payment.paymentId, paidAt: payment.paidAt,
    bookingTime: appointment.startTime, timeZone: tz
  }
  // A paid invoice in the PayPal account that got the money (never throws).
  const rec = { ...appointment, serviceName: appointment.serviceName || pending.serviceName, paidAt: payment.paidAt }
  if (payment.provider === 'paypal') await invoices.issueForBooking({ business, appointment: rec, customer })

  let pdf = null
  let pdfName = 'receipt.pdf'
  try {
    const receipt = await invoices.receiptForBooking(business, rec)
    if (receipt) { pdf = receipt.content; pdfName = receipt.filename }
  } catch (err) {
    log.error('receipt_pdf_failed', err, { appointmentId: appointment.appointmentId })
  }

  const money = formatMoney(amountPaid, currency)
  const attachments = pdf ? [{ filename: pdfName, content: pdf, contentType: 'application/pdf' }] : undefined
  await notifyCustomer({
    business, customer, channel: pending.channel, kind: 'booking_confirmed', attachments,
    subject: `Confirmed: ${pending.serviceName} at ${business.name} — ${when}`,
    text: `Payment received (${money})! Your ${pending.serviceName} booking is confirmed for ${when}.` + balanceLine(appointment, amountPaid, currency) +
      (rec.invoiceNumber ? `\n\n${invoices.invoiceLine(rec)}` : '') +
      (pdf ? '' : `\n\n${buildReceipt(receiptData)}`),
    html: confirmationHtml({ business, serviceName: pending.serviceName, when, money, paymentId: payment.paymentId, provider: payment.provider, invoice: rec })
  })
  const invoiceNote = rec.invoiceNumber ? `\n\n${invoices.invoiceLine(rec, 'owner')}`
    : rec.invoiceError ? `\n\nNo PayPal invoice yet: ${rec.invoiceError}. Ask your AI to issue_invoice for this booking once that's fixed.` : ''
  await notifyOwner({
    business, kind: 'new_booking', attachments,
    subject: `New booking: ${pending.serviceName} — ${when}`,
    text: `${customer.name || 'A customer'} booked ${pending.serviceName} for ${when}.\nPaid ${money} via ${payment.provider === 'paypal' ? 'PayPal' : payment.provider} (payment ${payment.paymentId}).\nBooked on: ${pending.channel || 'web'}.${pending.customerNotes ? `\nCustomer notes: ${pending.customerNotes}` : ''}${invoiceNote}`
  })
}

// A deposit booking: what's left and how to pay it (PayPal, any channel; no paying at the visit).
function balanceLine(appointment, amountPaid, currency) {
  const left = round2(Number(appointment.totalAmount || 0) - Number(amountPaid || 0))
  return left > 0.001 ? `\n\nThe remaining ${formatMoney(left, currency)} is paid with PayPal before your visit: say "pay the rest" in the chat or to the voice assistant, or use Pay the rest in My bookings.` : ''
}

// The booking after a balance payment, with its invoice brought up to date.
async function paidBooking(business, pending, payment, currency) {
  try {
    const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
    const a = (await getAppointmentsForBusiness(pending.businessId, pending.startTime, pending.startTime)).find(x => x.appointmentId === pending.appointmentId)
    if (!a) return null
    const rec = { ...a, amountPaid: pending.totalAmount ?? a.amountPaid, currency: a.currency || currency }
    if (payment.provider === 'paypal' && rec.paymentProvider === 'paypal') await invoices.issueForBooking({ business, appointment: rec, customer: { name: a.customerName } })
    return rec
  } catch (err) {
    log.warn('balance_invoice_failed', { err: err.message })
    return null
  }
}

function confirmationHtml({ business, serviceName, when, money, paymentId, provider, invoice }) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  return `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;color:#1b1f24">
<h2 style="margin:0 0 4px">You're booked ✓</h2><div style="color:#6b7280;margin-bottom:16px">${esc(business.name)}</div>
<table style="width:100%;border-collapse:collapse;font-size:15px">
<tr><td style="color:#6b7280;padding:6px 0">Service</td><td style="text-align:right">${esc(serviceName)}</td></tr>
<tr><td style="color:#6b7280;padding:6px 0">When</td><td style="text-align:right">${esc(when)}</td></tr>
<tr><td style="color:#6b7280;padding:6px 0">Paid</td><td style="text-align:right;font-weight:600">${esc(money)} via ${provider === 'paypal' ? 'PayPal' : esc(provider)}</td></tr>
<tr><td style="color:#6b7280;padding:6px 0">Payment ID</td><td style="text-align:right;font-size:12px">${esc(paymentId)}</td></tr>
${invoice?.invoiceNumber ? `<tr><td style="color:#6b7280;padding:6px 0">PayPal invoice</td><td style="text-align:right">${esc(invoice.invoiceNumber)} · ${esc(invoices.statusLabel(invoice.invoiceStatus))}</td></tr>` : ''}
</table>
${invoice?.invoiceUrl ? `<p style="margin-top:14px"><a href="${esc(invoice.invoiceUrl)}" style="color:#0070ba">View your invoice on PayPal</a> · the receipt PDF is attached.</p>` : ''}
<p style="color:#6b7280;font-size:13px;margin-top:16px">Need to cancel? Just ask in the chat — refunds follow ${esc(business.name)}'s cancellation policy and are sent back automatically.</p></div>`
}

/**
 * PayPal: the buyer approved (return URL or webhook). Re-check the seat, capture,
 * confirm. Safe to call any number of times for the same order.
 *
 * @returns {Promise<object>} { status: confirmed | paid | slot_taken | pending | failed | not_found, ... }
 */
async function finalizeOrder(providerOrderId, { source = 'return', captured = null } = {}) {
  const pending = await getPendingPayment(providerOrderId)
  // Continue the customer's timeline: the scope was saved with the checkout.
  if (pending?.traceScope && trace.currentScope() !== pending.traceScope) {
    return trace.run(pending.traceScope, () => trace.forBusiness({ businessId: pending.businessId }, () => finalizeWithPending(providerOrderId, source, pending, captured)))
  }
  return finalizeWithPending(providerOrderId, source, pending, captured)
}

// captured: a saved-PayPal order PayPal already captured (core/paymentFlow.payWithSaved).
// The seat was held a moment ago and the money has moved, so there is no seat
// check to skip the capture on: a booking that fails is refunded below.
async function finalizeWithPending(providerOrderId, source, pending, captured = null) {
  trace.event('paypal', source === 'return' ? 'Buyer approved → back from PayPal' : source === 'saved' ? 'Paid with saved PayPal (customer agreed to the amount)' : source === 'allowance' ? 'Paid with saved PayPal within the customer\'s AI allowance (no yes needed)' : `PayPal webhook (${source}) — signature verified`, { order: trace.short(providerOrderId) })
  if (!pending) {
    // Already finalised by the other path (return vs webhook), or unknown.
    trace.event('db', 'Already handled by the other path — nothing to do (idempotent)', { order: trace.short(providerOrderId) })
    return (await getResult(resultKey(providerOrderId))) || { status: 'not_found' }
  }
  const provider = getProviderById(pending.provider || 'paypal')
  const business = await getBusiness(pending.businessId)

  // 1. Seat check BEFORE money moves. If it's gone, don't capture: the approved
  //    order just expires unused and the customer is never charged.
  const seatOk = captured ? true : await seatStillAvailable(business, pending)
  if (!captured) trace.event('policy', seatOk ? 'Seat re-checked before charging: still free ✓' : 'Seat re-checked before charging: GONE → not capturing, customer not charged', { start: pending.startIso || pending.startTime })
  if (!seatOk) {
    const consumed = await consumePendingPayment(providerOrderId)
    if (!consumed) return (await getResult(resultKey(providerOrderId))) || { status: 'not_found' }
    const result = { status: 'slot_taken', channel: pending.channel, charged: false, serviceName: pending.serviceName, startTime: pending.startIso, businessName: business?.name }
    await saveResult(resultKey(providerOrderId), result)
    const customer = await getCustomer(pending.customerId)
    if (customer) {
      await notifyCustomer({ business, customer, channel: pending.channel,
        text: `Sorry — that ${pending.serviceName} slot was taken while you were paying. You have NOT been charged. Reply here and I'll find you another time.` })
    }
    log.warn('paypal_slot_taken_not_captured', { providerOrderId, businessId: pending.businessId, source })
    return result
  }

  // 2. Capture (idempotent).
  let cap = captured
  try {
    if (!cap) cap = await provider.capture(providerOrderId)
  } catch (err) {
    if (err.code === 'ORDER_NOT_APPROVED') return { status: 'awaiting_approval' }
    if (err.code === 'INSTRUMENT_DECLINED' || err.code === 'PAYER_ACTION_REQUIRED') {
      return { status: 'declined', retry: true, message: 'Your payment method was declined — please try again with another one.' }
    }
    throw err
  }
  if (cap.captureStatus === 'PENDING') {
    // eCheck / review hold — PAYMENT.CAPTURE.COMPLETED webhook finishes this later.
    return { status: 'pending', message: 'PayPal is still processing your payment. You will get a confirmation as soon as it clears.' }
  }
  if (cap.captureStatus !== 'COMPLETED') {
    const consumed = await consumePendingPayment(providerOrderId)
    if (consumed) await releaseHeldSeat(consumed)
    const result = { status: 'failed', channel: pending.channel, captureStatus: cap.captureStatus }
    await saveResult(resultKey(providerOrderId), result)
    return result
  }

  // The buyer agreed on PayPal's page to save PayPal: keep it for one-step booking.
  if (cap.savedPaypal && pending.customerId) {
    await require('./savedPaypal').remember(pending.customerId, cap.savedPaypal)
      .catch(err => log.warn('saved_paypal_remember_failed', { err: err.message }))
  }

  // 3. Exactly-once handoff to the booking.
  const consumed = await consumePendingPayment(providerOrderId)
  trace.event('db', consumed ? 'Exactly-once claim won (conditional delete)' : 'Exactly-once claim lost — other path is booking it', { order: trace.short(providerOrderId) })
  if (!consumed) return (await getResult(resultKey(providerOrderId))) || { status: 'processing' }

  const payment = {
    provider: provider.id, paymentId: cap.captureId, providerOrderId,
    amount: cap.amount, currency: cap.currency, paidAt: cap.paidAt, payeeMerchantId: pending.payeeMerchantId || null
  }

  let result
  try {
    // Underpayment guard — never confirm a booking for less than was asked.
    const due = round2(consumed.amountDue ?? consumed.amount)
    if (round2(cap.amount) + 0.001 < due) {
      const e = new Error(`captured ${cap.amount} < due ${due}`); Object.assign(e, { code: 'AMOUNT_MISMATCH' }); throw e
    }
    result = await confirmPaidBooking(consumed, payment)
  } catch (err) {
    // Money was taken but the booking can't be made (extreme race past the seat
    // check, or a mismatch): give it all back automatically.
    log.error('paypal_confirm_failed_refunding', err, { providerOrderId, businessId: consumed.businessId })
    trace.event('policy', `Booking failed after capture (${err.code || 'BOOKING_FAILED'}) → automatic full refund`, { amount: cap.amount })
    await releaseHeldSeat(consumed)
    let refund = null
    try {
      refund = await provider.refund({ captureId: cap.captureId, amount: cap.amount, currency: cap.currency, requestId: `ref_fail_${providerOrderId}`, note: 'Your booking could not be completed — full refund.', merchantId: pending.payeeMerchantId || undefined })
    } catch (rErr) {
      log.error('paypal_auto_refund_failed', rErr, { providerOrderId, captureId: cap.captureId })
    }
    result = { status: 'refunded', channel: consumed.channel, reason: err.code || 'BOOKING_FAILED', refunded: !!refund, amount: cap.amount, currency: cap.currency, serviceName: consumed.serviceName, businessName: business?.name }
    const customer = await getCustomer(consumed.customerId)
    if (customer) {
      await notifyCustomer({ business, customer, channel: consumed.channel,
        text: `Sorry — we couldn't complete your ${consumed.serviceName} booking, so your ${formatMoney(cap.amount, cap.currency)} payment has been refunded in full.` })
    }
  }
  if (cap.savedPaypal && result) result.savedPaypal = require('./savedPaypal').masked(cap.savedPaypal.email)
  await saveResult(resultKey(providerOrderId), result)
  return result
}

/**
 * PayPal cancel_url: the buyer backed out. Free the seat now (the 10-min hold
 * would also expire on its own) but keep the intent so they can still go back
 * and pay with the same link.
 */
async function cancelCheckout(providerOrderId) {
  const pending = await getPendingPayment(providerOrderId)
  if (pending) {
    await trace.run(pending.traceScope, async () => {
      trace.event('paypal', 'Buyer cancelled on PayPal — no charge', { order: trace.short(providerOrderId) })
      await releaseHeldSeat(pending)
    })
  }
  return { status: 'cancelled', serviceName: pending?.serviceName || null }
}

module.exports = { confirmPaidBooking, finalizeOrder, cancelCheckout, releaseHeldSeat, resultKey }
