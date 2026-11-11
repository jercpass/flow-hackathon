// @ts-check
'use strict'

// ─── "Under the hood" trace ───────────────────────────────────────────────────
// A per-session timeline of what the system actually did, shown live beside the
// chat: AI model + tool calls, Redis seat holds, PayPal order/capture/refund,
// policy maths, DB writes, inbox messages, webhooks. Built for judges/the video, and a
// genuinely useful debugging view.
//
//   await trace.run(scope, async () => { ... })   // opens a scope (e.g. sess:<sid>)
//   trace.event('redis', 'Seat held', { unit, expiresIn: 600 })
//   await trace.span('paypal', 'Capture', () => capture(id), r => ({ status: r.status }))
//
// Scope travels with the async call chain (AsyncLocalStorage), so deep modules
// emit without passing anything around. No scope → every call is a cheap no-op,
// which keeps real-customer traffic and unit tests untouched. Writes are fire-and-
// forget during the request and awaited when the scope closes (Lambda freezes
// after the response, so nothing may be left in flight). Detail objects are
// redacted: secrets dropped, emails masked, long ids shortened.

const { AsyncLocalStorage } = require('async_hooks')
const log = require('../utils/logger')

const als = new AsyncLocalStorage()
const TTL_SECONDS = 24 * 60 * 60
const MAX_DETAIL_CHARS = 600

// ── Sink (DynamoDB by default; swappable for tests / local scripts) ──────────

const dynamoSink = {
  async write(ev) {
    const { db, TABLES, PutCommand } = require('./dynamo/client')
    if (!TABLES.TRACE_EVENTS) return
    await db.send(new PutCommand({
      TableName: TABLES.TRACE_EVENTS,
      Item: { ...ev, sk: sortKey(ev), ttl: Math.floor(ev.ts / 1000) + TTL_SECONDS }
    }))
  },
  async read(scope, sinceSk, limit) {
    const { db, TABLES, QueryCommand } = require('./dynamo/client')
    if (!TABLES.TRACE_EVENTS) return []
    // First load (no cursor) → the NEWEST `limit` events; polling → everything after the cursor.
    const { Items } = await db.send(new QueryCommand({
      TableName: TABLES.TRACE_EVENTS,
      // 'scope' is a DynamoDB reserved word, so it goes through a placeholder.
      KeyConditionExpression: sinceSk ? '#scope = :s AND sk > :since' : '#scope = :s',
      ExpressionAttributeNames: { '#scope': 'scope' },
      ExpressionAttributeValues: sinceSk ? { ':s': scope, ':since': sinceSk } : { ':s': scope },
      ScanIndexForward: !!sinceSk,
      Limit: limit
    }))
    return sinceSk ? (Items || []) : (Items || []).reverse()
  },
  async clear(scope) {
    const { db, TABLES, QueryCommand, DeleteCommand } = require('./dynamo/client')
    if (!TABLES.TRACE_EVENTS) return
    let startKey
    do {
      const r = await db.send(new QueryCommand({
        TableName: TABLES.TRACE_EVENTS, KeyConditionExpression: '#scope = :s', ExpressionAttributeNames: { '#scope': 'scope' },
        ExpressionAttributeValues: { ':s': scope }, ExclusiveStartKey: startKey
      }))
      await Promise.all((r.Items || []).map(i => db.send(new DeleteCommand({ TableName: TABLES.TRACE_EVENTS, Key: { scope: i.scope, sk: i.sk } }))))
      startKey = r.LastEvaluatedKey
    } while (startKey)
  }
}

function memorySink() {
  const events = []
  return {
    events,
    async write(ev) { events.push({ ...ev, sk: sortKey(ev) }) },
    async read(scope, sinceSk, limit) {
      const mine = events.filter(e => e.scope === scope && (!sinceSk || e.sk > sinceSk))
      return sinceSk ? mine.slice(0, limit) : mine.slice(-limit)
    },
    async clear(scope) {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].scope === scope) events.splice(i, 1)
    }
  }
}

// TRACE_STORE=memory keeps the timeline in-process (local runs without AWS tables).
let sink = process.env.TRACE_STORE === 'memory' ? memorySink() : dynamoSink
function setSink(s) { sink = s || dynamoSink }

async function clear(scope) {
  if (sink.clear) await sink.clear(scope)
}

