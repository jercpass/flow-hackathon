'use strict'
/**
 * Central Redis client for Flow Lambda.
 *
 * Ported from voicebook/apps/lambda/src/services/redis.js, trimmed to the v1
 * WhatsApp scope (no OAuth/discovery/voice-session keys — those return in v1.5/v2
 * when external provider sync and other channels are added).
 *
 * Connection is lazy and reused across warm invocations. All operations fail open:
 * Redis is a performance layer, not a correctness requirement. DynamoDB remains
 * the source of truth for anything Redis can't answer.
 *
 * Key namespace:
 *   biz:{businessId}                 → business config cache
 *   customer:{customerId}            → customer record cache
 *   kms:{ciphertextHash}             → KMS plaintext cache
 *   rl:{scope}:{id}                  → sliding-window rate-limit sorted set
 *   convo_lock:{conversationId}      → mutex ordering multi-message bursts
 *   msg_seen:{messageId}             → webhook idempotency (mirrors DynamoDB, faster path)
 *   resp_cache:{businessId}:{hash}   → cached AI response for a normalised message
 *   slot:{businessId}:{startAt}:{unitId} → reserved slot (NX lock) — prevents double-booking
 *   conv:{businessId}:{phone}           → conversation history list (last 12 messages, 1h TTL)
 */

const Redis = require('ioredis')
const log   = require('../utils/logger')

let _client = null

function getClient() {
  if (_client) return _client

  _client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    retryStrategy(times) {
      if (times > 3) return null
      return Math.min(times * 100, 500)
    },
    lazyConnect:          true,
    enableOfflineQueue:   false,
    connectTimeout:       2000,
    commandTimeout:       1000,
    keepAlive:            15000,
    maxRetriesPerRequest: 1,
  })

  _client.on('error', err => {
    log.warn('redis_error', { message: err.message })
  })

  return _client
}

// `lazyConnect` + `enableOfflineQueue: false` is a trap: on a cold container the
// socket isn't dialled yet and ioredis refuses to buffer, so the FIRST command of
// every cold start rejects with "Stream isn't writeable" — which the safe* wrappers
// below swallow. That silently dropped every login OTP (setOtp is the first Redis
// write the auth Lambda makes), making login impossible. So connect explicitly
// before the first command, while keeping enableOfflineQueue false so a genuinely
// unreachable Redis still fails fast instead of stalling the handler.
let _connecting = null

