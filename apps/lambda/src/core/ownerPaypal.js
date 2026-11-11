// @ts-check
'use strict'

// ─── PayPal for the owner's own AI (business MCP link) ────────────────────────
// The owner never pastes a PayPal token. Flow's backend reads PayPal with its
// own app credentials, for the orders it created on the account the business
// connected, so these tools work exactly as long as the MCP link does.
// Read-only: money only moves through refund_booking / cancel_booking (quote
// first, then confirm=true), which also go through the backend.

const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const { formatMoney, round2, currencyOf } = require('../utils/money')
const { dayjs } = require('../utils/time')
const owner = require('./ownerOps')

const MAX_LOOKUPS = 10

const paypal = () => require('../services/payments/paypal')
const environment = () => (process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox')
const keysPresent = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)
const NO_KEYS = { error: "PayPal isn't set up on this Flow server yet (sandbox app keys missing), so live PayPal data can't be read." }

const mask = id => (id ? `${String(id).slice(0, 3)}…${String(id).slice(-3)}` : null)
const maskEmail = e => (e ? String(e).replace(/^(.)[^@]*(@.*)$/, '$1***$2') : null)

// A booking's PayPal reference, or why there isn't one.
function paypalRef(a) {
  // A sample booking with a real pool payment can be looked up; made-up history can't.
  if ((a.seeded && !a.samplePayment) || String(a.paymentId || '').startsWith('hist-')) return { none: 'demo history: seeded visit, never charged through PayPal' }
  if (a.paymentProvider && a.paymentProvider !== 'paypal') return { none: `paid via ${a.paymentProvider}, not PayPal` }
  if (!a.providerOrderId && !a.paymentId) return { none: 'no PayPal payment on record' }
  return { providerOrderId: a.providerOrderId || null, captureId: a.paymentId || null }
}

// PayPal's record next to Flow's for one booking.
async function compare(business, a) {
  const cur = a.currency || currencyOf(business)
  const ref = paypalRef(a)
  const ours = { paid: Number(a.amountPaid || 0), refunded: Number(a.refundAmount || 0) }
  const base = { ...owner.view(business, a), currency: cur }
  if (ref.none) return { ...base, paypal: null, note: ref.none }
  try {
    const p = await paypal().getPayment(ref)
    const inSync = p.amount === round2(ours.paid) && (p.refundedTotal == null || p.refundedTotal === round2(ours.refunded))
    return {
      ...base,
      record: p,
      in_sync: inSync,
      ...(inSync ? {} : { mismatch: { flow_paid: ours.paid, paypal_gross: p.amount, flow_refunded: ours.refunded, paypal_refunded: p.refundedTotal } })
    }
  } catch (err) {
    return { ...base, paypal: null, note: `PayPal lookup failed (${err.code || err.status || 'error'})` }
  }
}

function paypalView(p, cur) {
  const m = v => (v == null ? null : formatMoney(v, cur))
  return {
    status: p.captureStatus,                      // COMPLETED | PARTIALLY_REFUNDED | REFUNDED | PENDING …
    gross: m(p.amount),
    paypal_fee: m(p.fee),
    net_to_business: m(p.net),
    refunded: p.refundedTotal == null ? 'not listed on the capture' : m(p.refundedTotal),
    order_id: p.providerOrderId,
    capture_id: p.captureId,
    paid_at: p.paidAt
  }
}

/** Is PayPal connected, and what can Flow do on the account? */
async function paypalAccount(business) {
  const env = environment()
  const base = { business: business.name, environment: env, backend_keys: keysPresent() ? 'set' : 'missing' }
  if (!business.paypalMerchantId) {
    // The demo account: Flow's own sandbox Business account (demo/templates demoPaypal).
    return {
      ...base,
      connected: !!business.paypalDemo,
      paid_into: env === 'sandbox' ? "Flow's demo PayPal sandbox account (shared by all demo sessions, fake money)" : 'nowhere: live payments need a connected PayPal account',
      ...(business.paypalEmail ? { account_login: maskEmail(business.paypalEmail) } : {}),
      refunds: 'issued by Flow from the same account',
      invoices_and_memberships: 'run on the same account (invoices need the Invoicing feature switched on in Flow\'s PayPal app)',
      ...(business.paypalDemo ? {} : { how_to_connect: 'Dashboard → Money & AI → PayPal → Use the demo sandbox account' }),
      own_account: "Connecting the business's own PayPal needs PayPal partner access, which this demo app doesn't have yet."
    }
  }
  let status = null
  if (keysPresent()) {
    try { status = await paypal().getMerchantStatus(business.paypalMerchantId) } catch (err) { status = { error: err.code || err.status || 'error' } }
  }
  return {
    ...base,
    connected: true,
    merchant_id: mask(business.paypalMerchantId),
    paid_into: "the business's own PayPal account (Flow takes no platform fee)",
    ...(status && !status.error ? {
      payments_receivable: status.paymentsReceivable,
      email_confirmed: status.emailConfirmed,
      email: maskEmail(status.email),
      can_refund_on_your_behalf: status.canRefund,
      can_invoice_on_your_behalf: status.canInvoice || false,
      ...(status.canInvoice ? {} : { invoices: 'Reconnect PayPal (Dashboard → PayPal → Connect PayPal) and allow invoices so each booking gets a PayPal invoice.' })
    } : { verified_with_paypal: status?.error ? `lookup failed (${status.error})` : 'not checked (partner id or keys not set)' })
  }
}

