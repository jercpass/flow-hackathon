// @ts-check
'use strict'

// ─── Disputes answered from the booking timeline ─
// When a customer disputes a payment with PayPal, the booking itself is the
// evidence: when and how it was booked, what they said, the policy they were
// shown, what was paid and refunded, and whether the visit happened. Flow links
// each PayPal case to its booking (through the capture id), Claude drafts the
// business's response from those facts only, and nothing goes to PayPal until
// the owner says so. PayPal Disputes API v1: list/show, provide-evidence (notes +
// the timeline as a PDF), accept-claim; in the sandbox, require-evidence and
// adjudicate move a case on for testing.
//
// PayPal has no API to open a sandbox dispute (the buyer opens one in the
// Resolution Center), so the owner can also open a PRACTICE case on a paid
// booking: labelled as such everywhere, drafted the same way, never sent.
//
// Stored per business: DISPUTES#<businessId> / <disputeId> (demo store), and a
// short dispute summary on the booking (the calendar flags it).

const { store } = require('../services/demoStore')
const { getResult } = require('../services/dynamo/processedMessages')
const { updateAppointment } = require('../services/dynamo/appointments')
const { formatMoney } = require('../utils/money')
const trace = require('../services/trace')
const log = require('../utils/logger')

const pk = businessId => `DISPUTES#${businessId}`
const paypal = () => require('../services/payments/paypal')
const DAY = 86_400_000

const REASONS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'says the service wasn’t received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'says the service wasn’t as described',
  UNAUTHORISED: 'says they didn’t authorize the payment',
  CREDIT_NOT_PROCESSED: 'says a refund they were owed wasn’t given',
  DUPLICATE_TRANSACTION: 'says they were charged twice',
  INCORRECT_AMOUNT: 'says the amount was wrong',
  PAYMENT_BY_OTHER_MEANS: 'says they paid another way',
  CANCELED_RECURRING_BILLING: 'says they cancelled a recurring payment',
  OTHER: 'opened a case'
}
const reasonText = r => REASONS[r] || REASONS.OTHER
const OPEN = new Set(['OPEN', 'WAITING_FOR_SELLER_RESPONSE', 'WAITING_FOR_BUYER_RESPONSE', 'UNDER_REVIEW'])
const CHANNEL = { web: 'the web chat', speaker: 'the voice assistant', mcp: 'their own AI assistant (MCP)', telegram: 'Telegram', alexa: 'Alexa', whatsapp: 'WhatsApp', voice: 'a phone call', manual: 'the business' }

// ── Records ──────────────────────────────────────────────────────────────────

async function get(businessId, disputeId) {
  return store().getKey(pk(businessId), disputeId)
}

async function put(rec) {
  const keepUntil = Math.max(Date.now() + 30 * DAY, (Date.parse(rec.dueAt || '') || 0) + 60 * DAY)
  await store().putKey(pk(rec.businessId), rec.disputeId, rec, keepUntil)
  if (rec.appointmentId) {
    await updateAppointment(rec.businessId, rec.startTime, rec.appointmentId, {
      dispute: { id: rec.disputeId, status: rec.status, reason: rec.reason, dueAt: rec.dueAt, amount: rec.amount, outcome: rec.outcome || null, practice: !!rec.practice }
    }).catch(err => log.warn('dispute_flag_failed', { err: err.message }))
  }
  return rec
}

/** A PayPal case (disputeView) → Flow's record, linked to its booking; null if it isn't a Flow payment. */
async function upsertFromPaypal(d) {
  const ref = d.captureId ? await getResult(`cap:${d.captureId}`) : null
  if (!ref?.businessId) { log.info('dispute_not_linked', { dispute: d.disputeId }); return null }
  const prev = await get(ref.businessId, d.disputeId)
  const rec = { ...(prev || {}), ...d, businessId: ref.businessId, startTime: ref.startTime, appointmentId: ref.appointmentId, traceScope: ref.traceScope || prev?.traceScope || null, practice: false, syncedAt: Date.now() }
  await put(rec)
  return { rec, isNew: !prev }
}

