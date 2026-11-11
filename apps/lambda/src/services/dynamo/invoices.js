// @ts-check
'use strict'

// ─── Canonical invoice records ───────────────────────────────────────────────
// Our OWN copy of every invoice rendered by the billing provider (Zoho now,
// Odoo later). The provider renders the compliant PDF; this table is the record
// of truth we control — so we're never locked into a provider and can always
// re-fetch, reconcile, or migrate. Key: businessId (HASH) + invoiceId (RANGE).
// invoiceId is deterministic for recurring invoices (e.g. `sub_2026-07`), so a
// retried billing run can't create a duplicate.

const { db, TABLES, PutCommand, GetCommand, QueryCommand } = require('./client')

// Idempotent create — a retry for the same {businessId, invoiceId} is a no-op.
async function putInvoice(invoice) {
  try {
    await db.send(new PutCommand({
      TableName: TABLES.INVOICES,
      Item: invoice,
      ConditionExpression: 'attribute_not_exists(businessId) AND attribute_not_exists(invoiceId)'
    }))
    return { created: true }
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return { created: false, duplicate: true }
    throw err
  }
}

async function getInvoice(businessId, invoiceId) {
  const { Item } = await db.send(new GetCommand({
    TableName: TABLES.INVOICES,
    Key: { businessId, invoiceId }
  }))
  return Item || null
}

async function listInvoices(businessId) {
  const { Items } = await db.send(new QueryCommand({
    TableName: TABLES.INVOICES,
    KeyConditionExpression: 'businessId = :b',
    ExpressionAttributeValues: { ':b': businessId }
  }))
  return Items || []
}

module.exports = { putInvoice, getInvoice, listInvoices }
