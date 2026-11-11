// @ts-check
'use strict'

// ─── Appointments domain ──────────────────────────────────────────────────────
// Partition key is businessId, sort key is `${startTime}#${appointmentId}` —
// NOT startTime alone. Two different units (two staff, two resources) can have
// appointments starting at the exact same minute for the same business; a bare
// startTime sort key would collide and overwrite one of them. Appending the
// appointmentId keeps every item unique while staying range-queryable: ISO
// timestamps compare correctly char-by-char regardless of what's appended
// after them, as long as range queries treat the upper bound as exclusive of
// anything with a longer matching prefix (see the toIso + '~' trick below —
// '~' sorts after every digit/letter/'#' in ASCII, so it safely captures any
// suffixed key exactly at the boundary).
//
// Day-one must-have #2 (payment idempotency): paymentId carries a unique
// constraint via ConditionExpression on create, so a webhook retry that fires
// createAppointment twice for the same payment can never double-book or
// double-charge — the second attempt fails the condition and is treated as
// "already booked" by the caller.

const { db, TABLES, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } = require('./client')

function sortKey(startTime, appointmentId) {
  return `${startTime}#${appointmentId}`
}

function upperBound(toIso) {
  return `${toIso}~`   // '~' (0x7E) sorts after any char a real suffix would use
}

async function createAppointment(appointment) {
  try {
    await db.send(new PutCommand({
      TableName:           TABLES.APPOINTMENTS,
      Item: {
        ...appointment,
        sortKey:   sortKey(appointment.startTime, appointment.appointmentId),
        createdAt: new Date().toISOString()
      },
      ConditionExpression: 'attribute_not_exists(paymentId) OR paymentId = :empty',
      ExpressionAttributeValues: { ':empty': null }
    }))
    return { created: true }
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return { created: false, duplicate: true }
    throw err
  }
}

// Conflict check for a single bookable unit (person/resource/group_spot/queue).
// Engine logic (core/engine.js) calls this per-unit before confirming a slot —
// see brief section E: "each unit has its own timeline."
async function getAppointmentsForUnit(businessId, unitId, fromIso, toIso) {
  const { Items } = await db.send(new QueryCommand({
    TableName:              TABLES.APPOINTMENTS,
    KeyConditionExpression: 'businessId = :businessId AND sortKey BETWEEN :from AND :to',
    FilterExpression:       'unitId = :unitId AND #status <> :cancelled',
    ExpressionAttributeNames:  { '#status': 'status' },
    ExpressionAttributeValues: {
      ':businessId': businessId,
      ':from':       fromIso,
      ':to':         upperBound(toIso),
      ':unitId':     unitId,
      ':cancelled':  'cancelled'
    }
  }))
  return Items || []
}

// All appointments for a business in a date range, any unit — used by the
// monthly platform-fee billing job (handlers/billing.js) to sum up accrued
// fees, and by the weekly owner report.
async function getAppointmentsForBusiness(businessId, fromIso, toIso) {
  const { Items } = await db.send(new QueryCommand({
    TableName:              TABLES.APPOINTMENTS,
    KeyConditionExpression: 'businessId = :businessId AND sortKey BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':businessId': businessId,
      ':from':       fromIso,
      ':to':         upperBound(toIso)
    }
  }))
  return Items || []
}

async function updateAppointment(businessId, startTime, appointmentId, updates) {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined)
  if (!entries.length) return

  const nameMap  = {}
  const valueMap = {}
  entries.forEach(([k, v], i) => { nameMap[`#k${i}`] = k; valueMap[`:v${i}`] = v })

  await db.send(new UpdateCommand({
    TableName:        TABLES.APPOINTMENTS,
    Key:              { businessId, sortKey: sortKey(startTime, appointmentId) },
    UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames:  nameMap,
    ExpressionAttributeValues: valueMap
  }))
}

// Hard delete — used only to wipe a demo session's data when it ends.
async function deleteAppointment(businessId, startTime, appointmentId) {
  await db.send(new DeleteCommand({ TableName: TABLES.APPOINTMENTS, Key: { businessId, sortKey: sortKey(startTime, appointmentId) } }))
}

module.exports = { createAppointment, getAppointmentsForUnit, getAppointmentsForBusiness, updateAppointment, deleteAppointment }
