'use strict'

// One availability check reads each staff member's bookings for the day once,
// not once per slot (it was ~20 identical database reads per person, 1.5–2 s
// per check). The free times are the same either way, and a single-slot check
// (right before booking) still reads fresh.

jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForUnit: jest.fn() }))

const { getAppointmentsForUnit } = require('../services/dynamo/appointments')
const { getAvailability } = require('../core/engine')
const { getFreeUnitsForSlot } = require('../core/units')

const business = {
  businessId: 'B1', timezone: 'America/Chicago',
  config: {
    availability: { workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], open: '09:00', close: '18:00', minNoticeHours: 0, advanceDays: 3650 },
    services: [{ serviceId: 'cut', name: 'Haircut', unitType: 'person', durationMode: 'fixed', duration: 60, price: 40, active: true }],
    staff: [{ staffId: 'ana', name: 'Ana', services: ['cut'] }, { staffId: 'ben', name: 'Ben', services: ['cut'] }]
  }
}
// Ana is booked 3–4 PM local (CDT = UTC−5) on Saturday 2030-06-01.
const anaBooked = [{ startTime: '2030-06-01T20:00:00.000Z', endTime: '2030-06-01T21:00:00.000Z' }]

beforeEach(() => {
  getAppointmentsForUnit.mockReset()
  getAppointmentsForUnit.mockImplementation(async (bid, unitId) => (unitId === 'ana' ? anaBooked : []))
})

test('one read per staff member for the whole day, same free times', async () => {
  const slots = await getAvailability(business, 'cut', '2030-06-01')
  expect(slots.length).toBeGreaterThan(5)
  // Never the same read twice (the day range depends on the machine's time zone, so
  // count distinct reads rather than a fixed number), and far fewer than slots × staff.
  const reads = getAppointmentsForUnit.mock.calls.map(c => c.slice(1).join('|'))
  expect(new Set(reads).size).toBe(reads.length)
  expect(reads.length).toBeLessThanOrEqual(4)
  expect(slots.length * 2).toBeGreaterThan(reads.length * 3)
  expect([...new Set(getAppointmentsForUnit.mock.calls.map(c => c[1]))].sort()).toEqual(['ana', 'ben'])
  // 3 PM: only Ben is free; 10 AM: both.
  const at = iso => slots.find(s => s.start === iso)
  expect(at('2030-06-01T20:00:00.000Z')?.freeUnitCount).toBe(1)
  expect(at('2030-06-01T15:00:00.000Z')?.freeUnitCount).toBe(2)
  // Asking for Ana only: 3 PM is gone.
  getAppointmentsForUnit.mockClear()
  const ana = await getAvailability(business, 'cut', '2030-06-01', 'ana')
  expect(ana.find(s => s.start === '2030-06-01T20:00:00.000Z')).toBeUndefined()
})

test('the check right before a booking reads fresh every time', async () => {
  const cut = business.config.services[0]
  await getFreeUnitsForSlot(business, cut, '2030-06-01T20:00:00.000Z', '2030-06-01T21:00:00.000Z')
  await getFreeUnitsForSlot(business, cut, '2030-06-01T20:00:00.000Z', '2030-06-01T21:00:00.000Z')
  expect(getAppointmentsForUnit).toHaveBeenCalledTimes(4)
})
