'use strict'

const edition = require('../config/edition')
const { getTools } = require('../services/tools')
const { currencyOf } = require('../utils/money')

afterEach(() => { delete process.env.EDITION; delete process.env.DEFAULT_CURRENCY })

test('defaults to the global (Flow) edition', () => {
  expect(edition.edition()).toBe('global')
  expect(edition.editionDefaults()).toMatchObject({ currency: 'USD', brand: 'Flow' })
  expect(edition.isEnabled('paypal')).toBe(true)
})

test('unknown edition falls back to global; unknown feature throws', () => {
  process.env.EDITION = 'mars'
  expect(edition.edition()).toBe('global')
  expect(() => edition.isEnabled('teleport')).toThrow('unknown feature')
})

test('currency: business setting, else edition default', () => {
  expect(currencyOf({ config: {} })).toBe('USD')
  expect(currencyOf({ config: { currency: 'eur' } })).toBe('EUR')
})

test('publicConfig lists every feature as a boolean', () => {
  const c = edition.publicConfig()
  expect(c.edition).toBe('global')
  expect(Object.keys(c.features).sort()).toEqual(Object.keys(edition.FEATURES).sort())
  expect(Object.values(c.features).every(v => typeof v === 'boolean')).toBe(true)
})

test('opening hours are read in the business timezone, not the server clock', () => {
  const { generateCandidateSlots } = require('../core/slots')
  const { toUtcIso, fmtLocal } = require('../utils/time')
  const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
  const slots = generateCandidateSlots({ durationMode: 'fixed', duration: 60 },
    { open: '09:00', close: '18:00', workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], minNoticeHours: 0, advanceDays: 30 }, date, 'America/Chicago')
  expect(slots).toHaveLength(9)
  expect(fmtLocal(slots[0].start, 'America/Chicago')).toMatch(/9 AM$/)
  expect(fmtLocal(slots[8].start, 'America/Chicago')).toMatch(/5 PM$/)
  // a local time from the AI maps onto the same UTC instant as the slot grid
  expect(toUtcIso(`${date}T09:00`, 'America/Chicago')).toBe(slots[0].start)
  expect(toUtcIso(slots[0].start, 'America/Chicago')).toBe(slots[0].start)
})
