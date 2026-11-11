// @ts-check
'use strict'

// ─── Customer names out of the AI's reach ───
// Flow's own AI (Claude) and the Under the hood timeline see a customer's name
// only as a token like ⟦pii:K7QX2M9P⟧. The real name is put back by code just
// before someone allowed to see it reads or hears it (the chat, Telegram, a
// spoken reply), and in tool arguments just before a tool runs.
//
// One vault per demo session: token → name, stored encrypted (AES-256-GCM, a
// key derived from FLOW_LINK_SECRET and the session id) and deleted with the
// session. A token is an HMAC of the name, so a name gets the same token all
// session long, and the same token never means two names.

const crypto = require('crypto')
const { store } = require('./demoStore')
const log = require('../utils/logger')

const TOKEN_RE = /[⟦[]{1,2}pii:([A-Z2-7]{8})[⟧\]]{1,2}/g
const MIN_LEN = 2
const CACHE_MS = 30_000
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

// The prompt line Claude gets when its context holds tokens.
const PROMPT_NOTE = 'People\'s names appear as tokens like ⟦pii:K7QX2M9P⟧; the customer sees their real name in its place. Treat a token as the name itself and talk naturally, the way a friendly receptionist who knows them would ("You\'re ⟦pii:K7QX2M9P⟧!", "Hi ⟦pii:K7QX2M9P⟧, good to see you"). Never say "on file", "in our records" or "registered as", never mention tokens or privacy, and never ask the customer to repeat their name. Copy a token exactly wherever the name belongs, including tool arguments such as customer_name.'

function secret() {
  const s = process.env.PII_SECRET || process.env.FLOW_LINK_SECRET
  if (!s) throw new Error('PII_SECRET or FLOW_LINK_SECRET is required for the name vault')
  return s
}

/** The session's key, for both the token HMAC and the vault encryption. */
function keyFor(sid) {
  return Buffer.from(crypto.hkdfSync('sha256', secret(), String(sid), 'flow-pii-v1', 32))
}

function base32(buf) {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  return out
}

const norm = v => String(v || '').trim().replace(/\s+/g, ' ')
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

class Vault {
  /** @param {string} sid @param {Record<string, string>} [entries] token id → name */
  constructor(sid, entries = {}) {
    this.sid = String(sid)
    this.key = keyFor(this.sid)
    this.byId = { ...entries }
    this.dirty = false
    this._re = null
  }

  idOf(value) {
    return base32(crypto.createHmac('sha256', this.key).update(norm(value).toLowerCase()).digest()).slice(0, 8)
  }

  /** Remember a name (and, for a full name, its first name); returns its token. */
  add(value) {
    const v = norm(value)
    if (v.length < MIN_LEN) return v
    const parts = v.split(' ')
    if (parts.length > 1 && parts[0].length >= MIN_LEN) this.add(parts[0])
    const id = this.idOf(v)
    if (this.byId[id] !== v) { this.byId[id] = v; this.dirty = true; this._re = null }
    return `⟦pii:${id}⟧`
  }

  get size() { return Object.keys(this.byId).length }
  values() { return Object.values(this.byId) }

