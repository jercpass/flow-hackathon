// @ts-check
'use strict'

// ─── PayPal HTTP endpoints ────────────────────────────────────────────────────
//   GET  /pay/paypal/return?token=ORDER_ID   buyer approved → seat check → capture → confirm
//   GET  /pay/paypal/cancel?token=ORDER_ID   buyer backed out → free the seat
//   GET  /pay/paypal/status?order=ORDER_ID   JSON outcome (web chat polls this)
//   POST /webhook/paypal                     signed PayPal events (backup + refunds)
//   GET  /pay/paypal/membership/return?bid&cid&mid  joined a membership / bought a pack
//   GET  /pay/paypal/membership/cancel?bid&cid&mid  backed out on PayPal
//   GET  /pay/paypal/vault/return?approval_token_id  customer saved another PayPal ("Change account")
//   GET  /pay/paypal/vault/cancel                     backed out: the saved PayPal stays as it was
//   GET  /pay/paypal/login/return?code&state         the demo customer logged in with PayPal
//
// The return URL and the webhook both funnel into core/paymentConfirm.finalizeOrder,
// which is exactly-once — whichever arrives first does the work, the other no-ops.

const { finalizeOrder, cancelCheckout, resultKey } = require('../core/paymentConfirm')
const { getPendingPayment, consumePendingPayment } = require('../services/dynamo/pendingPayments')
const processedMessages = require('../services/dynamo/processedMessages')
const { updateAppointment } = require('../services/dynamo/appointments')
const paypal = require('../services/payments/paypal')
const { releaseHeldSeat } = require('../core/paymentConfirm')
const { formatMoney, round2 } = require('../utils/money')
const log = require('../utils/logger')
const trace = require('../services/trace')

const ORDER_ID = /^[A-Z0-9]{8,32}$/