/** CUSTOMER.DISPUTE.* webhook: refresh the case from PayPal, link it, tell the owner when it's new. */
async function onWebhook(eventType, resource) {
  const id = resource?.dispute_id
  if (!id) return
  const d = await paypal().getDispute(id).catch(() => null)
  const r = d ? await upsertFromPaypal(d) : null
  if (!r) return
  await trace.run(r.rec.traceScope, async () => trace.event('webhook', `PayPal webhook: ${eventType}: the customer ${reasonText(r.rec.reason)} (${formatMoney(r.rec.amount, r.rec.currency)}), case ${id}${r.rec.dueAt ? `, respond by ${r.rec.dueAt.slice(0, 10)}` : ''}`, { status: r.rec.status }))
  if (eventType === 'CUSTOMER.DISPUTE.CREATED' || r.isNew) await tellOwner(r.rec)
}

async function tellOwner(rec) {
  const { getBusiness } = require('../services/dynamo/businesses')
  const business = await getBusiness(rec.businessId)
  if (!business) return
  await require('../services/notify').notifyOwner({
    business, kind: 'dispute', subject: `${rec.practice ? 'Practice case: ' : ''}a customer disputed ${formatMoney(rec.amount, rec.currency)}`,
    text: `${rec.practice ? '(Practice case, only in Flow.) ' : ''}A customer ${reasonText(rec.reason)}, for ${formatMoney(rec.amount, rec.currency)}${rec.dueAt ? `. Respond by ${new Date(rec.dueAt).toDateString()}` : ''}. Open Disputes in Flow: the AI drafts your response from the booking's own record, and nothing goes to PayPal until you send it.`
  }).catch(() => {})
}

/** Fetch the open cases from PayPal and link the ones paid through Flow (the webhook does this too). */
async function sync() {
  const ids = await paypal().listDisputes({ startTime: new Date(Date.now() - 170 * DAY).toISOString() })
  let linked = 0
  for (const id of ids.slice(0, 25)) {
    const d = await paypal().getDispute(id).catch(() => null)
    const r = d ? await upsertFromPaypal(d) : null
    if (r) { linked++; if (r.isNew) await tellOwner(r.rec) }
  }
  return { cases: ids.length, linked }
}

/** The business's cases, open ones first, soonest deadline first. Syncs with PayPal unless told not to. */
async function list(business, { fresh = true } = {}) {
  if (fresh) await sync().catch(err => log.warn('dispute_sync_failed', { err: err.message }))
  const all = await store().listKeys(pk(business.businessId)).catch(() => [])
  return all.map(view).sort((a, b) => (Number(b.open) - Number(a.open)) || String(a.dueAt || '').localeCompare(String(b.dueAt || '')))
}

function view(rec) {
  return {
    disputeId: rec.disputeId, practice: !!rec.practice, status: rec.status, open: OPEN.has(rec.status), reason: rec.reason, reasonText: reasonText(rec.reason),
    amount: rec.amount, currency: rec.currency, money: formatMoney(rec.amount, rec.currency), dueAt: rec.dueAt || null, createdAt: rec.createdAt || null,
    outcome: rec.outcome || null, stage: rec.stage || null, buyerMessage: rec.buyerMessage || null,
    bookingId: rec.appointmentId || null, startTime: rec.startTime || null,
    draft: rec.draft || null, sent: rec.sent || null, accepted: rec.accepted || null
  }
}

// ── The booking's own record ─────────────────────────────────────────────────

async function booking(business, rec) {
  if (!rec.appointmentId) return null
  return require('./ownerOps').findBooking(business, rec.appointmentId)
}

