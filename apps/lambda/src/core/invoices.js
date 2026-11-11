// @ts-check
'use strict'

// ─── PayPal invoices ─────────────────────────────
// Every PayPal-paid booking (and pack) gets a real invoice in the PayPal account
// that received the money, marked paid; balances and refunds are recorded on the
// same invoice. Nothing here throws: a booking is never held up by its invoice.
// If PayPal says no, the error is saved on the booking and Flow's own receipt
// PDF still goes out. issue() can be called again to finish what's missing.

const { updateAppointment } = require('../services/dynamo/appointments')
const { formatMoney, round2, currencyOf } = require('../utils/money')
const { fmtLocal, tzOf } = require('../utils/time')
const trace = require('../services/trace')
const log = require('../utils/logger')

const paypal = () => require('../services/payments/paypal')
const keysPresent = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)

const STATUS_LABEL = {
  DRAFT: 'Draft', SENT: 'Unpaid', UNPAID: 'Unpaid', PAID: 'Paid', MARKED_AS_PAID: 'Paid', PARTIALLY_PAID: 'Partly paid',
  REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Partly refunded', MARKED_AS_REFUNDED: 'Refunded', CANCELLED: 'Cancelled'
}
const statusLabel = s => (s ? STATUS_LABEL[s] || s : null)

function staffName(business, unitId) {
  return (business.config?.staff || []).find(s => s.staffId === unitId)?.name || null
}

/** Was this paid through PayPal (so there's a PayPal payment to invoice)? Returns why not, or null. */
function notInvoiceable(r) {
  if (r.seeded || String(r.paymentId || '').startsWith('hist-')) return 'demo history: never charged through PayPal'
  if (String(r.paymentId || '').startsWith('membership:') || r.membershipId) return 'covered by a membership: nothing was paid'
  if (r.paymentProvider !== 'paypal' || !r.paymentId) return 'not paid through PayPal'
  if (!(Number(r.amountPaid) > 0)) return 'nothing was paid'
  return null
}

// PayPal's answer in plain words, saved on the booking and shown to the owner.
function reasonOf(err, acct = {}) {
  const code = String(err?.code || '')
  if (/NOT_AUTHORIZED|PERMISSION|AUTHORIZATION|INSUFFICIENT_SCOPE/i.test(code) || err?.status === 403 || err?.status === 401) {
    // The demo account is Flow's own: the fix is in Flow's PayPal app, not a reconnect.
    return acct.merchantId
      ? "PayPal didn't allow invoicing on this account (reconnect PayPal and allow invoices)"
      : "PayPal didn't allow invoicing yet: Flow's PayPal app needs Invoicing switched on in the PayPal developer dashboard"
  }
  if (/PAYPAL_CLIENT_ID/.test(String(err?.message))) return "PayPal isn't set up on this server yet (sandbox keys missing)"
  return `PayPal error (${code || err?.status || 'unknown'})`
}

const account = (business, r) => ({
  merchantId: r.payeeMerchantId || null,
  // PayPal identifies the invoicer by its PayPal login: the connected business, or the platform account.
  invoicerEmail: r.payeeMerchantId ? (business.paypalEmail || undefined) : (process.env.PAYPAL_PLATFORM_EMAIL || undefined)
})

/**
 * Create, issue and mark paid, resuming from whatever is already done.
 * `save(fields)` stores the invoice fields on the record (booking or pack).
 */
