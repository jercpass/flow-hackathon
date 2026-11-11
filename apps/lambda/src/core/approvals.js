// @ts-check
'use strict'

// ─── Approve in Flow ───────────────────
// Over MCP, a payment with the customer's saved PayPal that is above their AI
// allowance waits for the customer's own click in their signed-in Flow: the
// AI gets a link and can check on it, never approve it. Approving runs the same
// tool again with the approved amount, so the money path is the one the web
// chat uses (quote → confirm with that exact amount).

const crypto = require('crypto')
const { formatMoney } = require('../utils/money')
const trace = require('../services/trace')
const log = require('../utils/logger')

const TTL_MS = 15 * 60_000
const store = () => require('../services/demoStore').store()
const PK = sid => `APPROVAL#${sid}`

/** The payment needs the customer's click: only MCP, and not the re-run after they approved. */
function needsHumanApproval(ctx) {
  return ctx?.channel === 'mcp' && !!ctx.demoSid && !ctx.humanApproved
}

function approvalUrl(id) {
  const base = String(process.env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '')
  return `${base}/approve?a=${id}`
}

// The same request asked again (the AI retried) reuses the pending approval.
function requestKey(tool, args, amount) {
  const pick = { tool, b: args.business_name || '', s: args.service_name || '', t: args.start_time || '', st: args.staff_name || '', d: args.date || '', a: amount }
  return crypto.createHash('sha256').update(JSON.stringify(pick)).digest('hex').slice(0, 24)
}

/**
 * Nothing is charged: store the approval, put it in the customer's inbox, and
 * return what the AI shows. args are the tool's own arguments (confirm/amount dropped).
 */
async function request({ ctx, tool, args, amount, currency, what, account, business, customer }) {
  const sid = ctx.demoSid
  const clean = { ...args }
  delete clean.confirm; delete clean.amount
  const key = requestKey(tool, clean, amount)
  const now = Date.now()

  const pointer = await store().getKey(`APPROVALKEY#${sid}`, key)
  let rec = pointer ? await get(sid, pointer.approvalId) : null
  if (!rec || rec.status !== 'pending') {
    rec = {
      approvalId: crypto.randomBytes(9).toString('hex'), sid, tool, args: clean, amount, currency, what, account,
      businessName: business?.name || null, status: 'pending', createdAt: now, expiresAt: now + TTL_MS
    }
    await store().putKey(PK(sid), rec.approvalId, rec, rec.expiresAt + 3600_000)
    await store().putKey(`APPROVALKEY#${sid}`, key, { approvalId: rec.approvalId }, rec.expiresAt)
    const money = formatMoney(amount, currency)
    trace.event('policy', `Waiting for ${customer?.name || 'the customer'} to approve ${money} in Flow (above the AI allowance)`, { what, approval: rec.approvalId })
    await require('../services/notify').notifyCustomer({
      business, customer, channel: 'inbox', kind: 'approval',
      subject: `Approve ${money} for ${what}?`,
      text: `Your AI asked to pay ${money} for ${what}${business?.name ? ` at ${business.name}` : ''} with your saved PayPal (${account}). That's above your AI spending allowance, so it waits for you.\n\nNothing is charged until you approve. The request expires in 15 minutes.`,
      action: { label: `Review and approve ${money}`, url: approvalUrl(rec.approvalId) }
    }).catch(err => log.warn('approval_inbox_failed', { err: err.message }))
  }

  const first = (customer?.name || 'the customer').split(' ')[0]
  const money = formatMoney(rec.amount, rec.currency)
  return {
    booked: false, paid: false, needsApproval: true, approvalId: rec.approvalId, approvalUrl: approvalUrl(rec.approvalId),
    amount: rec.amount, currency: rec.currency, savedPaypal: account,
    message: `Not charged yet: ${first} must approve ${money} for ${what} in Flow (it's above their AI spending allowance). Show them this link to approve; it's also in their Flow inbox: ${approvalUrl(rec.approvalId)}. You can't approve it yourself. When they say they're done, call check_approval with approval_id "${rec.approvalId}".`
  }
}

/** The approval as stored, with "expired" once its 15 minutes are up. */
async function get(sid, id) {
  if (!sid || !/^[0-9a-f]{18}$/.test(String(id || ''))) return null
  const rec = await store().getKey(PK(sid), id)
  if (!rec) return null
  return rec.status === 'pending' && rec.expiresAt < Date.now() ? { ...rec, status: 'expired' } : rec
}