/** What Flow knows about the booking, as plain facts (nothing inferred). */
function facts(business, a, rec) {
  const { fmtLocal, tzOf } = require('../utils/time')
  const tz = tzOf(business)
  const cur = a.currency || rec.currency
  const out = []
  const svc = a.serviceName || a.serviceId
  // The demo's made-up history is written after its visits: a "booked" date after the visit says nothing.
  if (a.createdAt && a.createdAt < a.startTime) out.push(`Booked on ${fmtLocal(a.createdAt, tz)} by ${a.customerName || 'the customer'} through ${CHANNEL[a.createdVia] || a.createdVia || 'Flow'}.`)
  else out.push(`Booked by ${a.customerName || 'the customer'} through ${CHANNEL[a.createdVia] || a.createdVia || 'Flow'}.`)
  out.push(`Service: ${svc} at ${business.name}${business.location?.address ? `, ${business.location.address}` : ''}, on ${fmtLocal(a.startTime, tz)}.`)
  if (a.amountPaid) out.push(`Paid ${formatMoney(a.amountPaid, cur)} with PayPal${a.paidUnder === 'allowance' ? ' by the customer’s AI assistant, under the spending mandate the customer signed in Flow' : ''}${a.paymentId ? ` (capture ${a.paymentId})` : ''}.`)
  if (a.paymentMandateId) out.push(`The payment is recorded as mandate payment ${a.paymentMandateId}${a.mandateId ? ` under the customer’s signed mandate ${a.mandateId}` : ''}.`)
  const policy = business.config?.policies?.cancellation
  if (policy) out.push(`Cancellation policy shown before paying: "${policy}"`)
  if (a.customerNotes) out.push(`The customer’s own note on the booking: "${String(a.customerNotes).slice(0, 300)}"`)
  if (a.movedBy || a.rescheduledAt) out.push('The booking was moved once after it was made.')
  const past = Date.parse(a.endTime || a.startTime) < Date.now()
  const status = a.status === 'completed' ? 'The visit was marked completed by the business.'
    : a.status === 'no_show' ? 'The business marked the customer as a no-show.'
      : a.status === 'cancelled' ? 'The booking was cancelled.'
        : past ? 'The appointment time has passed and the booking was not cancelled.' : 'The appointment is still upcoming; the customer can attend or cancel under the policy.'
  out.push(status)
  if (Number(a.refundAmount) > 0) out.push(`Refunded ${formatMoney(a.refundAmount, cur)} to the customer${a.refundId ? ` (refund ${a.refundId})` : ''}.`)
  else out.push('No refund has been issued.')
  if (a.refundRequest) out.push(`The customer asked Flow for a refund: "${String(a.refundRequest.reason || '').slice(0, 200)}" (${a.refundRequest.status}).`)
  out.push(`Confirmation and receipt were sent to the customer’s Flow inbox when the booking was paid.`)
  return out
}

