'use strict'

// Other customers' bookings for a fresh demo (demo/seedBookings): the owner side
// doesn't open empty, and made-up money never pretends PayPal moved it.

jest.mock('../services/dynamo/appointments', () => ({ createAppointment: jest.fn().mockResolvedValue({ created: true }) }))

const { createAppointment } = require('../services/dynamo/appointments')
const { seedOthers } = require('../demo/seedBookings')
const { CATALOG } = require('../demo/templates')
const { dayjs } = require('../utils/time')

const willow = { ...CATALOG[0].build(), businessId: 'biz-w' }   // open 9–6 every day
// Wednesday noon in Austin: two bookings this morning are already over.
const NOW = dayjs.tz('2026-10-21 12:00', 'America/Chicago').valueOf()

beforeEach(() => { jest.clearAllMocks() })

test('a fresh demo gets other customers on real days and hours: past, today and the next days', async () => {
  const n = await seedOthers(willow, { sid: 's1', now: NOW })
  const rows = createAppointment.mock.calls.map(c => c[0])
  expect(n).toBe(rows.length)
  expect(rows.length).toBeGreaterThanOrEqual(6)
  expect(rows.every(r => r.seeded && r.seededOther && r.businessId === 'biz-w' && r.customerId.startsWith('demo-s1-o'))).toBe(true)
  expect(rows.some(r => r.customerName === 'John Doe')).toBe(false)
  const statuses = rows.map(r => r.status)
  expect(statuses).toEqual(expect.arrayContaining(['no_show', 'completed', 'confirmed', 'cancelled']))
  // Inside opening hours, and never at 3 PM (the guided script books 3 PM).
  for (const r of rows) {
    const local = dayjs(r.startTime).tz('America/Chicago')
    expect(local.hour()).toBeGreaterThanOrEqual(9)
    expect(local.hour()).not.toBe(15)
  }
})

// With a pool of real sandbox payments they're PayPal bookings instead (paypalSamples.test.js).
test('paid up front like any booking (no paying at the visit); without a pool, as made-up demo money', async () => {
  await seedOthers(willow, { sid: 's1', now: NOW, pool: null })
  const rows = createAppointment.mock.calls.map(c => c[0])
  expect(rows.every(r => r.paymentId === null && r.paymentProvider === 'demo')).toBe(true)
  for (const r of rows.filter(x => x.status === 'completed')) expect(r).toMatchObject({ paymentStatus: 'paid', amountPaid: r.totalAmount })
  // Upcoming: Haircut is paid in full, Color & Gloss takes a 25% deposit ($30 of $120).
  for (const r of rows.filter(x => x.status === 'confirmed')) expect(r.amountPaid).toBe(r.serviceId === 'svc-color' ? 30 : r.totalAmount)
  for (const r of rows.filter(x => x.status === 'cancelled')) expect(r.refundAmount).toBe(r.amountPaid)
})

test('cancelling a made-up booking moves no money and says so', async () => {
  jest.resetModules()
  jest.doMock('../services/dynamo/appointments', () => ({ updateAppointment: jest.fn(), getAppointmentsForBusiness: jest.fn(async () => [appt]) }))
  jest.doMock('../services/redis', () => ({ releaseSlot: jest.fn().mockResolvedValue() }))
  jest.doMock('../core/refunds', () => ({ refundAppointment: jest.fn(), quoteRefund: jest.fn(() => ({ amount: 40, pct: 100 })) }))
  jest.doMock('../core/bookingMail', () => ({ cancelled: jest.fn().mockResolvedValue({}) }))
  const appt = { appointmentId: 'seed-x1', startTime: '2026-10-25T15:00:00.000Z', status: 'confirmed', amountPaid: 40, seeded: true, seededOther: true, serviceName: 'Haircut', customerId: 'demo-s1-o3' }
  const ops = require('../core/ownerOps')
  const q = await ops.cancelBooking(willow, { booking_id: 'seed-x1' })
  if (q.message) expect(q.message).toMatch(/made-up demo booking/)
  const r = await ops.cancelBooking(willow, { booking_id: 'seed-x1', confirm: true })
  expect(r).toMatchObject({ cancelled: true, refunded: false })
  expect(require('../core/refunds').refundAppointment).not.toHaveBeenCalled()
})

test('only on days the business is open, and only with someone who does the service', async () => {
  const bluebonnet = { ...CATALOG[1].build(), businessId: 'biz-b' }   // Tue–Sat, 10–7
  await seedOthers(bluebonnet, { sid: 's1', now: NOW })
  const rows = createAppointment.mock.calls.map(c => c[0])
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows) {
    expect(['Tue', 'Wed', 'Thu', 'Fri', 'Sat']).toContain(dayjs(r.startTime).tz('America/Chicago').format('ddd'))
    const person = bluebonnet.config.staff.find(s => s.staffId === r.unitId)
    expect(person.services).toContain(r.serviceId)
  }
})

test('a business with no services yet (guided salon) gets none', async () => {
  expect(await seedOthers({ ...willow, config: { ...willow.config, services: [] } }, { sid: 's1', now: NOW })).toBe(0)
  expect(createAppointment).not.toHaveBeenCalled()
})
