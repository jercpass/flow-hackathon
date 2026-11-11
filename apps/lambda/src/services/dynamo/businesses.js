// @ts-check
'use strict'

// ─── Businesses domain ────────────────────────────────────────────────────────
// CRUD for the BUSINESSES table. Schema per dev brief section C — business_id is PK,
// the whole engine config (services, staff, availability, ai_config, etc.) lives in
// a single `config` map so reads are one GetItem regardless of catalogue size.

const { db, TABLES, GetCommand, PutCommand, UpdateCommand, ScanCommand, DeleteCommand } = require('./client')
const redis = require('../redis')

async function getBusiness(businessId) {
  const cached = await redis.getCachedBusiness(businessId)
  if (cached) return cached

  const { Item } = await db.send(new GetCommand({
    TableName: TABLES.BUSINESSES,
    Key: { businessId }
  }))
  if (Item) await redis.setCachedBusiness(businessId, Item)
  return Item || null
}

async function saveBusiness(business) {
  await db.send(new PutCommand({
    TableName: TABLES.BUSINESSES,
    Item: {
      ...business,
      whatsappPhoneId: business.channels?.whatsapp_phone_id,
      createdAt: new Date().toISOString()
    }
  }))
  await redis.invalidateBusiness(business.businessId)
}

async function updateBusiness(businessId, updates) {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined)
  if (!entries.length) return

  const nameMap  = {}
  const valueMap = {}
  entries.forEach(([k, v], i) => { nameMap[`#k${i}`] = k; valueMap[`:v${i}`] = v })

  await db.send(new UpdateCommand({
    TableName:        TABLES.BUSINESSES,
    Key:              { businessId },
    UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames:  nameMap,
    ExpressionAttributeValues: valueMap
  }))
  await redis.invalidateBusiness(businessId)
}

async function getAllBusinesses() {
  const { Items } = await db.send(new ScanCommand({ TableName: TABLES.BUSINESSES }))
  return Items || []
}

// Hard delete — used only to wipe a demo session's data when it ends.
async function deleteBusiness(businessId) {
  await db.send(new DeleteCommand({ TableName: TABLES.BUSINESSES, Key: { businessId } }))
  await redis.invalidateBusiness(businessId)
}

module.exports = {
  deleteBusiness,
  getBusiness, saveBusiness, updateBusiness, getAllBusinesses
}
