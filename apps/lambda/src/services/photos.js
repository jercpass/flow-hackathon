// @ts-check
'use strict'

// ─── Reference photos on the booking ─────
// A photo a customer sends in chat (the cut they want, a beard shape) is kept for
// the session so it can go on their booking and the owner sees the picture, not
// just Claude's description of it. Only the demo session can attach its own
// photos. On AWS the bytes go to S3; locally they stay in the demo store. All of
// it is deleted when the session ends (core/demoSession.endSession).

const crypto = require('crypto')
const { store } = require('./demoStore')
const { createToken, verifyToken } = require('../utils/jwt')
const log = require('../utils/logger')

const MAX_PER_SESSION = 10
const MAX_BYTES = 4_000_000
const LINK_SECONDS = 3600
const onAws = () => !!(process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.S3_DOCUMENTS_BUCKET)
const recordKey = id => [`PHOTO#${id}`, 'P']

/**
 * Keep a photo the customer sent; returns its id, or null when it can't be kept
 * (too many this session, too big): the description still goes in the notes.
 * @param {{ sid: string, expiresAt: number, photos?: string[] }} session
 * @param {{ buffer: Buffer, mimeType: string }} photo
 */
async function save(session, { buffer, mimeType }) {
  const ids = Array.isArray(session.photos) ? session.photos : []
  if (ids.length >= MAX_PER_SESSION || !buffer?.length || buffer.length > MAX_BYTES) return null
  const id = `ph_${crypto.randomBytes(9).toString('base64url')}`
  const type = /^image\/(jpeg|png|webp|gif)$/.test(String(mimeType)) ? mimeType : 'image/jpeg'
  const record = { sid: session.sid, mimeType: type, size: buffer.length }
  try {
    if (onAws()) {
      const key = `demo-photos/${session.sid}/${id}`
      await require('./s3').putFile(key, buffer, type)
      Object.assign(record, { key })
    } else {
      Object.assign(record, { data: buffer.toString('base64') })
    }
    const [pk, sk] = recordKey(id)
    await store().putKey(pk, sk, record, session.expiresAt)
    await store().updateSession(session.sid, { photos: [...ids, id] })
    session.photos = [...ids, id]
    return id
  } catch (err) {
    log.warn('photo_save_failed', { sid: session.sid, err: String(err.message).slice(0, 120) })
    return null
  }
}

/** The ids, of those given, that this session's customer sent (anything else is dropped). */
async function owned(sid, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(x => /^ph_[\w-]{6,20}$/.test(x)).slice(0, 3)
  const out = []
  for (const id of wanted) {
    const rec = await store().getKey(...recordKey(id))
    if (rec?.sid === sid) out.push(id)
  }
  return out
}

/** A signed link to view one photo, valid for an hour (no login needed, like inbox files). */
function link(id) {
  return `${process.env.API_URL || ''}/demo/photo?f=${createToken({ typ: 'photo', id }, LINK_SECONDS)}`
}

/** GET /demo/photo?f=…: the picture, while its session is still running. */
async function serve(query) {
  let p
  try { p = verifyToken(String(query?.f || '')) } catch { return { statusCode: 403, body: 'This link has expired.' } }
  if (p?.typ !== 'photo') return { statusCode: 403, body: 'Not a photo link.' }
  const rec = await store().getKey(...recordKey(p.id))
  if (!rec || !(await require('../core/demoSession').getActiveSession(rec.sid))) return { statusCode: 410, body: 'This photo is gone: its demo session ended.' }
  if (rec.key) {
    const url = await require('./s3').signedGetUrl(rec.key, { contentType: rec.mimeType, disposition: 'inline', expiresIn: 300 })
    return { statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, body: '' }
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': rec.mimeType, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' },
    body: rec.data,
    isBase64Encoded: true
  }
}

/** Delete a session's photos (end of session). */
async function forget(session) {
  for (const id of Array.isArray(session?.photos) ? session.photos : []) {
    const rec = await store().getKey(...recordKey(id)).catch(() => null)
    if (rec?.key && onAws()) await require('./s3').deleteFile(rec.key).catch(() => {})
    await store().deleteKey(...recordKey(id)).catch(() => {})
  }
}

module.exports = { save, owned, link, serve, forget, MAX_PER_SESSION }