async function issue({ business, record: r, customer, lines, total, reference, requestKey, save }) {
  const why = notInvoiceable(r)
  if (why) return { skipped: why }
  if (!keysPresent()) return { skipped: "PayPal isn't set up on this server yet (sandbox keys missing)" }
  const currency = r.currency || currencyOf(business)
  const acct = account(business, r)
  const state = { invoiceId: r.invoiceId || null, invoiceNumber: r.invoiceNumber || null, invoiceStatus: r.invoiceStatus || null,
    invoiceUrl: r.invoiceUrl || null, invoicerUrl: r.invoicerUrl || null, invoicePaid: Number(r.invoicePaid || 0) }
  try {
    if (!state.invoiceId) {
      const inv = await paypal().createInvoice({
        ...acct, businessName: business.name, customer, lines, currency, reference,
        note: `Paid with PayPal through Flow. Payment ${r.paymentId}.`,
        terms: business.config?.policies?.cancellation || undefined,
        requestId: `inv_${requestKey}`
      })
      Object.assign(state, { invoiceId: inv.invoiceId, invoiceNumber: inv.number, invoiceStatus: 'DRAFT', invoiceUrl: inv.recipientUrl, invoicerUrl: inv.invoicerUrl })
      await save({ ...state, invoiceError: null })
    }
    if (state.invoiceStatus === 'DRAFT') {
      await paypal().sendInvoice({ ...acct, invoiceId: state.invoiceId, requestId: `invsend_${requestKey}` })
      state.invoiceStatus = 'UNPAID'
    }
    const toRecord = round2(Number(r.amountPaid) - state.invoicePaid)
    if (toRecord > 0) {
      await paypal().recordInvoicePayment({ ...acct, invoiceId: state.invoiceId, amount: toRecord, currency, paidAt: r.paidAt || r.createdAt, captureId: state.invoicePaid > 0 && r.balancePaymentId ? r.balancePaymentId : r.paymentId, requestId: `invpay_${requestKey}_${Math.round(Number(r.amountPaid) * 100)}` })
      state.invoicePaid = round2(state.invoicePaid + toRecord)
      state.invoiceStatus = state.invoicePaid + 0.001 >= total ? 'PAID' : 'PARTIALLY_PAID'
    }
    await save({ ...state, invoiceError: null })
    trace.event('paypal', `Invoice${state.invoiceNumber ? ` ${state.invoiceNumber}` : ''} is ${statusLabel(state.invoiceStatus)?.toLowerCase()} in ${acct.merchantId ? "the business's" : "the platform's"} PayPal`, { total: formatMoney(total, currency), paid: formatMoney(state.invoicePaid, currency) })
    return { ...state }
  } catch (err) {
    const reason = reasonOf(err, acct)
    log.warn('invoice_failed', { businessId: business.businessId, ref: requestKey, code: err?.code, status: err?.status })
    trace.event('paypal', 'Invoice not finished: the receipt PDF still goes out', { reason })
    try { await save({ ...state, invoiceError: reason }) } catch { /* the reason is in the trace and the log */ }
    return { ...state, error: reason }
  }
}

const saveOnBooking = (business, a) => fields => updateAppointment(business.businessId, a.startTime, a.appointmentId, fields)

function bookingLines(business, a) {
  const tz = tzOf(business)
  const staff = staffName(business, a.unitId)
  const desc = `${fmtLocal(a.startTime, tz)}${staff ? ` with ${staff}` : ''}`
  // A member discount is the price they pay; a deposit leaves the rest due on the same invoice.
  const total = a.memberDiscountPct ? Number(a.amountPaid) : (Number(a.totalAmount) || Number(a.amountPaid))
  return { total: round2(total), lines: [{ name: a.serviceName || 'Booking', description: a.memberDiscountPct ? `${desc} · member price (${a.memberDiscountPct}% off)` : desc, amount: round2(total) }] }
}

/** Invoice a paid booking (or finish one that's part-done). */
async function issueForBooking({ business, appointment: a, customer }) {
  const { total, lines } = bookingLines(business, a)
  const out = await issue({
    business, record: a, customer: customer || { name: a.customerName }, lines, total,
    reference: `Booking ${String(a.appointmentId).slice(0, 8)}`, requestKey: a.appointmentId, save: saveOnBooking(business, a)
  })
  if (!out.skipped) Object.assign(a, { ...out, invoiceError: out.error || null })
  return out
}

