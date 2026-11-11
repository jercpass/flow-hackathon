// @ts-check
'use strict'

// ─── Bookable unit logic ──────────────────────────────────────────────────────
// Brief section E: "Never double-book — each unit has its own timeline."
// v1 ships person, resource, queue (group_spot lands in v1.5 per the roadmap).
//
// unitId meaning by unit_type:
//   person   -> staff_id (business.config.staff[i].staffId)
//   resource -> resource_id (business.config.resources[i].resourceId)
//   queue    -> service_id itself — there's no individual instance, just a counter

const dayjs = require('dayjs')
const { getAppointmentsForUnit } = require('../services/dynamo/appointments')

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * Does a staff member actually WORK during this slot? Checks their personal
 * schedule (workingDays / open / close / break). If a staff member has no
 * `availability` set, they fall back to "available whenever the business is open"
 * (the slot grid already enforces business hours), preserving old behaviour.
 */
function staffWorksAt(member, startIso, endIso, tz) {
  const av = member.availability
  if (!av) return true

  // Shift times are local to the business, so work out the local date/weekday.
  const { localDate, atLocal } = require('../utils/time')
  const date = localDate(startIso, tz)
  const day = DAY_KEYS[dayjs(date).day()]
  if (av.workingDays && !av.workingDays.includes(day)) return false

  const sStart = dayjs(startIso)
  const sEnd = dayjs(endIso)
  if (av.open && sStart.isBefore(atLocal(date, av.open, tz))) return false
  if (av.close && sEnd.isAfter(atLocal(date, av.close, tz))) return false
  if (av.break) {
    const bStart = atLocal(date, av.break.start, tz)
    const bEnd = atLocal(date, av.break.end, tz)
    if (sStart.isBefore(bEnd) && bStart.isBefore(sEnd)) return false   // overlaps the break
  }
  return true
}

/**
 * Find which unit instances (staff/resources) are free for a candidate slot.
 * For person services a unit must BOTH be on shift (staffWorksAt) AND have no
 * booking conflict. Returns the list of free unitIds.
 *
 * dayCache: pass the same Map for every slot of one availability check, so each
 * unit's bookings for the day are read once, not once per slot (a day has ~20
 * slots: that was 20× the same query per staff member, 1.5–2 s per check).
 * Without it (the check right before a booking) the read is always fresh.
 */
async function getFreeUnitsForSlot(business, service, startIso, endIso, dayCache = null) {
  if (service.unitType === 'queue') return [service.serviceId]
  const bookingsOf = unitId => {
    const read = () => getAppointmentsForUnit(business.businessId, unitId, dayStart(startIso), dayEnd(startIso))
    if (!dayCache) return read()
    const key = `${unitId}|${dayStart(startIso)}`
    if (!dayCache.has(key)) dayCache.set(key, read())
    return dayCache.get(key)
  }

  if (service.unitType === 'person') {
    const staff = (business.config.staff || []).filter(s => s.services?.includes(service.serviceId))
    const free = []
    for (const member of staff) {
      if (!staffWorksAt(member, startIso, endIso, business.timezone)) continue
      const conflicts = await bookingsOf(member.staffId)
      if (!conflicts.some(a => overlapsRange(a.startTime, a.endTime, startIso, endIso))) free.push(member.staffId)
    }
    return free
  }

  const candidates = resolveUnitCandidates(business, service)
  const free = []
  for (const unitId of candidates) {
    const conflicts = await bookingsOf(unitId)
    const overlaps = conflicts.some(a => overlapsRange(a.startTime, a.endTime, startIso, endIso))
    if (!overlaps) free.push(unitId)
  }
  return free
}

function resolveUnitCandidates(business, service) {
  if (service.unitType === 'person') {
    return (business.config.staff || [])
      .filter(s => s.services?.includes(service.serviceId))
      .map(s => s.staffId)
  }
  if (service.unitType === 'resource') {
    return service.resources?.length
      ? service.resources
      : (business.config.resources || []).map(r => r.resourceId)
  }
  if (service.unitType === 'queue') return [service.serviceId]
  return []   // group_spot — v1.5
}

/**
 * Next sequential token for a queue-type service, plus live position/ETA.
 * Position is just count of active (non-cancelled, non-completed) tokens today.
 */
async function getNextQueueToken(business, service) {
  const todayStart = dayjs().startOf('day').toISOString()
  const todayEnd   = dayjs().endOf('day').toISOString()
  const today = await getAppointmentsForUnit(business.businessId, service.serviceId, todayStart, todayEnd)
  const active = today.filter(a => a.status !== 'completed')

  const tokenNumber = today.length + 1
  const position     = active.length + 1
  const avgServiceMinutes = service.duration || 15
  const etaMinutes   = active.length * avgServiceMinutes

  return { tokenNumber, position, etaMinutes }
}

// A service's price for a specific staff member. A senior stylist can cost more:
// staff.priceOverrides = { [serviceId]: price }. Returns the service unchanged when
// there's no override, or a shallow copy with the overridden price. deposit_percent
// and full_prepaid then bill off the override; deposit_fixed is unaffected (the
// deposit is fixed regardless of who does the service).
function priceForUnit(service, business, unitId) {
  if (!unitId) return service
  const staff = (business.config.staff || []).find(s => s.staffId === unitId)
  const ov = staff?.priceOverrides?.[service.serviceId]
  const n = Number(ov)
  if (ov == null || !Number.isFinite(n)) return service
  return { ...service, price: n }
}

function overlapsRange(aStart, aEnd, bStart, bEnd) {
  return dayjs(aStart).isBefore(bEnd) && dayjs(bStart).isBefore(aEnd)
}

function dayStart(iso) { return dayjs(iso).startOf('day').toISOString() }
function dayEnd(iso)   { return dayjs(iso).endOf('day').toISOString() }

module.exports = { getFreeUnitsForSlot, resolveUnitCandidates, getNextQueueToken, staffWorksAt, priceForUnit }
