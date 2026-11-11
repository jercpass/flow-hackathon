// @ts-check
'use strict'

// ─── OAuth CSRF state tokens ───────────────────────────────────────────────────
// Single-use, short-TTL CSRF tokens for OAuth callbacks. Ties a redirect back
// to the business that initiated it without putting businessId in the URL.
// Atomic delete-with-condition so a replayed callback (browser back button,
// retried request) gets null instead of a second grant.

const { db, TABLES, PutCommand, DeleteCommand } = require('./client')

async function saveOAuthState(state, businessId, ttlSeconds) {
  const ttl = Math.floor(Date.now() / 1000) + ttlSeconds
  await db.send(new PutCommand({
    TableName: TABLES.OAUTH_STATES,
    Item: { state, businessId, ttl }
  }))
}

/**
 * Atomically consume a state token. Returns the businessId it was issued for,
 * or null if it's missing, expired, or already consumed.
 */
async function consumeOAuthState(state) {
  const now = Math.floor(Date.now() / 1000)
  try {
    const result = await db.send(new DeleteCommand({
      TableName:                 TABLES.OAUTH_STATES,
      Key:                       { state },
      ConditionExpression:       '#ttl > :now',
      ExpressionAttributeNames:  { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': now },
      ReturnValues:              'ALL_OLD'
    }))
    return result.Attributes?.businessId || null
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return null
    throw err
  }
}

module.exports = { saveOAuthState, consumeOAuthState }