  // Longest names first, so "Maya Patel" is one token, not "Maya" plus "Patel".
  matcher() {
    if (this._re === null) {
      const names = [...new Set(this.values())].sort((a, b) => b.length - a.length).map(escapeRe)
      this._re = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${names.join('|')})(?![\\p{L}\\p{N}])`, 'gu') : false
    }
    return this._re
  }

  /** Names → tokens in a string. */
  tokenize(text) {
    if (typeof text !== 'string' || !text) return text
    const re = this.matcher()
    return re ? text.replace(re, m => `⟦pii:${this.idOf(m)}⟧`) : text
  }

  /** Tokens → names. An unknown token becomes `unknown` (default: left as is). */
  detokenize(text, unknown) {
    if (typeof text !== 'string' || !text.includes('pii:')) return text
    return text.replace(TOKEN_RE, (m, id) => this.byId[id] ?? (unknown === undefined ? m : unknown))
  }

  tokenizeDeep(value) { return deep(value, s => this.tokenize(s)) }
  detokenizeDeep(value, unknown) { return deep(value, s => this.detokenize(s, unknown)) }

  /** Token ids in a value that this vault doesn't know. */
  unknownTokens(value) {
    const out = new Set()
    deep(value, s => { for (const [, id] of s.matchAll(TOKEN_RE)) if (!(id in this.byId)) out.add(id); return s })
    return [...out]
  }
}

function deep(value, fn, depth = 0) {
  if (typeof value === 'string') return fn(value)
  if (value == null || typeof value !== 'object' || depth > 8) return value
  if (Array.isArray(value)) return value.map(v => deep(v, fn, depth + 1))
  if (Buffer.isBuffer(value)) return value
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = deep(v, fn, depth + 1)
  return out
}

// ── Storage (encrypted, in the demo store under the session) ───────────────────

const cache = new Map()   // sid → { vault, at }

function encrypt(vault) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', vault.key, iv)
  const data = Buffer.concat([c.update(JSON.stringify(vault.byId), 'utf8'), c.final()])
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function decrypt(sid, rec) {
  const key = keyFor(sid)
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'))
  d.setAuthTag(Buffer.from(rec.tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(rec.data, 'base64')), d.final()]).toString('utf8'))
}

async function load(sid) {
  const hit = cache.get(String(sid))
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.vault
  let entries = {}
  try {
    const rec = await store().getKey(`S#${sid}`, 'PII')
    if (rec?.data) entries = decrypt(sid, rec)
  } catch (err) {
    log.warn('pii_vault_load_failed', { err: String(err.message).slice(0, 120) })
  }
  const vault = new Vault(sid, entries)
  cache.set(String(sid), { vault, at: Date.now() })
  return vault
}

async function save(vault, expiresAt) {
  cache.set(vault.sid, { vault, at: Date.now() })
  if (!vault.dirty) return
  await store().putKey(`S#${vault.sid}`, 'PII', encrypt(vault), expiresAt)
  vault.dirty = false
}

/**
 * The session's vault, holding the customer's current name (and any earlier one).
 * @param {{ sid: string, expiresAt?: number, customerName?: string }} session
 * @param {...(string|null|undefined)} names more names to remember
 */
async function vaultFor(session, ...names) {
  const vault = await load(session.sid)
  for (const n of [session.customerName, ...names]) if (n) vault.add(n)
  await save(vault, session.expiresAt).catch(err => log.warn('pii_vault_save_failed', { err: String(err.message).slice(0, 120) }))
  return vault
}

/** Remember a name for a session (a new PayPal login name, say) before it's recorded anywhere. */
async function remember(session, name) {
  if (!session?.sid || !name) return
  await vaultFor(session, name)
}

/** Forget a session's cached vault (its store record goes with the session). */
function forget(sid) { cache.delete(String(sid)) }

// ── The owner's own AI (MCP), when the owner hides customer names ──────────────

const PERSON_KEY = /^(customer|customer_?name|buyer(_?name)?|payer(_?name)?|member(_?name)?|guest(_?name)?)$/i
const PEOPLE_LIST = /^(customers|members|guests)$/i

/** Customer names in a tool result: person fields, and the names in customer or member lists. */
function namesIn(value, out = new Set(), parentKey = '', depth = 0) {
  if (value == null || typeof value !== 'object' || depth > 8) return out
  if (Array.isArray(value)) { for (const v of value) namesIn(v, out, parentKey, depth + 1); return out }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && (PERSON_KEY.test(k) || (k === 'name' && PEOPLE_LIST.test(parentKey)))) {
      if (v.trim().length >= MIN_LEN && !/^(customer|a customer|walk-in|guest)$/i.test(v.trim())) out.add(v.trim())
    } else namesIn(v, out, k, depth + 1)
  }
  return out
}

// ── Under the hood ─────────────────────────────────────────────────────────────

/** A trace event with its session's names tokenized (services/trace calls this before writing). */
async function scrubEvent(ev) {
  const m = /^sess:(.+)$/.exec(String(ev?.scope || ''))
  if (!m) return ev
  const hit = cache.get(m[1])
  // Unit tests run without a store: use what this process already knows.
  const vault = hit ? hit.vault : (process.env.JEST_WORKER_ID ? null : await load(m[1]))
  if (!vault?.size) return ev
  return { ...ev, title: vault.tokenize(ev.title), detail: vault.tokenizeDeep(ev.detail) }
}

module.exports = { Vault, vaultFor, remember, forget, load, persist: save, scrubEvent, namesIn, PROMPT_NOTE, TOKEN_RE }