// PayPal's evidence types: the closest one for a service booking.
function evidenceType(rec, a) {
  if (Number(a?.refundAmount) > 0) return 'PROOF_OF_REFUND'
  if (rec.reason === 'CREDIT_NOT_PROCESSED' || rec.reason === 'CANCELED_RECURRING_BILLING') return 'RETURN_POLICY'
  // A no-show wasn't served: the policy and the record speak for it, not proof of service.
  if (rec.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' && a?.status !== 'no_show' && a?.status !== 'cancelled' && (a?.status === 'completed' || Date.parse(a?.endTime || '') < Date.now())) return 'PROOF_OF_FULFILLMENT'
  return 'OTHER'
}

/** Claude drafts the response from the facts only; nothing is sent. */
async function draft(business, disputeId) {
  const rec = await get(business.businessId, disputeId)
  if (!rec) return { error: 'No dispute with that id.' }
  const a = await booking(business, rec)
  if (!a) return { error: 'The booking for this dispute isn’t in Flow any more, so there’s nothing to draft from.' }
  const known = facts(business, a, rec)
  const system = [
    `You write a small business's response to a PayPal dispute. The business is ${business.name}; the customer ${reasonText(rec.reason)} for ${formatMoney(rec.amount, rec.currency)}.`,
    'Use ONLY the facts listed. Never add details, dates, conversations or promises that are not in them. If a fact that would help is missing, do not invent it.',
    'Refer to the customer by name or as "the customer", never as he or she.',
    'Write to PayPal in plain, polite English, 90 to 180 words, no headings or bullet points: what was booked and paid, what the record shows happened, the policy that applies, and what the business asks PayPal to decide. If the record supports the customer (for example a refund is due under the policy), say so honestly and offer that refund instead.'
  ].join('\n')
  const text = `Dispute reason: ${rec.reason}\n${rec.buyerMessage ? `The customer wrote to PayPal: "${String(rec.buyerMessage).slice(0, 400)}"\n` : ''}Facts from Flow's record:\n${known.map(f => `- ${f}`).join('\n')}`
  let note, by = 'template'
  try {
    // Room for Haiku's thinking too: 700 tokens once came back with no text at all.
    const r = await require('../services/ai').generate({ system, parts: [{ text }], maxTokens: 3000, area: 'disputes' })
    note = String(r.text || '').trim()
    if (note) by = require('../utils/modelName').modelName(r.model)
  } catch (err) {
    log.warn('dispute_draft_ai_failed', { err: err.message })
  }
  if (!note) note = `${business.name} responds to this case for ${formatMoney(rec.amount, rec.currency)}. ${known.join(' ')} We ask PayPal to review the attached booking record.`
  const d = { note, facts: known, evidenceType: evidenceType(rec, a), by, at: Date.now() }
  await put({ ...rec, draft: d })
  trace.event('ai', `${by === 'template' ? 'Drafted' : `${by} drafted`} a response to dispute ${disputeId} from ${known.length} facts in the booking's record (not sent)`, { evidence: d.evidenceType })
  return { dispute: view({ ...rec, draft: d }) }
}

// The booking timeline as a one-page PDF, attached as the evidence file.
async function timelinePdf(business, rec, lines) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ascii = s => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, '')
  let y = 740
  const write = (s, f = font, size = 10.5) => {
    const words = ascii(s).split(' ')
    let line = ''
    for (const w of words) {
      const next = line ? `${line} ${w}` : w
      if (f.widthOfTextAtSize(next, size) > 512) { page.drawText(line, { x: 50, y, size, font: f, color: rgb(0.1, 0.1, 0.1) }); y -= size + 5; line = w } else line = next
    }
    if (line) { page.drawText(line, { x: 50, y, size, font: f, color: rgb(0.1, 0.1, 0.1) }); y -= size + 5 }
  }
  write(`Booking record: ${business.name}`, bold, 15); y -= 4
  write(`PayPal case ${rec.disputeId} (${rec.reason}), ${formatMoney(rec.amount, rec.currency)}`, font, 10); y -= 8
  for (const l of lines) { write(`- ${l}`); y -= 3 }
  y -= 6
  write('Generated by Flow from the booking as stored at the time of each event.', font, 8.5)
  return Buffer.from(await doc.save())
}

/** Send the response to PayPal (owner's OK first). A practice case stays in Flow. */
async function send(business, disputeId, { note, confirm } = {}) {
  const rec = await get(business.businessId, disputeId)
  if (!rec) return { error: 'No dispute with that id.' }
  if (!OPEN.has(rec.status)) return { error: `This case is ${String(rec.status).toLowerCase().replace(/_/g, ' ')}, so there's nothing to respond to.` }
  const text = String(note || rec.draft?.note || '').trim()
  if (text.length < 20) return { error: 'Write the response first (or ask for a draft).' }
  if (!confirm) {
    return { needs_confirmation: true, message: `${rec.practice ? 'This is a practice case: it is recorded in Flow, nothing goes to PayPal.' : `This sends your response and the booking record (PDF) to PayPal for case ${disputeId}.`} Call again with confirm=true to send it.`, response: text }
  }
  const a = await booking(business, rec)
  const lines = rec.draft?.facts || (a ? facts(business, a, rec) : [])
  const type = rec.draft?.evidenceType || evidenceType(rec, a)
  if (!rec.practice) {
    const pdf = await timelinePdf(business, rec, lines)
    await paypal().provideDisputeEvidence({ disputeId, evidenceType: type, notes: text, pdf })
  }
  const sent = { at: Date.now(), evidenceType: type, note: text, toPaypal: !rec.practice }
  const status = rec.practice ? 'UNDER_REVIEW' : rec.status
  await put({ ...rec, status, sent })
  trace.event('paypal', rec.practice ? `Practice dispute ${disputeId}: response recorded in Flow (nothing sent to PayPal)` : `Response to dispute ${disputeId} sent to PayPal with the booking record attached`, { evidence: type })
  if (!rec.practice) await refresh(business, disputeId)
  return { sent: true, practice: !!rec.practice, message: rec.practice ? 'Recorded (practice case: nothing went to PayPal).' : 'Sent to PayPal with the booking record attached. PayPal decides the case; you’ll see the outcome here.' }
}

