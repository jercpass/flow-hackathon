// @ts-check
'use strict'

// ─── Processed messages domain ────────────────────────────────────────────────
// Day-one must-have #1: webhook idempotency. Meta retries undelivered webhooks,
// so every inbound message_id must be checked-before-process and stored with a
// 24h TTL. message_id PK is already high-cardinality/random — no hot-partition
// risk despite being a single-attribute key (unlike businessId, which would need
// a sort key — see appointments.js).
//
// Redis (redis.hasSeenMessage/markMessageSeen) is the fast first check; this
// table is the durable fallback so a Redis outage can't cause double-processing.

const { db, TABLES, GetCommand, PutCommand } = require('./client')

const TTL_SECONDS = 24 * 60 * 60

async function hasProcessed(messageId) {
  const { Item } = await db.send(new GetCommand({
    TableName: TABLES.PROCESSED_MESSAGES,
    Key: { messageId }
  }))
  return !!Item
}

async function markProcessed(messageId) {
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS
  await db.send(new PutCommand({
    TableName: TABLES.PROCESSED_MESSAGES,
    Item: { messageId, ttl }
  }))
}

// Small durable key → result records on the same table (e.g. the outcome of a
// PayPal order, so the return page and a late webhook show the same answer).
async function saveResult(messageId, result, ttlSeconds = 7 * 24 * 60 * 60) {
  await db.send(new PutCommand({
    TableName: TABLES.PROCESSED_MESSAGES,
    Item: { messageId, result, ttl: Math.floor(Date.now() / 1000) + ttlSeconds }
  }))
}

async function getResult(messageId) {
  const { Item } = await db.send(new GetCommand({
    TableName: TABLES.PROCESSED_MESSAGES,
    Key: { messageId }
  }))
  return Item?.result || null
}

module.exports = { hasProcessed, markProcessed, saveResult, getResult }
