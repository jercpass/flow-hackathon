// @ts-check
'use strict'

// ─── Pending UPI payments ──────────────────────────────────────────────────────
// Durable store for the "awaiting payment" state. When core/paymentFlow.js
// creates a Cashfree order, the booking intent (which service, slot, customer)
// is saved here keyed by orderId. When the Cashfree webhook fires, the handler
// looks up and atomically consumes this record to confirm the booking.
// DynamoDB (not Redis) because webhooks can arrive minutes after the link was
// sent, and the record must survive a cache eviction.

const { db, TABLES, PutCommand, GetCommand, DeleteCommand } = require('./client')

const TTL_HOURS = 48   // unconfirmed requests older than this are considered abandoned

async function savePendingPayment(referenceId, intent) {
  const ttl = Math.floor(Date.now() / 1000) + TTL_HOURS * 3600
  // The key is the provider's order id (what PayPal sends back). An intent's own
  // `referenceId` (Flow's internal checkout reference) must not overwrite it,
  // or the buyer's return can't find the checkout: it's kept as checkoutRef.
  const { referenceId: checkoutRef, ...rest } = intent || {}
  await db.send(new PutCommand({
    TableName: TABLES.PENDING_PAYMENTS,
    Item: { ...rest, ...(checkoutRef ? { checkoutRef } : {}), referenceId, ttl }
  }))
}

async function getPendingPayment(referenceId) {
  const { Item } = await db.send(new GetCommand({
    TableName: TABLES.PENDING_PAYMENTS,
    Key: { referenceId }
  }))
  return Item || null
}

/**
 * Atomically consume a pending payment so a double-tap on the owner's confirm
 * link (or a retried request) can't confirm the same booking twice.
 */
async function consumePendingPayment(referenceId) {
  try {
    const result = await db.send(new DeleteCommand({
      TableName:    TABLES.PENDING_PAYMENTS,
      Key:          { referenceId },
      ConditionExpression: 'attribute_exists(referenceId)',
      ReturnValues: 'ALL_OLD'
    }))
    return result.Attributes || null
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return null
    throw err
  }
}

module.exports = { savePendingPayment, getPendingPayment, consumePendingPayment }
