// @ts-check
'use strict'

// ─── Seats held while a customer pays ──────
// The owner calendar shows a seat held for a PayPal payment as a striped "held:
// waiting for PayPal" bar, which becomes the booking once the capture lands. The
// seat lock itself lives in Redis (services/redis); this is only the list the
// calendar reads: HOLDS#<businessId> / <orderId>, gone with the pending payment.

const { store } = require('../services/demoStore')
const { getPendingPayment } = require('../services/dynamo/pendingPayments')
const log = require('../utils/logger')

const HOLD_MS = 10 * 60_000
const REVIEW_MS = 3 * 24 * 3600_000    // PayPal reviewing a capture: days, not minutes
const pk = businessId => `HOLDS#${businessId}`

/** A seat is held for this order (best effort: the calendar is only a view). */
async function add(business, { orderId, startIso, minutes, unitId, serviceName, customerName, amount, currency, channel }) {
  if (!orderId || !startIso) return
  const endIso = new Date(new Date(startIso).getTime() + (minutes || 60) * 60_000).toISOString()
  await store().putKey(pk(business.businessId), orderId, {
    orderId, startIso, endIso, unitId: unitId || null, serviceName, customerName: customerName || null,
    amount, currency, channel: channel || null, status: 'held', heldAt: Date.now(), until: Date.now() + HOLD_MS
  }, Date.now() + HOLD_MS).catch(err => log.warn('hold_list_failed', { err: err.message }))
}

/** PAYMENT.CAPTURE.PENDING: PayPal is reviewing the payment; keep showing it. */
async function markReviewing(businessId, orderId) {
  const h = await store().getKey(pk(businessId), orderId)
  if (!h) return false
  await store().putKey(pk(businessId), orderId, { ...h, status: 'reviewing', until: Date.now() + REVIEW_MS }, Date.now() + REVIEW_MS)
  return true
}

async function remove(businessId, orderId) {
  if (businessId && orderId) await store().deleteKey(pk(businessId), orderId).catch(() => {})
}

/** Live holds between two instants; a hold whose payment is settled (paid or given up) is dropped. */
async function list(businessId, fromIso, toIso) {
  const all = await store().listKeys(pk(businessId)).catch(() => [])
  const out = []
  for (const h of all) {
    if (h.endIso < fromIso || h.startIso > toIso) continue
    if (!(await getPendingPayment(h.orderId).catch(() => null))) { await remove(businessId, h.orderId); continue }
    out.push(h)
  }
  return out
}

module.exports = { add, markReviewing, remove, list, HOLD_MS }
