// @ts-check
'use strict'

// ─── Shared DynamoDB client + table map ───────────────────────────────────────
// Imported by every domain module so the SDK is initialised exactly once.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb')

const client = new DynamoDBClient({ region: process.env.AWS_REGION })
const db = DynamoDBDocumentClient.from(client)

const TABLES = {
  BUSINESSES:          process.env.DYNAMO_BUSINESSES,
  CUSTOMERS:           process.env.DYNAMO_CUSTOMERS,
  APPOINTMENTS:        process.env.DYNAMO_APPOINTMENTS,
  // Partition key is conversation_id (NOT business_id alone) — a single business_id
  // partition would get hot under load. See processedMessages.js for key shape.
  PROCESSED_MESSAGES:  process.env.DYNAMO_PROCESSED_MESSAGES,
  OAUTH_STATES:        process.env.DYNAMO_OAUTH_STATES,
  PENDING_PAYMENTS:    process.env.DYNAMO_PENDING_PAYMENTS,
  KNOWLEDGE_CHUNKS:    process.env.DYNAMO_KNOWLEDGE_CHUNKS,
  // Canonical invoice records — our own copy of every invoice rendered by the
  // billing provider (Zoho/Odoo). The provider is the renderer; this is the record.
  INVOICES:            process.env.DYNAMO_INVOICES,
  // Per-session "Under the hood" timeline (services/trace.js)
  TRACE_EVENTS:        process.env.DYNAMO_TRACE_EVENTS
}

module.exports = {
  db,
  TABLES,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand
}