// Where web-chat buyers land after PayPal: WEB_CHAT_URL, else the dashboard's customer page.
function webChatUrl() {
  if (process.env.WEB_CHAT_URL) return process.env.WEB_CHAT_URL
  return process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL.replace(/\/$/, '')}/demo/client` : null
}

// ── Browser return / cancel ──────────────────────────────────────────────────

exports.returnPage = async (event) => {
  const orderId = event.queryStringParameters?.token
  if (!orderId || !ORDER_ID.test(orderId)) return page(400, view({ status: 'not_found' }))
  let result
  try {
    result = await finalizeOrder(orderId, { source: 'return' })
  } catch (err) {
    log.error('paypal_return_failed', err, { orderId })
    result = { status: 'error' }
  }
  return redirectOrPage(orderId, result)
}

exports.cancelPage = async (event) => {
  const orderId = event.queryStringParameters?.token
  if (!orderId || !ORDER_ID.test(orderId)) return page(400, view({ status: 'not_found' }))
  const result = await cancelCheckout(orderId).catch(() => ({ status: 'cancelled' }))
  return redirectOrPage(orderId, result)
}

// Memberships and packs (core/memberships). The ids in the URL only say which
// membership to look at; activate() checks with PayPal using the ids we stored.
const SAFE = { bid: /^[A-Za-z0-9-]{3,80}$/, cid: /^[A-Za-z0-9-]{3,80}$/, mid: /^[a-f0-9]{6,32}$/ }
function membershipParams(event) {
  const q = event.queryStringParameters || {}
  const p = { businessId: q.bid, customerId: q.cid, membershipId: q.mid }
  return SAFE.bid.test(p.businessId || '') && SAFE.cid.test(p.customerId || '') && SAFE.mid.test(p.membershipId || '') ? p : null
}

exports.membershipReturn = async (event) => {
  const p = membershipParams(event)
  if (!p) return page(400, view({ status: 'not_found' }))
  let result
  try {
    result = await require('../core/memberships').activate({ ...p, source: 'return' })
  } catch (err) {
    log.error('membership_return_failed', err, { membershipId: p.membershipId })
    result = { status: 'error' }
  }
  return membershipRedirect(result, event)
}

exports.membershipCancel = async (event) => {
  const p = membershipParams(event)
  if (!p) return page(400, view({ status: 'not_found' }))
  const result = await require('../core/memberships').abandon(p).catch(() => ({ status: 'cancelled' }))
  return membershipRedirect(result, event)
}

function membershipRedirect(result, event) {
  const webUrl = webChatUrl()
  const channel = result.channel || event.queryStringParameters?.ch
  if (webUrl && channel === 'web') {
    return { statusCode: 302, headers: { Location: `${webUrl}?membership=${encodeURIComponent(result.status)}&plan=${encodeURIComponent(result.plan || '')}&kind=${encodeURIComponent(result.kind || '')}` }, body: '' }
  }
  return page(200, view({ ...result, status: `member_${result.status}` }))
}

// Saved PayPal, "Change account" (core/savedPaypal). The setup token in the URL is
// looked up in our own store, which says whose account it is.
exports.vaultReturn = async (event) => {
  const q = event.queryStringParameters || {}
  const setupTokenId = q.approval_token_id || q.token
  if (!setupTokenId || !ORDER_ID.test(setupTokenId)) return page(400, view({ status: 'vault_not_found' }))
  const savedPaypal = require('../core/savedPaypal')
  let result
  try {
    result = await savedPaypal.finishChange(setupTokenId)
  } catch (err) {
    log.error('paypal_vault_return_failed', err, {})
    result = { status: 'error' }
  }
  return vaultRedirect(result, result.returnTo || await savedPaypal.returnToFor(setupTokenId).catch(() => null))
}

exports.vaultCancel = async (event) => {
  const id = event.queryStringParameters?.approval_token_id || event.queryStringParameters?.token
  const returnTo = id && ORDER_ID.test(id) ? await require('../core/savedPaypal').returnToFor(id).catch(() => null) : null
  return vaultRedirect({ status: 'cancelled' }, returnTo)
}

function vaultRedirect(result, returnTo) {
  const webUrl = webChatUrl()
  if (webUrl && returnTo === 'profile') {
    return { statusCode: 302, headers: { Location: `${webUrl}?paypal=${encodeURIComponent(result.status)}` }, body: '' }
  }
  // The save step right after Log in with PayPal: back to the chat, logged in either way.
  if (webUrl && returnTo === 'login') {
    return { statusCode: 302, headers: { Location: `${webUrl}?login=ok&saved=${encodeURIComponent(result.status)}` }, body: '' }
  }
  return page(200, view({ ...result, status: `vault_${result.status}` }))
}

// Log in with PayPal (core/paypalLogin). The state says which session; a bad or
// used one changes nothing. Back to the customer side either way.
exports.loginReturn = async (event) => {
  const q = event.queryStringParameters || {}
  let status = 'cancelled'
  if (q.code) {
    try {
      const r = await require('../core/paypalLogin').finish({ code: q.code, state: q.state })
      status = r.status
      // Logged in: straight on to PayPal's "save PayPal" page (one click, nothing charged).
      if (r.status === 'ok' && r.next) return { statusCode: 302, headers: { Location: r.next }, body: '' }
    } catch (err) {
      log.error('paypal_login_return_failed', err, {})
      status = 'error'
    }
  }
  const webUrl = webChatUrl()
  if (webUrl) return { statusCode: 302, headers: { Location: `${webUrl}?login=${encodeURIComponent(status)}` }, body: '' }
  return page(200, view({ status: status === 'ok' ? 'login_ok' : 'login_failed' }))
}

exports.status = async (event) => {
  const orderId = event.queryStringParameters?.order
  if (!orderId || !ORDER_ID.test(orderId)) return json(400, { status: 'bad_request' })
  const done = await processedMessages.getResult(resultKey(orderId))
  if (done) return json(200, done)
  const pending = await getPendingPayment(orderId)
  return json(200, pending ? { status: 'awaiting_payment', serviceName: pending.serviceName } : { status: 'not_found' })
}

// Web-chat customers go back to the chat with the outcome; everyone else (a
// link opened from the Flow inbox or WhatsApp) gets the hosted result page.
function redirectOrPage(orderId, result) {
  const webUrl = webChatUrl()
  if (webUrl && result.channel === 'web') {
    return { statusCode: 302, headers: { Location: `${webUrl}?order=${encodeURIComponent(orderId)}&status=${encodeURIComponent(result.status)}` }, body: '' }
  }
  return page(200, view(result))
}

// ── Webhook ──────────────────────────────────────────────────────────────────

exports.webhook = async (event) => {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '')
  if (!(await paypal.verifyWebhook(event.headers, rawBody))) {
    log.warn('paypal_webhook_signature_invalid', {})
    return { statusCode: 401, body: 'invalid signature' }
  }

  const body = JSON.parse(rawBody)
  const eventKey = `pp:${body.id}`
  if (await processedMessages.hasProcessed(eventKey)) return { statusCode: 200, body: 'ok' }

  try {
    await handleEvent(body)
    await processedMessages.markProcessed(eventKey)
  } catch (err) {
    // Not marked processed → PayPal retries (up to 25× over 3 days).
    log.error('paypal_webhook_processing_failed', err, { eventType: body.event_type, eventId: body.id })
    return { statusCode: 500, body: 'retry' }
  }
  return { statusCode: 200, body: 'ok' }
}

// A payment that won't complete: free the seat and tell whoever is waiting on it.
async function failPending(orderId, status, eventType) {
  const pending = await consumePendingPayment(orderId)
  if (!pending) return
  await releaseHeldSeat(pending)
  await require('../core/holds').remove(pending.businessId, orderId)
  await processedMessages.saveResult(resultKey(orderId), { status: 'failed', captureStatus: status, serviceName: pending.serviceName })
  await trace.run(pending.traceScope, async () => trace.event('webhook', `PayPal webhook: ${eventType}: the payment didn't complete, so the seat was released (nothing booked)`, { order: trace.short(orderId) }))
}

