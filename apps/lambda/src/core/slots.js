// @ts-check
'use strict'

// ─── Slot generation ──────────────────────────────────────────────────────────
// Turns a service's availability rules + duration into candidate start times for
// one date. This is unit-agnostic — it answers "when could a slot start", not
// "is a specific unit free then" (that's units.js). Engine.js combines both.

const { dayjs, atLocal } = require('../utils/time')

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * @param {object} service     - business.config.services[i]
 * @param {object} availability - business.config.availability
 * @param {string} dateIso     - "2026-06-20" (a calendar date in the business's timezone)
 * @param {string} [tz]        - business timezone (IANA); hours are local to it
 * @returns {{start: string, end: string}[]} candidate slots, UTC ISO start/end
 */
function generateCandidateSlots(service, availability, dateIso, tz) {
  const dow = DAY_KEYS[dayjs(dateIso).day()]
  if (!availability.workingDays?.includes(dow)) return []
  if (availability.holidays?.includes(dateIso)) return []

  const duration = resolveDurationMinutes(service)
  if (!duration) return []   // variable/session duration needs a follow-up question, not slot generation

  const dayStart = atLocal(dateIso, availability.open, tz)
  const dayEnd   = atLocal(dateIso, availability.close, tz)
  const breakStart = availability.break ? atLocal(dateIso, availability.break.start, tz) : null
  const breakEnd   = availability.break ? atLocal(dateIso, availability.break.end, tz)   : null

  const slots = []
  let cursor = dayStart
  const stepMinutes = duration + (service.bufferAfterMins || 0)

  while (cursor.add(duration, 'minute').isSameOrBefore(dayEnd)) {
    const slotEnd = cursor.add(duration, 'minute')
    const overlapsBreak = breakStart && cursor.isBefore(breakEnd) && slotEnd.isAfter(breakStart)

    if (!overlapsBreak) {
      slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() })
    }
    cursor = cursor.add(stepMinutes, 'minute')
  }

  return applyAdvanceWindow(slots, availability)
}

function resolveDurationMinutes(service) {
  if (service.durationMode === 'fixed' || service.durationMode === 'session') return service.duration
  if (service.durationMode === 'recurring') return service.duration || 60
  return null   // 'variable' — caller (AI) must ask the customer, no fixed grid
}

function applyAdvanceWindow(slots, availability) {
  const now      = dayjs()
  const minNotice = now.add(availability.minNoticeHours || 0, 'hour')
  const maxAdvance = now.add(availability.advanceDays || 30, 'day')

  return slots.filter(s => {
    const start = dayjs(s.start)
    return start.isAfter(minNotice) && start.isBefore(maxAdvance)
  })
}

module.exports = { generateCandidateSlots, resolveDurationMinutes }