/** Record a refund (already made through PayPal) on the booking's invoice. */
async function recordRefund({ business, appointment: a, amount, refundId }) {
  if (!a.invoiceId || !(amount > 0)) return { skipped: a.invoiceId ? 'nothing refunded' : 'no invoice' }
  const currency = a.currency || currencyOf(business)
  try {
    await paypal().recordInvoiceRefund({ ...account(business, a), invoiceId: a.invoiceId, amount, currency, requestId: `invref_${refundId || a.appointmentId}` })
    const refunded = round2(Number(a.invoiceRefunded || 0) + amount)
    const status = refunded + 0.001 >= Number(a.invoicePaid || a.amountPaid || 0) ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    await updateAppointment(business.businessId, a.startTime, a.appointmentId, { invoiceStatus: status, invoiceRefunded: refunded })
    Object.assign(a, { invoiceStatus: status, invoiceRefunded: refunded })
    return { invoiceStatus: status }
  } catch (err) {
    const reason = reasonOf(err, account(business, a))
    trace.event('paypal', 'Refund not recorded on the invoice', { reason })
    try { await updateAppointment(business.businessId, a.startTime, a.appointmentId, { invoiceError: `Refund not recorded on the invoice: ${reason}` }) } catch { /* logged above */ }
    return { error: reason }
  }
}

/** Invoice a pack (one PayPal payment). Monthly memberships use PayPal's own receipts. */
async function issueForPack({ business, customer, membership: m, save }) {
  if (m.kind !== 'pack' && m.billing !== 'saved_paypal') return { skipped: 'monthly memberships use PayPal subscription receipts' }
  const record = { paymentProvider: 'paypal', paymentId: m.captureId, amountPaid: m.amountPaid ?? m.price, currency: m.currency, payeeMerchantId: business.paypalMerchantId || null, invoiceId: m.invoiceId, invoiceStatus: m.invoiceStatus, invoicePaid: m.invoicePaid }
  const out = await issue({
    business, record, customer, total: round2(Number(record.amountPaid)),
    lines: [{ name: m.planName, description: m.kind === 'pack' ? `Pack, valid ${m.validDays || 180} days` : 'Monthly membership, first month (then monthly from the saved PayPal)', amount: round2(Number(record.amountPaid)) }],
    reference: `${m.kind === 'pack' ? 'Pack' : 'Membership'} ${String(m.membershipId).slice(0, 8)}`, requestKey: m.membershipId,
    save: async fields => { Object.assign(m, fields); if (save) await save(fields) }
  })
  return out
}

// ── Receipt PDF (attached to the messages) ─────────────────────────────────────

/** The receipt for a booking as it stands now. `over` lets a caller show a refund just made. */
async function receiptForBooking(business, a, over = {}) {
  const r = { ...a, ...over }
  if (!(Number(r.amountPaid) > 0)) return null
  try {
    const { renderReceiptPdf } = require('../utils/receipt')
    const { total } = bookingLines(business, r)
    const content = await renderReceiptPdf({
      businessName: business.name, serviceName: r.serviceName, customerName: r.customerName, staffName: staffName(business, r.unitId),
      amount: Number(r.amountPaid), total, refunded: Number(r.refundAmount || 0), currency: r.currency || currencyOf(business),
      paymentId: r.paymentId, paidAt: r.paidAt || r.createdAt || new Date().toISOString(), bookingTime: r.startTime, timeZone: tzOf(business),
      invoiceNumber: r.invoiceNumber || null, invoiceStatus: statusLabel(r.invoiceStatus) || paymentLabel(r, total),
      policy: business.config?.policies?.cancellation || null
    })
    return { filename: `receipt-${r.invoiceNumber || String(r.appointmentId).slice(0, 8)}.pdf`, content, contentType: 'application/pdf' }
  } catch (err) {
    log.error('receipt_pdf_failed', err, { appointmentId: a.appointmentId })
    return null
  }
}