/** Recent PayPal payments checked live against PayPal: fees, net, refunds, and whether Flow agrees. */
async function paypalPayments(business, { days = 30 } = {}) {
  if (!keysPresent()) return NO_KEYS
  const n = Math.min(90, Math.max(1, Number(days) || 30))
  const cur = currencyOf(business)
  const paid = (await getAppointmentsForBusiness(business.businessId, dayjs().subtract(n, 'day').toISOString(), dayjs().add(60, 'day').toISOString()))
    .filter(a => a.status !== 'blocked' && Number(a.amountPaid) > 0)
    .sort((a, b) => String(b.createdAt || b.startTime).localeCompare(String(a.createdAt || a.startTime)))
  const rows = await Promise.all(paid.slice(0, MAX_LOOKUPS).map(a => compare(business, a)))

  const live = rows.filter(r => r.record)
  const sum = f => round2(live.reduce((s, r) => s + Number(r.record[f] || 0), 0))
  return {
    business: business.name,
    environment: environment(),
    window: `paid bookings from the last ${n} days and the next 60 days (newest ${MAX_LOOKUPS} checked)`,
    checked_with_paypal: live.length,
    totals_from_paypal: { gross: formatMoney(sum('amount'), cur), paypal_fees: formatMoney(sum('fee'), cur), net_to_business: formatMoney(sum('net'), cur), refunded: formatMoney(sum('refundedTotal'), cur) },
    out_of_sync: live.filter(r => !r.in_sync).map(r => r.booking_id),
    payments: rows.map(({ record, ...r }) => ({ ...r, ...(record ? { paypal: paypalView(record, r.currency) } : {}) }))
  }
}

/** One booking's full PayPal record, including every refund. */
async function paypalPayment(business, { booking_id }) {
  if (!keysPresent()) return NO_KEYS
  const a = await owner.findBooking(business, booking_id)
  if (!a) return { error: 'No booking with that id. Use get_schedule or paypal_payments to find it.' }
  const r = await compare(business, a)
  if (!r.record) return r
  const { record: p, ...rest } = r
  return {
    ...rest,
    paypal: {
      ...paypalView(p, r.currency),
      payer: p.payerName || null,
      payer_email: maskEmail(p.payerEmail),
      payee: p.payeeMerchantId ? `connected account ${mask(p.payeeMerchantId)}` : "Flow's platform sandbox account",
      refunds: (p.refunds || []).map(x => ({ refund_id: x.refundId, status: x.status, amount: formatMoney(x.amount || 0, r.currency), at: x.createdAt }))
    }
  }
}

// ── Invoices ─────────────────────────────────────

const invoices = () => require('./invoices')

// PayPal's current word on one invoice, or why it couldn't be read.
async function liveInvoice(a) {
  if (!a.invoiceId || !keysPresent()) return null
  try {
    const v = await paypal().getInvoice({ merchantId: a.payeeMerchantId || null, invoiceId: a.invoiceId })
    return { status: invoices().statusLabel(v.status), total: v.total, paid: v.paid, refunded: v.refunded, due: v.due }
  } catch (err) {
    return { error: `PayPal lookup failed (${err.code || err.status || 'error'})` }
  }
}

/** Paid bookings and their PayPal invoices, newest first (the newest 10 checked live). */
async function listInvoices(business, { days = 30, status } = {}) {
  const n = Math.min(90, Math.max(1, Number(days) || 30))
  const rows = (await getAppointmentsForBusiness(business.businessId, dayjs().subtract(n, 'day').toISOString(), dayjs().add(60, 'day').toISOString()))
    .filter(a => a.status !== 'blocked' && (Number(a.amountPaid) > 0 || a.invoiceId) && !a.seeded)
    .sort((a, b) => String(b.createdAt || b.startTime).localeCompare(String(a.createdAt || a.startTime)))
  const want = status ? String(status).toLowerCase() : null
  const views = rows.map(a => ({ a, v: invoices().view(business, a) }))
    .filter(({ v }) => !want || v.status.toLowerCase().includes(want) || (want === 'problem' && v.problem))
  const live = await Promise.all(views.slice(0, MAX_LOOKUPS).map(({ a }) => liveInvoice(a)))
  const packs = await packInvoices(business)
  return {
    business: business.name,
    window: `paid bookings from the last ${n} days and the next 60 days`,
    invoices: views.map(({ v }, i) => ({ ...v, ...(live[i] ? { in_paypal: live[i] } : {}) })),
    ...(packs.length ? { packs } : {}),
    note: views.some(({ v }) => v.status === 'not issued yet' || v.problem) ? 'Use issue_invoice to create a missing invoice once PayPal allows it.' : undefined
  }
}