async function handleEvent(body) {
  const r = body.resource || {}
  const orderIdFromCapture = r.supplementary_data?.related_ids?.order_id

  switch (body.event_type) {
    case 'CHECKOUT.ORDER.APPROVED':
      // Buyer approved but may have closed the tab before the return redirect.
      return finalizeOrder(r.id, { source: 'webhook' })

    case 'PAYMENT.CAPTURE.COMPLETED':
      // Normally already handled by the return/approved path; this also finishes
      // captures that came back PENDING (eCheck / review) once they clear.
      if (orderIdFromCapture && await getPendingPayment(orderIdFromCapture)) {
        return finalizeOrder(orderIdFromCapture, { source: 'capture_webhook' })
      }
      return

    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED': {
      if (!orderIdFromCapture) return
      return failPending(orderIdFromCapture, r.status, body.event_type)
    }

    // The buyer approved, but PayPal couldn't complete the payment after all.
    case 'CHECKOUT.PAYMENT-APPROVAL.REVERSED': {
      const orderId = r.order_id || r.id
      if (!orderId) return
      return failPending(orderId, 'APPROVAL_REVERSED', body.event_type)
    }

    // PayPal is reviewing the capture (eCheck, risk review): the booking waits
    // and the owner calendar says so. COMPLETED (above) or DENIED finishes it.
    case 'PAYMENT.CAPTURE.PENDING': {
      const pending = orderIdFromCapture && await getPendingPayment(orderIdFromCapture)
      if (!pending) return
      await require('../core/holds').markReviewing(pending.businessId, orderIdFromCapture)
      await trace.run(pending.traceScope, async () => trace.event('webhook', `PayPal webhook: ${body.event_type}: PayPal is reviewing the payment (${r.status_details?.reason || 'pending'}); the booking confirms when it clears`, { order: trace.short(orderIdFromCapture) }))
      return
    }

    // The customer removed Flow from their PayPal account: forget the saved PayPal
    // (and the AI mandate that pays with it). Flow's own deletes land here too, as no-ops.
    case 'VAULT.PAYMENT-TOKEN.DELETED':
    case 'VAULT.PAYMENT-TOKEN.DELETION-INITIATED':
      return require('../core/savedPaypal').onTokenDeleted(r.id, body.event_type)

    case 'CUSTOMER.DISPUTE.CREATED':
    case 'CUSTOMER.DISPUTE.UPDATED':
    case 'CUSTOMER.DISPUTE.RESOLVED':
      return require('../core/disputes').onWebhook(body.event_type, r)

    // Memberships: activation (if the return page was missed), renewals,
    // failed payments, cancellations made on PayPal's side.
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
    case 'PAYMENT.SALE.COMPLETED':
      return require('../core/memberships').onSubscriptionEvent(body.event_type, r)

    case 'PAYMENT.CAPTURE.REFUNDED': {
      // Resource is the refund; its "up" link points at the capture. Covers refunds
      // issued outside Flow too (PayPal dashboard, PayPal MCP).
      const captureId = (r.links || []).find(l => l.rel === 'up')?.href?.split('/').pop()
      const ref = captureId && await processedMessages.getResult(`cap:${captureId}`)
      if (!ref) return
      const total = round2(r.seller_payable_breakdown?.total_refunded_amount?.value ?? r.amount?.value ?? 0)
      await require('../services/trace').run(ref.traceScope, async () => require('../services/trace').event('webhook', `PayPal webhook: ${body.event_type} — signature verified`, { capture: require('../services/trace').short(captureId), totalRefunded: total, status: r.status }))
      await updateAppointment(ref.businessId, ref.startTime, ref.appointmentId, {
        refundStatus: r.status || 'COMPLETED',
        refundAmount: total,
        refundId:     r.id,
        paymentStatus: total >= round2(ref.amountPaid || 0) ? 'refunded' : 'partially_refunded'
      })
      log.info('paypal_refund_synced', { captureId, appointmentId: ref.appointmentId, total })
      return
    }

    // Not a refund the business gave: PayPal took the money back (a chargeback or
    // a dispute decided for the buyer). Recorded apart, and the owner is told.
    case 'PAYMENT.CAPTURE.REVERSED': {
      const captureId = (r.links || []).find(l => l.rel === 'up')?.href?.split('/').pop() || (r.status === 'REVERSED' ? r.id : null)
      const ref = captureId && await processedMessages.getResult(`cap:${captureId}`)
      if (!ref) return
      const amount = round2(r.amount?.value ?? ref.amountPaid ?? 0)
      await trace.run(ref.traceScope, async () => trace.event('webhook', `PayPal webhook: ${body.event_type}: PayPal took back ${amount} (a chargeback or a dispute outcome, not a refund)`, { capture: trace.short(captureId), status: r.status }))
      await updateAppointment(ref.businessId, ref.startTime, ref.appointmentId, { paymentStatus: 'reversed', reversedAmount: amount, reversedAt: new Date().toISOString() })
      const { getBusiness } = require('../services/dynamo/businesses')
      const business = await getBusiness(ref.businessId)
      if (business) {
        await require('../services/notify').notifyOwner({
          business, kind: 'payment_reversed', subject: `PayPal took back a payment (${amount})`,
          text: `PayPal took back ${amount} for a booking (a chargeback, or a dispute decided for the buyer). It isn't a refund you gave; the booking shows as "reversed" in your calendar.`
        }).catch(() => {})
      }
      log.info('paypal_reversal_synced', { captureId, appointmentId: ref.appointmentId, amount })
      return
    }

    default:
      log.info('paypal_webhook_ignored', { eventType: body.event_type })
  }
}