function paymentLabel(r, total) {
  const refunded = Number(r.refundAmount || 0)
  if (refunded > 0) return refunded + 0.001 >= Number(r.amountPaid) ? 'Refunded' : 'Partly refunded'
  return Number(r.amountPaid) + 0.001 >= total ? 'Paid' : 'Partly paid'
}

async function receiptForPack(business, customer, m) {
  try {
    const { renderReceiptPdf } = require('../utils/receipt')
    const content = await renderReceiptPdf({
      businessName: business.name, serviceName: m.planName, customerName: customer?.name, amount: Number(m.amountPaid ?? m.price),
      currency: m.currency || currencyOf(business), paymentId: m.captureId, paidAt: m.startedAt || new Date().toISOString(),
      bookingTime: m.startedAt || new Date().toISOString(), timeZone: tzOf(business),
      invoiceNumber: m.invoiceNumber || null, invoiceStatus: statusLabel(m.invoiceStatus) || 'Paid'
    })
    return { filename: `receipt-${m.invoiceNumber || String(m.membershipId).slice(0, 8)}.pdf`, content, contentType: 'application/pdf' }
  } catch (err) {
    log.error('receipt_pdf_failed', err, { membershipId: m.membershipId })
    return null
  }
}

/** One line for a message: the invoice number, its status and where to see it. */
function invoiceLine(r, who = 'customer') {
  if (!r.invoiceNumber) return ''
  const url = who === 'owner' ? r.invoicerUrl : r.invoiceUrl
  return `PayPal invoice ${r.invoiceNumber} (${statusLabel(r.invoiceStatus)?.toLowerCase() || 'issued'})${url ? `: ${url}` : ''}. The receipt PDF is attached.`
}

/** What tools show for one booking's invoice. */
function view(business, a) {
  const cur = a.currency || currencyOf(business)
  return {
    booking_id: String(a.appointmentId).slice(0, 8),
    business: business.name,
    service: a.serviceName || null,
    customer: a.customerName || null,
    when: fmtLocal(a.startTime, tzOf(business)),
    paid: formatMoney(Number(a.amountPaid || 0), cur),
    refunded: a.refundAmount ? formatMoney(Number(a.refundAmount), cur) : null,
    invoice: a.invoiceNumber || null,
    status: statusLabel(a.invoiceStatus) || (notInvoiceable(a) ? 'no PayPal invoice' : 'not issued yet'),
    ...(a.invoiceError ? { problem: a.invoiceError } : {}),
    ...(notInvoiceable(a) ? { why_no_invoice: notInvoiceable(a) } : {})
  }
}

/** Send one booking's receipt PDF and invoice link to the customer's inbox again (asked for by the owner or customer). */
async function sendReceipt({ business, appointment: a, customer }) {
  const receipt = await receiptForBooking(business, a)
  if (!receipt) return { sent: false, error: 'Nothing was paid for this booking, so there is no receipt.' }
  const sent = await require('../services/notify').notifyCustomer({
    business, customer, channel: 'inbox', kind: 'invoice', attachments: [receipt],
    subject: `${a.invoiceNumber ? `Invoice ${a.invoiceNumber}` : 'Your receipt'}: ${a.serviceName || 'booking'} — ${business.name}`,
    text: [`Here's the receipt for your ${a.serviceName || 'booking'} at ${business.name} on ${fmtLocal(a.startTime, tzOf(business))}.`, invoiceLine(a) || 'The receipt PDF is attached.'].join('\n\n')
  })
  return { sent: Array.isArray(sent) && sent.includes('inbox'), attachment: receipt.filename }
}

module.exports = { issueForBooking, issueForPack, recordRefund, receiptForBooking, receiptForPack, invoiceLine, sendReceipt, view, statusLabel, notInvoiceable }
