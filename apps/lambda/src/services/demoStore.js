// @ts-check
'use strict'

// ─── Demo store: sessions, per-session inbox, rate-limit counters ─────────────
// One DynamoDB table (flow-demo, 24h TTL on everything):
//   pk S#<sid>  sk META              → the session
//   pk S#<sid>  sk M#<ts>#<id>        → an inbox message
//   pk RL#<key> sk <window>          → a fixed-window counter
//   pk S#<sid>  sk SETUP#draft       → the guided demo's AI setup draft
// DEMO_STORE=memory swaps in an in-process store so the whole demo runs locally
// without creating any AWS table (scripts/local-api.js uses it).

const TTL_SECONDS = 24 * 60 * 60

function now() { return Date.now() }
function ttlFrom(ms) { return Math.floor(ms / 1000) }

// ── DynamoDB backend ─────────────────────────────────────────────────────────

const dynamo = {
  _c() { return require('./dynamo/client') },
  table() { return process.env.DYNAMO_DEMO || 'flow-demo' },

  async putSession(s) {
    const { db, PutCommand } = this._c()
    await db.send(new PutCommand({ TableName: this.table(), Item: { pk: `S#${s.sid}`, sk: 'META', ...s, ttl: ttlFrom(s.expiresAt) } }))
  },
  async getSession(sid) {
    const { db, GetCommand } = this._c()
    const { Item } = await db.send(new GetCommand({ TableName: this.table(), Key: { pk: `S#${sid}`, sk: 'META' } }))
    return Item ? strip(Item) : null
  },
  async updateSession(sid, updates) {
    const { db, UpdateCommand } = this._c()
    const keys = Object.keys(updates)
    if (!keys.length) return
    await db.send(new UpdateCommand({
      TableName: this.table(), Key: { pk: `S#${sid}`, sk: 'META' },
      UpdateExpression: `SET ${keys.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(keys.map((k, i) => [`#k${i}`, k])),
      ExpressionAttributeValues: Object.fromEntries(keys.map((k, i) => [`:v${i}`, updates[k]]))
    }))
  },
  async addMessage(sid, msg) {
    const { db, PutCommand } = this._c()
    await db.send(new PutCommand({ TableName: this.table(), Item: { pk: `S#${sid}`, sk: `M#${msg.ts}#${msg.id}`, ...msg, ttl: ttlFrom(now()) + TTL_SECONDS } }))
  },
  async listMessages(sid, sinceSk) {
    const { db, QueryCommand } = this._c()
    const { Items } = await db.send(new QueryCommand({
      TableName: this.table(),
      KeyConditionExpression: sinceSk ? 'pk = :p AND sk > :s' : 'pk = :p AND begins_with(sk, :m)',
      ExpressionAttributeValues: sinceSk ? { ':p': `S#${sid}`, ':s': sinceSk } : { ':p': `S#${sid}`, ':m': 'M#' }
    }))
    return (Items || []).filter(i => i.sk.startsWith('M#')).map(strip)
  },
  async markRead(sid, sks) {
    const { db, UpdateCommand } = this._c()
    await Promise.all(sks.filter(sk => sk.startsWith('M#')).map(sk => db.send(new UpdateCommand({
      TableName: this.table(), Key: { pk: `S#${sid}`, sk }, UpdateExpression: 'SET #r = :t',
      ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeNames: { '#r': 'read' }, ExpressionAttributeValues: { ':t': true }
    })).catch(() => {})))
  },
  async deleteSessionItems(sid) {
    const { db, QueryCommand, DeleteCommand } = this._c()
    const { Items } = await db.send(new QueryCommand({ TableName: this.table(), KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': `S#${sid}` } }))
    await Promise.all((Items || []).map(i => db.send(new DeleteCommand({ TableName: this.table(), Key: { pk: i.pk, sk: i.sk } }))))
  },
  // Atomic fixed-window counter: returns true when the limit is already reached.
  async hit(key, window, limit, ttlSec) {
    const { db, UpdateCommand } = this._c()
    try {
      await db.send(new UpdateCommand({
        TableName: this.table(), Key: { pk: `RL#${key}`, sk: String(window) },
        UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
        ConditionExpression: 'attribute_not_exists(#c) OR #c < :limit',
        ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':ttl': ttlFrom(now()) + ttlSec }
      }))
      return false
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') return true
      throw err
    }
  },
  // Small keyed records (e.g. the guided demo's setup draft). expiresAt (ms)
  // becomes the item TTL.
  async putKey(pk, sk, data, expiresAt) {
    const { db, PutCommand } = this._c()
    await db.send(new PutCommand({ TableName: this.table(), Item: { pk, sk, ...data, ttl: ttlFrom(expiresAt || now() + TTL_SECONDS * 1000) } }))
  },
  async getKey(pk, sk) {
    const { db, GetCommand } = this._c()
    const { Item } = await db.send(new GetCommand({ TableName: this.table(), Key: { pk, sk } }))
    if (!Item || (Item.ttl && Item.ttl * 1000 < now())) return null   // TTL deletion lags
    const { pk: _p, sk: _s, ttl: _t, ...rest } = Item
    return rest
  },
  // Every live record under one key (a business's held seats, its disputes…).
  async listKeys(pk) {
    const { db, QueryCommand } = this._c()
    const { Items } = await db.send(new QueryCommand({ TableName: this.table(), KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk } }))
    return (Items || []).filter(i => !(i.ttl && i.ttl * 1000 < now())).map(({ pk: _p, ttl: _t, ...rest }) => rest)
  },
  async deleteKey(pk, sk) {
    const { db, DeleteCommand } = this._c()
    await db.send(new DeleteCommand({ TableName: this.table(), Key: { pk, sk } }))
  },
  // A short claim only one owner can hold at a time (the seat-hold backup when
  // Redis is down): taken if free, expired, or already this owner's.
  async claimKey(pk, sk, owner, expiresAt) {
    const { db, PutCommand, GetCommand } = this._c()
    try {
      await db.send(new PutCommand({
        TableName: this.table(), Item: { pk, sk, owner, ttl: ttlFrom(expiresAt) },
        ConditionExpression: 'attribute_not_exists(pk) OR #t < :now OR #o = :owner',
        ExpressionAttributeNames: { '#t': 'ttl', '#o': 'owner' },
        ExpressionAttributeValues: { ':now': ttlFrom(now()), ':owner': owner }
      }))
      return { claimed: true }
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') throw err
      const { Item } = await db.send(new GetCommand({ TableName: this.table(), Key: { pk, sk } }))
      return { claimed: false, owner: Item?.owner || null }
    }
  },
  async listExpiredSessions(beforeMs) {
    const { db, ScanCommand } = this._c()
    const { Items } = await db.send(new ScanCommand({
      TableName: this.table(), FilterExpression: 'sk = :m AND expiresAt < :t',
      ExpressionAttributeValues: { ':m': 'META', ':t': beforeMs }
    }))
    return (Items || []).map(strip)
  }
}

function strip(item) {
  const { pk: _p, ttl: _t, ...rest } = item
  return rest
}

// ── Memory backend (local runs, tests) ───────────────────────────────────────

function memory() {
  const sessions = new Map()
  const messages = new Map()
  const counters = new Map()
  const keys = new Map()
  return {
    async putSession(s) { sessions.set(s.sid, { ...s, sk: 'META' }) },
    async getSession(sid) { const s = sessions.get(sid); return s ? { ...s } : null },
    async updateSession(sid, u) { const s = sessions.get(sid); if (s) sessions.set(sid, { ...s, ...u }) },
    async addMessage(sid, msg) {
      const list = messages.get(sid) || []
      list.push({ ...msg, sk: `M#${msg.ts}#${msg.id}` })
      list.sort((a, b) => (a.sk < b.sk ? -1 : 1))
      messages.set(sid, list)
    },
    async listMessages(sid, sinceSk) { return (messages.get(sid) || []).filter(m => !sinceSk || m.sk > sinceSk).map(m => ({ ...m })) },
    async markRead(sid, sks) { for (const m of messages.get(sid) || []) if (sks.includes(m.sk)) m.read = true },
    async deleteSessionItems(sid) {
      sessions.delete(sid); messages.delete(sid)
      for (const k of keys.keys()) if (k.startsWith(`S#${sid}|`)) keys.delete(k)
    },
    async putKey(pk, sk, data, expiresAt) { keys.set(`${pk}|${sk}`, { data: { ...data }, expiresAt: expiresAt || Date.now() + TTL_SECONDS * 1000 }) },
    async getKey(pk, sk) {
      const e = keys.get(`${pk}|${sk}`)
      if (!e || e.expiresAt < Date.now()) return null
      return { ...e.data }
    },
    async listKeys(pk) {
      return [...keys.entries()].filter(([k, e]) => k.startsWith(`${pk}|`) && e.expiresAt >= Date.now()).map(([k, e]) => ({ sk: k.slice(pk.length + 1), ...e.data }))
    },
    async deleteKey(pk, sk) { keys.delete(`${pk}|${sk}`) },
    async claimKey(pk, sk, owner, expiresAt) {
      const e = keys.get(`${pk}|${sk}`)
      if (e && e.expiresAt >= Date.now() && e.data.owner !== owner) return { claimed: false, owner: e.data.owner }
      keys.set(`${pk}|${sk}`, { data: { owner }, expiresAt })
      return { claimed: true }
    },
    async hit(key, window, limit) {
      const k = `${key}|${window}`
      const c = counters.get(k) || 0
      if (c >= limit) return true
      counters.set(k, c + 1)
      return false
    },
    async listExpiredSessions(beforeMs) { return [...sessions.values()].filter(s => s.expiresAt < beforeMs).map(s => ({ ...s })) }
  }
}

let backend = null
function store() {
  if (!backend) backend = process.env.DEMO_STORE === 'memory' ? memory() : dynamo
  return backend
}
function setStore(s) { backend = s }

module.exports = { store, setStore, memory, TTL_SECONDS }