async function packInvoices(business) {
  const { getCustomer } = require('../services/dynamo/customers')
  const out = []
  for (const m of (business.members || []).filter(x => x.kind === 'pack').slice(-20)) {
    const c = await getCustomer(m.customerId).catch(() => null)
    const p = (c?.memberships || []).find(x => x.membershipId === m.membershipId)
    if (p) out.push({ customer: c.name || null, pack: p.planName, paid: formatMoney(Number(p.amountPaid ?? p.price), p.currency || currencyOf(business)), invoice: p.invoiceNumber || null, status: invoices().statusLabel(p.invoiceStatus) || 'no PayPal invoice', ...(p.invoiceError ? { problem: p.invoiceError } : {}) })
  }
  return out
}

// A booking by id, or by its PayPal invoice number.
async function findInvoiced(business, { booking_id, invoice_number }) {
  if (booking_id) return owner.findBooking(business, booking_id)
  if (!invoice_number) return null
  const all = await getAppointmentsForBusiness(business.businessId, dayjs().subtract(120, 'day').toISOString(), dayjs().add(120, 'day').toISOString())
  return all.find(a => String(a.invoiceNumber || '').toLowerCase() === String(invoice_number).trim().toLowerCase()) || null
}

/** One invoice in full: what Flow recorded, what PayPal says now, and both links. */
async function getInvoice(business, args) {
  const a = await findInvoiced(business, args || {})
  if (!a) return { error: 'No booking with that id or invoice number. Use list_invoices or get_schedule.' }
  const live = await liveInvoice(a)
  return {
    ...invoices().view(business, a),
    ...(a.invoiceNumber ? { open_in_your_paypal: a.invoicerUrl || null, customer_link: a.invoiceUrl || null, account: a.payeeMerchantId ? 'your PayPal account' : "Flow's platform sandbox account" } : {}),
    ...(live ? { in_paypal: live } : {})
  }
}

/** Send the receipt PDF and invoice link to the customer's inbox again. Quote first, then confirm=true. */
async function sendInvoice(business, { booking_id, invoice_number, confirm }) {
  const a = await findInvoiced(business, { booking_id, invoice_number })
  if (!a) return { error: 'No booking with that id or invoice number.' }
  if (!(Number(a.amountPaid) > 0)) return { error: 'Nothing was paid for this booking, so there is no receipt to send.' }
  const { getCustomer } = require('../services/dynamo/customers')
  const customer = a.customerId ? await getCustomer(a.customerId).catch(() => null) : null
  if (!require('../services/demoInbox').customerInbox(customer)) return { error: 'This customer has no Flow inbox (for example a walk-in), so there is nowhere to send it.' }
  const to = `${customer.name || a.customerName || 'the customer'}'s inbox`
  const what = a.invoiceNumber ? `invoice ${a.invoiceNumber} (receipt PDF + PayPal link)` : 'the receipt PDF'
  if (!confirm) return { needs_confirmation: true, booking: invoices().view(business, a), message: `This sends ${what} to ${to}. Call again with confirm=true to send it.` }
  const r = await invoices().sendReceipt({ business, appointment: a, customer })
  return r.sent ? { sent: true, to, attachment: r.attachment } : { sent: false, error: r.error || "It didn't go out just now." }
}

/** Create a missing invoice (or finish a part-done one). Quote first, then confirm=true. */
async function issueInvoice(business, { booking_id, confirm }) {
  const a = await owner.findBooking(business, booking_id)
  if (!a) return { error: 'No booking with that id.' }
  const why = invoices().notInvoiceable(a)
  if (why) return { error: `No PayPal invoice for this booking: ${why}.` }
  if (a.invoiceStatus && !a.invoiceError && ['PAID', 'PARTIALLY_PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(a.invoiceStatus)) {
    return { already: true, ...invoices().view(business, a) }
  }
  if (!confirm) {
    return { needs_confirmation: true, booking: invoices().view(business, a), message: `This creates a PayPal invoice for ${formatMoney(Number(a.amountPaid), a.currency || currencyOf(business))} in ${a.payeeMerchantId ? 'your PayPal account' : "Flow's sandbox account"} and marks it paid. PayPal sends it to nobody; the receipt goes to the customer's inbox. Call again with confirm=true.` }
  }
  const { getCustomer } = require('../services/dynamo/customers')
  const customer = a.customerId ? await getCustomer(a.customerId).catch(() => null) : null
  const out = await invoices().issueForBooking({ business, appointment: a, customer: customer || { name: a.customerName } })
  if (out.skipped) return { issued: false, error: out.skipped }
  if (out.error) return { issued: false, error: out.error }
  return { issued: true, ...invoices().view(business, a), open_in_your_paypal: a.invoicerUrl || null }
}

module.exports = { paypalAccount, paypalPayments, paypalPayment, listInvoices, getInvoice, sendInvoice, issueInvoice, _paypalRef: paypalRef }
