// @ts-check
'use strict'

const { db, TABLES, PutCommand, QueryCommand, DeleteCommand } = require('./client')

// Each chunk item carries a ~26KB embedding (1536 floats as JSON), so a single
// Query page (1MB cap) holds only ~38 chunks. Without paging, a knowledge base
// bigger than that silently loses chunks from search, dedup, and delete. This
// loops until every page is drained.
async function queryAll(params) {
  const items = []
  let ExclusiveStartKey
  do {
    const res = await db.send(new QueryCommand({ ...params, ExclusiveStartKey }))
    items.push(...(res.Items || []))
    ExclusiveStartKey = res.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return items
}

async function saveChunk(chunk) {
  await db.send(new PutCommand({
    TableName: TABLES.KNOWLEDGE_CHUNKS,
    Item: { ...chunk, createdAt: new Date().toISOString() }
  }))
}

async function getChunksForBusiness(businessId) {
  return queryAll({
    TableName:              TABLES.KNOWLEDGE_CHUNKS,
    KeyConditionExpression: 'businessId = :bid',
    ExpressionAttributeValues: { ':bid': businessId }
  })
}

async function getChunksBySourceHash(businessId, sourceHash) {
  return queryAll({
    TableName:              TABLES.KNOWLEDGE_CHUNKS,
    KeyConditionExpression: 'businessId = :bid',
    FilterExpression:       'sourceHash = :hash',
    ExpressionAttributeValues: { ':bid': businessId, ':hash': sourceHash }
  })
}

async function deleteChunk(businessId, chunkId) {
  await db.send(new DeleteCommand({
    TableName: TABLES.KNOWLEDGE_CHUNKS,
    Key: { businessId, chunkId }
  }))
}

async function deleteAllChunksForBusiness(businessId) {
  const chunks = await getChunksForBusiness(businessId)
  for (const chunk of chunks) {
    await deleteChunk(businessId, chunk.chunkId)
  }
  return chunks.length
}

module.exports = { saveChunk, getChunksForBusiness, getChunksBySourceHash, deleteChunk, deleteAllChunksForBusiness }