// ── Tiny hosted result page ──────────────────────────────────────────────────

function view(result) {
  const s = result?.status
  const money = result?.amount != null && result?.currency ? formatMoney(result.amount, result.currency) : ''
  const svc = esc(result?.serviceName || 'your booking')
  const biz = esc(result?.businessName || 'Flow')
  switch (s) {
    case 'confirmed':
      return { tone: 'ok', title: "You're booked", biz,
        body: `<strong>${svc}</strong><br>${esc(result.when || '')}${money ? `<br>Paid ${esc(money)} with PayPal` : ''}`,
        foot: 'A confirmation is on its way. You can close this tab.' }
    case 'paid':
      return { tone: 'ok', title: 'Payment received', biz, body: `${svc} is now fully paid${money ? ` (${esc(money)})` : ''}.`, foot: 'You can close this tab.' }
    case 'slot_taken':
      return { tone: 'warn', title: 'That slot was just taken', biz, body: `Someone booked ${svc} while you were paying. <strong>You were not charged.</strong>`, foot: 'Go back to the chat and pick another time.' }
    case 'refunded':
      return { tone: 'warn', title: "We couldn't complete the booking", biz, body: `Your ${esc(money)} payment has been refunded in full.`, foot: 'Go back to the chat to try another time.' }
    case 'pending':
      return { tone: 'info', title: 'Payment processing', biz, body: esc(result.message || 'PayPal is still processing your payment.'), foot: "We'll confirm as soon as it clears." }
    case 'declined':
      return { tone: 'warn', title: 'Payment declined', biz, body: esc(result.message), foot: 'Open the payment link again to retry.' }
    case 'cancelled':
      return { tone: 'info', title: 'Payment cancelled', biz, body: `No charge was made for ${svc}.`, foot: 'You can reopen the payment link any time in the next few minutes.' }
    case 'awaiting_approval':
      return { tone: 'info', title: 'Waiting for approval', biz, body: 'PayPal has not approved this payment yet.', foot: 'Finish the payment in the PayPal window.' }
    case 'failed':
      return { tone: 'warn', title: 'Payment failed', biz, body: 'PayPal could not complete this payment. You were not charged.', foot: 'Go back to the chat to try again.' }
    case 'member_active':
      return { tone: 'ok', title: result.kind === 'pack' ? 'Pack bought' : "You're a member", biz, body: `<strong>${esc(result.plan || 'Your plan')}</strong> is active${result.kind === 'pack' ? '' : '. Billed monthly; cancel any time by asking'}.`, foot: 'Just ask to book: covered bookings cost nothing.' }
    case 'member_pending':
      return { tone: 'info', title: 'Almost there', biz, body: 'PayPal is still confirming. It usually takes a few seconds.', foot: "We'll activate it as soon as PayPal confirms." }
    case 'member_failed':
    case 'member_error':
      return { tone: 'warn', title: "It didn't go through", biz, body: 'PayPal did not confirm the payment. You were not charged.', foot: 'Go back to the chat to try again.' }
    case 'member_cancelled':
      return { tone: 'info', title: 'Not joined', biz, body: `No charge was made${result.plan ? ` for ${esc(result.plan)}` : ''}.`, foot: 'You can join any time by asking.' }
    case 'vault_saved':
      return { tone: 'ok', title: 'PayPal saved', biz, body: `Bookings now pay with <strong>${esc(result.account || 'this PayPal account')}</strong> after you agree to the amount.`, foot: 'You can close this tab.' }
    case 'login_ok':
      return { tone: 'ok', title: 'Logged in with PayPal', biz, body: 'You can go back to Flow.', foot: 'You can close this tab.' }
    case 'login_failed':
      return { tone: 'warn', title: "Didn't log in", biz, body: 'PayPal did not confirm the login. Nothing changed.', foot: 'Go back to Flow to try again.' }
    case 'vault_same':
      return { tone: 'ok', title: 'Already saved', biz, body: `<strong>${esc(result.account || 'This PayPal account')}</strong> was already your saved PayPal, so nothing changed.`, foot: 'You can close this tab.' }
    case 'vault_cancelled':
      return { tone: 'info', title: 'Nothing changed', biz, body: 'Your saved PayPal is as it was.', foot: 'You can close this tab.' }
    case 'vault_not_found':
    case 'vault_error':
      return { tone: 'warn', title: "PayPal wasn't saved", biz, body: 'This link has expired or PayPal did not confirm it. Nothing changed.', foot: 'Ask for a new link to try again.' }
    case 'error':
      return { tone: 'warn', title: 'Something went wrong', biz, body: "We couldn't confirm your payment just now. If you were charged, it will be confirmed or refunded automatically.", foot: 'You can close this tab.' }
    default:
      return { tone: 'info', title: 'Link expired', biz, body: 'This payment link is no longer active.', foot: 'Go back to the chat to start again.' }
  }
}

function page(statusCode, v) {
  const color = { ok: '#0a7d4f', warn: '#b4540a', info: '#0b57d0' }[v.tone] || '#0b57d0'
  const icon = { ok: '✓', warn: '!', info: 'i' }[v.tone] || 'i'
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v.title)} · ${v.biz}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1b1f24}
  .card{background:#fff;max-width:420px;width:calc(100% - 32px);padding:36px 28px;border-radius:16px;box-shadow:0 8px 30px rgba(20,30,60,.08);text-align:center}
  .icon{width:56px;height:56px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;font-size:28px;font-weight:700;color:#fff;background:${color}}
  h1{font-size:22px;margin:0 0 4px} .biz{color:#6b7280;font-size:14px;margin-bottom:18px} p{margin:0 0 18px} .foot{color:#6b7280;font-size:14px;margin:0}
</style></head><body><main class="card"><div class="icon">${icon}</div><h1>${esc(v.title)}</h1><div class="biz">${v.biz}</div><p>${v.body}</p><p class="foot">${esc(v.foot)}</p></main></body></html>`
  return { statusCode, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: html }
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

exports._view = view
