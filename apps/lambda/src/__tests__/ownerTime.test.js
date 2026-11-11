'use strict'

// Owner-entered times (walk-ins, blocked time) are the salon's wall clock: a time
// without a zone is read in the business's time zone, never the server's.

const { _ownerTime } = require('../handlers/dashboardApi')
const austin = { timezone: 'America/Chicago' }

test('11:00 typed for an Austin salon is 11:00 in Austin (CDT, UTC-5)', () => {
  expect(_ownerTime('2026-10-17T11:00:00', austin)).toBe('2026-10-17T16:00:00.000Z')
  expect(_ownerTime('2026-10-17T11:00', austin)).toBe('2026-10-17T16:00:00.000Z')
})

test('a time that already carries a zone is kept; junk is refused', () => {
  expect(_ownerTime('2026-10-17T10:00:00-05:00', austin)).toBe('2026-10-17T15:00:00.000Z')
  expect(_ownerTime('2026-10-17T15:00:00Z', austin)).toBe('2026-10-17T15:00:00.000Z')
  expect(_ownerTime('', austin)).toBeNull()
  expect(_ownerTime('not a time', austin)).toBeNull()
})