/** What the approval page shows (no internals). */
function view(rec, session) {
  if (!rec) return null
  return {
    approvalId: rec.approvalId, status: rec.status, amount: rec.amount, currency: rec.currency, money: formatMoney(rec.amount, rec.currency),
    what: rec.what, businessName: rec.businessName, account: rec.account, expiresAt: rec.expiresAt,
    customerName: session?.paypalLogin?.name || session?.customerName || null,
    message: rec.result?.message || null,
    paymentUrl: rec.result?.paymentUrl || null
  }
}

/**
 * The customer's decision from their own Flow session. Approve runs the tool
 * again with the approved amount, once: a second click gets the first outcome.
 */
async function decide(session, id, decision) {
  const rec = await get(session.sid, id)
  if (!rec) return { error: 'not_found' }
  if (rec.status !== 'pending') return { approval: view(rec, session) }

  const claim = await store().claimKey(`APPROVING#${session.sid}`, id, decision, Date.now() + 120_000)
  if (!claim.claimed) return { approval: view({ ...rec, status: 'working' }, session) }

  return trace.run(`sess:${session.sid}`, async () => {
    if (decision !== 'approve') {
      const done = { ...rec, status: 'declined', decidedAt: Date.now(), result: { message: 'Declined in Flow. Nothing was charged.' } }
      await store().putKey(PK(session.sid), id, done, rec.expiresAt + 3600_000)
      trace.event('policy', `${session.customerName || 'The customer'} declined in Flow: nothing charged`, { what: rec.what })
      return { approval: view(done, session) }
    }

    trace.event('policy', `${session.customerName || 'The customer'} approved ${formatMoney(rec.amount, rec.currency)} in Flow`, { what: rec.what })
    const { getBusiness } = require('../services/dynamo/businesses')
    const { getCustomer } = require('../services/dynamo/customers')
    const business = await getBusiness(session.businessId)
    const customer = await getCustomer(session.customerId)
    if (!business || !customer) return { error: 'session_missing' }
    const ctx = { ...(await require('./concierge').sessionContext(session, business, customer, 'mcp')), humanApproved: id }
    const { executeTool } = require('../services/tools')
    const r = await executeTool(rec.tool, { ...rec.args, confirm: true, amount: rec.amount }, ctx)
    const ok = !!(r && (r.booked || r.paid) && !r.needsApproval)
    // The saved PayPal was refused and a PayPal checkout came back instead: the
    // page talks to the person (the tool's message is written for the AI).
    const result = !ok && r?.paymentUrl
      ? { message: "Your saved PayPal didn't go through, so nothing was charged. You can pay with PayPal instead.", paymentUrl: r.paymentUrl }
      : { message: r?.message || r?.error || 'It did not go through. Nothing was charged.', booked: !!r?.booked, paid: !!r?.paid }
    const done = { ...rec, status: ok ? 'approved' : 'failed', decidedAt: Date.now(), result }
    await store().putKey(PK(session.sid), id, done, rec.expiresAt + 3600_000)
    return { approval: view(done, session) }
  })
}

/** check_approval: what the AI may tell the customer. */
async function statusFor(ctx, id) {
  const rec = await get(ctx.demoSid, id)
  if (!rec) return { error: 'No approval with that id in this session.' }
  const money = formatMoney(rec.amount, rec.currency)
  const says = {
    pending: `Still waiting for the customer to approve ${money} for ${rec.what} in Flow: ${approvalUrl(rec.approvalId)}. Nothing has been charged.`,
    expired: `The approval for ${money} expired after 15 minutes. Nothing was charged; ask again if they still want it.`,
    declined: `The customer declined ${money} for ${rec.what} in Flow. Nothing was charged.`
  }
  if (rec.status === 'failed' && rec.result?.paymentUrl) {
    says.failed = `The customer approved, but their saved PayPal didn't go through, so nothing was charged. They can pay ${money} with PayPal instead: ${rec.result.paymentUrl} (it's on their approval page too).`
  }
  return { approvalId: rec.approvalId, status: rec.status, amount: rec.amount, currency: rec.currency, message: says[rec.status] || rec.result?.message || rec.status }
}

module.exports = { needsHumanApproval, request, get, view, decide, statusFor, approvalUrl, TTL_MS }
