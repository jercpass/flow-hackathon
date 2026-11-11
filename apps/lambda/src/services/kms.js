'use strict'

const { KMSClient, EncryptCommand, DecryptCommand } = require('@aws-sdk/client-kms')
const crypto = require('crypto')
const redis  = require('./redis')

const client = new KMSClient({ region: process.env.AWS_REGION })
const KEY_ID = process.env.KMS_KEY_ID

// KMS decrypt is ~100-200ms per call. A booking conversation can trigger several
// decrypts (whatsapp token, provider sync tokens). Cache the result
// per ciphertext in Redis so every warm Lambda instance shares the cache, not just
// the one that decrypted it first.
//
// TTL: 5 min — short enough that key rotation takes effect within one cache window.
// Secrets never leave Lambda memory/Redis and are never written to logs or responses.

const CACHE_TTL_SECONDS = 5 * 60

function _hash(ciphertext) {
  return crypto.createHash('sha256').update(ciphertext).digest('hex')
}

async function encrypt(plaintext) {
  const { CiphertextBlob } = await client.send(new EncryptCommand({
    KeyId:     KEY_ID,
    Plaintext: Buffer.from(plaintext, 'utf8')
  }))
  return Buffer.from(CiphertextBlob).toString('base64')
}

async function decrypt(ciphertext) {
  const cacheKey = _hash(ciphertext)
  const cached    = await redis.getKmsCache(cacheKey)
  if (cached) return cached

  const { Plaintext } = await client.send(new DecryptCommand({
    CiphertextBlob: Buffer.from(ciphertext, 'base64')
  }))
  const plaintext = Buffer.from(Plaintext).toString('utf8')

  await redis.setKmsCache(cacheKey, plaintext, CACHE_TTL_SECONDS)
  return plaintext
}

module.exports = { encrypt, decrypt }
