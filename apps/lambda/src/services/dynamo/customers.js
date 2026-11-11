// @ts-check
'use strict'

// ─── Customers domain ─────────────────────────────────────────────────────────
// customer_id (PK). Looked up by (businessId, phone) on every inbound webhook,
// so that pair needs a GSI — a customer is scoped to one business in v1.

const { db, TABLES, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } = require('./client')
const redis = require('../redis')

async function getCustomer(customerId) {
  const cached = await redis.getCachedCustomer(customerId)
  if (cached) return cached

  const { Item } = await db.send(new GetCommand({
    TableName: TABLES.CUSTOMERS,
    Key: { customerId }
  }))
  if (Item) await redis.setCachedCustomer(customerId, Item)
  return Item || null
}

async function getCustomerByPhone(businessId, phone) {
  const { Items } = await db.send(new QueryCommand({
    TableName:              TABLES.CUSTOMERS,
    IndexName:              'business-phone-index',
    KeyConditionExpression: 'businessId = :businessId AND phone = :phone',
    ExpressionAttributeValues: { ':businessId': businessId, ':phone': phone }
  }))
  return Items?.[0] || null
}

async function saveCustomer(customer) {
  await db.send(new PutCommand({
    TableName: TABLES.CUSTOMERS,
    Item: { ...customer, createdAt: new Date().toISOString() }
  }))
}

async function updateCustomer(customerId, updates) {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined)
  if (!entries.length) return

  const nameMap  = {}
  const valueMap = {}
  entries.forEach(([k, v], i) => { nameMap[`#k${i}`] = k; valueMap[`:v${i}`] = v })

  await db.send(new UpdateCommand({
    TableName:        TABLES.CUSTOMERS,
    Key:              { customerId },
    UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames:  nameMap,
    ExpressionAttributeValues: valueMap
  }))
  await redis.invalidateCustomer(customerId)
}

// Hard delete — used only to wipe a demo session's data when it ends.
async function deleteCustomer(customerId) {
  await db.send(new DeleteCommand({ TableName: TABLES.CUSTOMERS, Key: { customerId } }))
  await redis.invalidateCustomer(customerId)
}

module.exports = { getCustomer, getCustomerByPhone, saveCustomer, updateCustomer, deleteCustomer }