async function ready() {
  // In AWS with no Redis set (Flow's own stack), fail at once so callers use
  // their fallback, instead of retrying localhost on every call.
  if (!process.env.REDIS_URL && process.env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('Redis not configured')
  const client = getClient()
  if (client.status === 'ready') return client
  if (client.status === 'wait') {
    if (!_connecting) {
      _connecting = client.connect()
        .catch(() => { /* surfaced by the caller's own catch */ })
        .finally(() => { _connecting = null })
    }
    await _connecting
  }
  return client
}

async function safeGet(key) {
  try { return await (await ready()).get(key) }
  catch { return null }
}

async function safeSet(key, value, options = {}) {
  try {
    const client = await ready()
    if (options.NX && options.EX) return await client.set(key, value, 'EX', options.EX, 'NX')
    if (options.EX) return await client.set(key, value, 'EX', options.EX)
    return await client.set(key, value)
  } catch { return null }
}

async function safeDel(...keys) {
  try { return await (await ready()).del(...keys) }
  catch { return 0 }
}

// ── Business / customer cache ─────────────────────────────────────────────────

const BIZ_TTL      = 300
const CUSTOMER_TTL = 300

async function getCachedBusiness(businessId) {
  const raw = await safeGet(`biz:${businessId}`)
  return raw ? JSON.parse(raw) : null
}
async function setCachedBusiness(businessId, biz) {
  await safeSet(`biz:${businessId}`, JSON.stringify(biz), { EX: BIZ_TTL })
}
async function invalidateBusiness(businessId) {
  await safeDel(`biz:${businessId}`)
}

async function getCachedCustomer(customerId) {
  const raw = await safeGet(`customer:${customerId}`)
  return raw ? JSON.parse(raw) : null
}
async function setCachedCustomer(customerId, customer) {
  await safeSet(`customer:${customerId}`, JSON.stringify(customer), { EX: CUSTOMER_TTL })
}
async function invalidateCustomer(customerId) {
  await safeDel(`customer:${customerId}`)
}

// ── KMS plaintext cache ────────────────────────────────────────────────────────

async function getKmsCache(ciphertextHash) {
  return safeGet(`kms:${ciphertextHash}`)
}
async function setKmsCache(ciphertextHash, plaintext, ttlSeconds = 300) {
  await safeSet(`kms:${ciphertextHash}`, plaintext, { EX: ttlSeconds })
}

// ── Sliding-window rate limit ──────────────────────────────────────────────────
// Layer 1 of the 7-layer spam/cost protection. Per-customer, per-business.

async function checkSlidingRateLimit(scope, identifier, limit, windowMs = 60_000) {
  try {
    const key  = `rl:${scope}:${identifier}`
    const now  = Date.now()
    const pipe = (await ready()).pipeline()

    pipe.zremrangebyscore(key, 0, now - windowMs)
    pipe.zcard(key)
    pipe.zadd(key, now, `${now}-${Math.random()}`)
    pipe.expire(key, Math.ceil(windowMs / 1000) + 1)

    const results = await pipe.exec()
    const count   = results[1][1]
    return count >= limit   // true = rate limited
  } catch {
    return false   // fail open
  }
}

// Wipe a sliding window early. Used on successful login so a burst of failed
// attempts followed by the right password doesn't leave the owner locked out of
// their own account for the rest of the window.
async function clearSlidingRateLimit(scope, identifier) {
  await safeDel(`rl:${scope}:${identifier}`)
}

// ── Conversation mutex ─────────────────────────────────────────────────────────
// Orders multi-message bursts from the same customer so the slot-filling state
// machine never processes two messages from one conversation concurrently.

async function acquireConversationLock(conversationId, ttlSeconds = 10) {
  const result = await safeSet(`convo_lock:${conversationId}`, '1', { NX: true, EX: ttlSeconds })
  return result === 'OK'
}
async function releaseConversationLock(conversationId) {
  await safeDel(`convo_lock:${conversationId}`)
}

// ── Webhook message idempotency (fast path; DynamoDB is the durable record) ───

async function hasSeenMessage(messageId) {
  const val = await safeGet(`msg_seen:${messageId}`)
  return val !== null
}
async function markMessageSeen(messageId, ttlSeconds = 86_400) {
  await safeSet(`msg_seen:${messageId}`, '1', { EX: ttlSeconds })
}

// ── Response cache ──────────────────────────────────────────────────────────────
// Layer 5 of spam/cost protection — cuts repeat-question AI cost by 60-70%.

async function getCachedResponse(businessId, hash) {
  return safeGet(`resp_cache:${businessId}:${hash}`)
}
async function setCachedResponse(businessId, hash, response, ttlSeconds = 3600) {
  await safeSet(`resp_cache:${businessId}:${hash}`, response, { EX: ttlSeconds })
}

// ── Slot reservation ────────────────────────────────────────────────────────────
// Atomic NX lock per bookable unit — prevents two customers double-booking the
// same person/resource/group_spot/queue slot while the booking flow completes.

const SLOT_RESERVE_TTL = 300        // 5-min race guard at booking commit
const SLOT_HOLD_TTL    = 10 * 60    // 10-min soft hold while a customer pays

function _slotKey(businessId, startAt, unitId) {
  const minute = startAt.slice(0, 16)
  return `slot:${businessId}:${minute}:${unitId || 'any'}`
}

// Atomic NX lock. Re-entrant for the SAME customer: if they already hold the slot
// (a payment hold being confirmed by the webhook, or a webhook retry) we return
// true instead of failing. A slot held by a DIFFERENT customer returns false.
async function reserveSlot(businessId, startAt, unitId, customerId, ttl = SLOT_RESERVE_TTL) {
  const key = _slotKey(businessId, startAt, unitId)
  const result = await safeSet(key, customerId, { NX: true, EX: ttl })
  if (result === 'OK') { _trace('Seat locked for the booking write', { unit: unitId, start: startAt, lockSeconds: ttl }); return true }
  const holder = await safeGet(key)
  // holder null = Redis unreachable (or the key expired between SET and GET).
  // Fail OPEN like holdSlotForPayment: the caller has just re-checked the unit is
  // free in DynamoDB, so a Redis outage must not block every booking.
  if (holder == null) return (await backupClaim(businessId, startAt, unitId, customerId, ttl, 'lock')).held
  _trace(holder === customerId ? 'Seat already held by this customer ✓' : 'Seat held by another customer ✗', { unit: unitId, start: startAt })
  return holder === customerId
}

// Redis unreachable: hold the seat in the demo store instead (DynamoDB with a
// conditional write in AWS, memory locally), so two customers still can't both
// be sent a PayPal link for the last seat. If that store fails too, fail open:
// the booking re-checks the unit in DynamoDB, and a booking that can't be made
// after payment is refunded in full automatically (core/paymentConfirm).
async function backupClaim(businessId, startAt, unitId, customerId, ttlSec, what) {
  const sk = _slotKey(businessId, startAt, unitId)
  try {
    const r = await require('./demoStore').store().claimKey('SEATHOLD', sk, customerId || 'booking', Date.now() + ttlSec * 1000)
    if (r.claimed) { _trace(what === 'hold' ? `Seat held while the customer pays (${backupLabel()})` : `Seat locked for the booking write (${backupLabel()})`, { unit: unitId, start: startAt }); return { held: true, backup: true } }
    _trace(`Seat is being held by another customer ✗ (${backupLabel()})`, { unit: unitId, start: startAt })
    return { held: false }
  } catch (err) {
    _trace(`Seat hold skipped: ${backupStore()} unreachable (the booking still re-checks the seat, and refunds in full if it's taken)`, { unit: unitId, reason: String(err.message).slice(0, 60) })
    return { held: true, degraded: true }
  }
}

// Where a backup hold lives, for Under the hood. Flow's own stack has no Redis on
// purpose, so there the hold is simply "DynamoDB", not an error; "Redis
// unreachable" only shows when a Redis address is set and it doesn't answer.
function backupStore() { return process.env.AWS_LAMBDA_FUNCTION_NAME ? 'DynamoDB' : 'demo store' }
function backupLabel() { return process.env.REDIS_URL ? `${backupStore()}, Redis unreachable` : backupStore() }

function _trace(title, detail) {
  require('./trace').event('redis', title, detail)
}

// Soft-hold a seat for the duration of a payment window. Returns:
//   { held: true }                 — we now hold it (or already did)
//   { held: true, degraded: true } — Redis unavailable; fail OPEN so payment can
//                                    proceed (the webhook's reserveSlot is the
//                                    authoritative final check), behaviour matches
//                                    the pre-hold world — no worse, no oversell-safe
//   { held: false }                — a different customer is holding/booking it
async function holdSlotForPayment(businessId, startAt, unitId, customerId) {
  const key = _slotKey(businessId, startAt, unitId)
  const result = await safeSet(key, customerId, { NX: true, EX: SLOT_HOLD_TTL })
  if (result === 'OK') { _trace('Seat held while the customer pays', { unit: unitId, start: startAt, expiresInSeconds: SLOT_HOLD_TTL }); return { held: true } }
  const holder = await safeGet(key)
  if (holder == null) return backupClaim(businessId, startAt, unitId, customerId, SLOT_HOLD_TTL, 'hold')   // Redis down (or just expired)
  if (holder === customerId) { _trace('Seat still held for this customer ✓', { unit: unitId, start: startAt }); return { held: true } }
  _trace('Seat is being held by another customer ✗', { unit: unitId, start: startAt })
  return { held: false }
}

// Owner-safe when customerId is given: only frees the hold if this customer owns
// it (so releasing customer A's abandoned payment can't free customer B's seat).
async function releaseSlot(businessId, startAt, unitId, customerId) {
  const key = _slotKey(businessId, startAt, unitId)
  if (customerId) {
    const holder = await safeGet(key)
    if (holder != null && holder !== customerId) return
  }
  const removed = await safeDel(key)
  if (removed) _trace('Seat hold released', { unit: unitId, start: startAt })
  // A backup hold (taken while Redis was unreachable) is released the same way, owner-safe.
  try {
    const s = require('./demoStore').store()
    const b = await s.getKey('SEATHOLD', key)
    if (b && (!customerId || b.owner === customerId)) { await s.deleteKey('SEATHOLD', key); _trace(`Seat hold released (${backupStore()})`, { unit: unitId, start: startAt }) }
  } catch { /* it expires by itself within minutes */ }
}

// ── Payment intent (payment link -> pending booking) ───────────────────────────
// Bridges the gap between "AI sent the customer a payment link" and the
// payment webhook confirming it was paid. 30-min TTL: long enough for the
// customer to open the link and pay, short enough that an abandoned link
// doesn't leak memory. DynamoDB pendingPayments is the durable fallback.

const PAYMENT_INTENT_TTL = 30 * 60

async function savePaymentIntent(referenceId, intent) {
  await safeSet(`pay_intent:${referenceId}`, JSON.stringify(intent), { EX: PAYMENT_INTENT_TTL })
}
async function getPaymentIntent(referenceId) {
  const raw = await safeGet(`pay_intent:${referenceId}`)
  return raw ? JSON.parse(raw) : null
}
async function deletePaymentIntent(referenceId) {
  await safeDel(`pay_intent:${referenceId}`)
}

// ── RAG embedding cache ─────────────────────────────────────────────────────────
// Stores chunk text + embeddings per business in a Redis hash for sub-ms
// similarity search at query time. DynamoDB is the durable store; this is the
// fast path. Each field in the hash is a chunkId, value is JSON {text, embedding}.

const RAG_TTL = 3600

async function setRagChunk(businessId, chunkId, text, embedding) {
  try {
    const client = await ready()
    const key = `rag:${businessId}`
    await client.hset(key, chunkId, JSON.stringify({ text, embedding }))
    await client.expire(key, RAG_TTL)
  } catch { /* fail open */ }
}

async function getRagChunks(businessId) {
  try {
    const raw = await (await ready()).hgetall(`rag:${businessId}`)
    if (!raw || !Object.keys(raw).length) return null
    return Object.entries(raw).map(([chunkId, json]) => {
      const { text, embedding } = JSON.parse(json)
      return { chunkId, text, embedding }
    })
  } catch { return null }
}

async function clearRagChunks(businessId) {
  await safeDel(`rag:${businessId}`)
}

// ── Conversation history ────────────────────────────────────────────────────────
// Last N messages per (businessId, customerPhone) for AI context across turns.
// Redis list, 1-hour TTL. Not durable — a warm conversation works, a cold
// restart just loses context (acceptable for v1).

const CONVO_TTL = 3600
const MAX_CONVO_MESSAGES = 12

async function getConversationHistory(businessId, phone) {
  try {
    const key = `conv:${businessId}:${phone}`
    const raw = await (await ready()).lrange(key, 0, MAX_CONVO_MESSAGES - 1)
    return raw.map(r => JSON.parse(r))
  } catch { return [] }
}

async function appendConversationHistory(businessId, phone, role, content) {
  try {
    const key = `conv:${businessId}:${phone}`
    const client = await ready()
    await client.rpush(key, JSON.stringify({ role, content }))
    await client.ltrim(key, -MAX_CONVO_MESSAGES, -1)
    await client.expire(key, CONVO_TTL)
  } catch { /* fail open */ }
}

async function clearConversationHistory(businessId, phone) {
  await safeDel(`conv:${businessId}:${phone}`)
}

// ── OTP for dashboard auth ──────────────────────────────────────────────────────

async function setOtp(phone, otp) {
  await safeSet(`otp:${phone}`, otp, { EX: 300 })
}
async function getOtp(phone) {
  return safeGet(`otp:${phone}`)
}
async function deleteOtp(phone) {
  await safeDel(`otp:${phone}`)
}

// Per-business daily counter for AI-setup generations (cost-abuse guard).
// Fails open (returns 0) so a Redis outage never blocks legitimate setup.
async function incrSetupCount(businessId) {
  try {
    const client = await ready()
    const key = `setup_count:${businessId}:${new Date().toISOString().slice(0, 10)}`
    const n = await client.incr(key)
    await client.expire(key, 86_400)
    return n
  } catch { return 0 }
}

// ── Document hash dedup ─────────────────────────────────────────────────────────

async function hasDocumentHash(businessId, hash) {
  const val = await safeGet(`doc_hash:${businessId}:${hash}`)
  return val !== null
}
async function setDocumentHash(businessId, hash) {
  await safeSet(`doc_hash:${businessId}:${hash}`, '1', { EX: 86_400 * 30 })
}

// ── Health check ─────────────────────────────────────────────────────────────────

async function ping() {
  try { await (await ready()).ping(); return true }
  catch { return false }
}

module.exports = {
  getCachedBusiness, setCachedBusiness, invalidateBusiness,
  getCachedCustomer, setCachedCustomer, invalidateCustomer,
  getKmsCache, setKmsCache,
  checkSlidingRateLimit, clearSlidingRateLimit,
  acquireConversationLock, releaseConversationLock,
  hasSeenMessage, markMessageSeen,
  getCachedResponse, setCachedResponse,
  reserveSlot, releaseSlot, holdSlotForPayment,
  savePaymentIntent, getPaymentIntent, deletePaymentIntent,
  setRagChunk, getRagChunks, clearRagChunks,
  getConversationHistory, appendConversationHistory, clearConversationHistory,
  setOtp, getOtp, deleteOtp, incrSetupCount,
  hasDocumentHash, setDocumentHash,
  ping,
}
