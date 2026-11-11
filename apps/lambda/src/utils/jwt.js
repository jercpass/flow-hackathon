'use strict'

const crypto = require('crypto')

const SECRET = process.env.FLOW_LINK_SECRET

function createToken(payload, expiresInSeconds = 604800) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds
  })).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

function verifyToken(token) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('invalid token format')
  const [header, body, sig] = parts
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url')
  if (sig !== expected) throw new Error('invalid signature')
  const payload = JSON.parse(Buffer.from(body, 'base64url'))
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('token expired')
  return payload
}

function extractAuth(event) {
  const authHeader = event.headers?.Authorization || event.headers?.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  try { return verifyToken(authHeader.slice(7)) }
  catch { return null }
}

module.exports = { createToken, verifyToken, extractAuth }