/** Accept the claim (PayPal refunds the customer). Owner's OK first. */
async function accept(business, disputeId, { note, confirm } = {}) {
  const rec = await get(business.businessId, disputeId)
  if (!rec) return { error: 'No dispute with that id.' }
  if (!OPEN.has(rec.status)) return { error: 'This case is already closed.' }
  if (!confirm) return { needs_confirmation: true, message: `Accepting means the customer gets ${formatMoney(rec.amount, rec.currency)} back${rec.practice ? ' (practice case: only recorded in Flow)' : ' through PayPal'}. Call again with confirm=true to accept.` }
  if (!rec.practice) await paypal().acceptDisputeClaim({ disputeId, note })
  await put({ ...rec, accepted: { at: Date.now(), note: note || null }, ...(rec.practice ? { status: 'RESOLVED', outcome: 'RESOLVED_BUYER_FAVOUR' } : {}) })
  trace.event('paypal', `${rec.practice ? 'Practice dispute' : 'Dispute'} ${disputeId}: the business accepted the claim`, {})
  if (!rec.practice) await refresh(business, disputeId)
  return { accepted: true, message: rec.practice ? 'Accepted (practice case: recorded in Flow only).' : `Accepted. PayPal returns ${formatMoney(rec.amount, rec.currency)} to the customer.` }
}

async function refresh(business, disputeId) {
  const d = await paypal().getDispute(disputeId).catch(() => null)
  if (d) await upsertFromPaypal(d)
}

/** Sandbox only: ask for evidence, or decide the case, to show the whole path. */
async function sandbox(business, disputeId, action) {
  const rec = await get(business.businessId, disputeId)
  if (!rec) return { error: 'No dispute with that id.' }
  if (!['require_evidence', 'seller_wins', 'buyer_wins'].includes(action)) return { error: 'Unknown action.' }
  if (rec.practice) {
    const outcome = action === 'seller_wins' ? 'RESOLVED_SELLER_FAVOUR' : action === 'buyer_wins' ? 'RESOLVED_BUYER_FAVOUR' : null
    await put({ ...rec, ...(outcome ? { status: 'RESOLVED', outcome } : { status: 'WAITING_FOR_SELLER_RESPONSE' }) })
  } else {
    await paypal().sandboxDispute({ disputeId, action })
    await refresh(business, disputeId)
  }
  return { dispute: view(await get(business.businessId, disputeId)) }
}

/** A practice case on a paid booking (PayPal can't open a sandbox dispute by API). */
async function practice(business, bookingId) {
  const a = await require('./ownerOps').findBooking(business, bookingId)
  if (!a) return { error: 'No booking with that id.' }
  if (!(Number(a.amountPaid) > 0)) return { error: 'Pick a paid booking: a dispute is about a payment.' }
  const rec = {
    disputeId: `PRACTICE-${a.appointmentId.slice(0, 8).toUpperCase()}`, practice: true, status: 'WAITING_FOR_SELLER_RESPONSE',
    reason: Date.parse(a.endTime) < Date.now() ? 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' : 'CREDIT_NOT_PROCESSED',
    amount: Number(a.amountPaid), currency: a.currency || 'USD', createdAt: new Date().toISOString(), dueAt: new Date(Date.now() + 10 * DAY).toISOString(),
    businessId: business.businessId, startTime: a.startTime, appointmentId: a.appointmentId, traceScope: a.traceScope || null,
    buyerMessage: Date.parse(a.endTime) < Date.now() ? 'I never got this appointment.' : 'I cancelled and want my money back.'
  }
  await put(rec)
  trace.event('policy', `Practice dispute opened on a paid booking (only in Flow; PayPal's sandbox has no API to open one)`, { case: rec.disputeId })
  await tellOwner(rec)
  return { dispute: view(rec) }
}

module.exports = { onWebhook, sync, list, view, draft, send, accept, sandbox, practice, facts, evidenceType, timelinePdf, reasonText }
