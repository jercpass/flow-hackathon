'use strict'

// One time format everywhere (tool messages, inbox, what the AI is told to write):
// "3 PM", "10:30 AM": minutes only when they aren't :00.

const { fmtLocal } = require('../utils/time')
const { buildSystemPrompt } = require('../services/aiRouter')

const TZ = 'America/Chicago'

test('on the hour: no :00', () => {
  expect(fmtLocal('2026-10-26T20:00:00.000Z', TZ)).toBe('Mon, Oct 26, 3 PM')
  expect(fmtLocal('2026-10-26T14:00:00.000Z', TZ)).toBe('Mon, Oct 26, 9 AM')
})

test('past the hour: the minutes stay', () => {
  expect(fmtLocal('2026-10-26T15:30:00.000Z', TZ)).toBe('Mon, Oct 26, 10:30 AM')
})

test('the business assistant is told the same format', () => {
  const business = { name: 'Willow', type: 'salon', timezone: TZ, config: { services: [], policies: {}, availability: {} } }
  expect(buildSystemPrompt(business, [])).toMatch(/Write times as 9 AM, 2 PM, 10:30 AM/)
})

test('booking messages and receipts use it too (and India keeps its own)', () => {
  const { formatIST } = require('../utils/receipt')
  expect(formatIST('2026-10-28T14:00:00Z', TZ)).toBe('Oct 28, 2026, 9 AM')
  expect(formatIST('2026-10-28T15:30:00Z', TZ)).toBe('Oct 28, 2026, 10:30 AM')
  expect(formatIST('2026-10-28T09:00:00Z')).toMatch(/^28 Oct 2026, 02:30 pm$/i)
})