// ts + per-scope sequence keeps events ordered even within one millisecond.
function sortKey(ev) {
  return `${String(ev.ts).padStart(14, '0')}#${String(ev.seq).padStart(5, '0')}#${ev.id}`
}

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * Run fn inside a trace scope. Re-entering the same scope reuses the open one;
 * a different scope opens a nested one. Pending writes are flushed before return.
 * @template T
 * @param {string|null|undefined} scope
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function run(scope, fn) {
  if (!scope) return fn()
  const current = als.getStore()
  if (current && current.scope === scope) return fn()
  const ctx = { scope, counter: { seq: 0 }, pending: [], business: null }
  try {
    return await als.run(ctx, fn)
  } finally {
    await Promise.allSettled(ctx.pending)
  }
}

function currentScope() {
  return als.getStore()?.scope || null
}

/**
 * Run fn with every event inside it tagged with this business, so the timeline
 * can show one business at a time (the owner side's selector). Same scope,
 * same ordering; no scope or no business → just runs fn.
 * @template T
 * @param {{ businessId?: string, name?: string }|null|undefined} business
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function forBusiness(business, fn) {
  const cur = als.getStore()
  if (!cur || !business?.businessId) return fn()
  if (cur.business?.id === business.businessId) return fn()
  return als.run({ ...cur, business: { id: business.businessId, name: business.name || null } }, fn)
}

// ── Emit ─────────────────────────────────────────────────────────────────────

/**
 * @param {'ai'|'tool'|'redis'|'paypal'|'policy'|'db'|'inbox'|'webhook'|'media'|'session'|'mcp'} layer
 * @param {string} title
 * @param {object} [detail]
 * @param {number} [ms]
 */
function event(layer, title, detail, ms) {
  const ctx = als.getStore()
  if (!ctx) return
  const ev = {
    scope: ctx.scope,
    id: Math.random().toString(36).slice(2, 8),
    ts: Date.now(),
    seq: ++ctx.counter.seq,
    layer,
    title: String(title).slice(0, 160),
    detail: detail ? redact(detail) : null,
    ms: Number.isFinite(ms) ? Math.round(/** @type {number} */ (ms)) : null,
    ...(ctx.business ? { biz: ctx.business.id, bizName: ctx.business.name } : {})
  }
  // A session's customer names are written as tokens (services/pii, PRIVACY_TOKENS.md).
  ctx.pending.push(
    Promise.resolve().then(() => require('./pii').scrubEvent(ev)).then(e => sink.write(e)).catch(err => log.warn('trace_write_failed', { err: err.message }))
  )
}

/**
 * Time an async step and emit one event with its outcome (or failure).
 * @template T
 * @param {Parameters<typeof event>[0]} layer
 * @param {string} title
 * @param {() => Promise<T>} fn
 * @param {(result: T) => object} [summarize]
 * @returns {Promise<T>}
 */
async function span(layer, title, fn, summarize) {
  if (!als.getStore()) return fn()
  const t0 = Date.now()
  try {
    const result = await fn()
    let detail
    try { detail = summarize ? summarize(result) : undefined } catch { detail = undefined }
    event(layer, title, detail, Date.now() - t0)
    return result
  } catch (err) {
    event(layer, `${title} — failed`, { error: err.code || err.message }, Date.now() - t0)
    throw err
  }
}

// ── Read ─────────────────────────────────────────────────────────────────────

async function read(scope, since, limit = 200) {
  const items = await sink.read(scope, since || null, limit)
  return items.map(({ scope: _s, ttl: _t, ...ev }) => ev)
}

// ── Redaction ────────────────────────────────────────────────────────────────

const SECRET_KEY = /token|secret|password|authorization|assertion|apikey|api_key|cookie|otp/i
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g

function redact(value, depth = 0) {
  if (value == null || depth > 3) return value
  if (typeof value === 'string') return value.replace(EMAIL, '$1•••@$2').slice(0, 200)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 10).map(v => redact(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) continue
    out[k] = redact(v, depth + 1)
  }
  const json = JSON.stringify(out)
  return json.length > MAX_DETAIL_CHARS ? { summary: json.slice(0, MAX_DETAIL_CHARS) + '…' } : out
}

// Shorten provider ids for display: "5O190127TN364715T" → "5O1901…715T".
function short(id) {
  const s = String(id || '')
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s
}

module.exports = { run, event, span, read, clear, currentScope, forBusiness, short, redact, setSink, memorySink }
