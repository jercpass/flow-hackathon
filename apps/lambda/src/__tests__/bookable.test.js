'use strict'

// A customer (or their AI) can only book or move to a time the business offers:
// open hours and days, not in the past, and with someone who does the service and
// is free. Refused before any PayPal link is made, so nobody pays for a time that
// can't happen. (Found testing the customer MCP: 10 PM and last week both got links.)

jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn().mockResolvedValue({ customerId: 'sam', name: 'Sam Rivera' }), updateCustomer: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn().mockResolvedValue([]), createAppointment: jest.fn(async () => ({ created: true })), updateAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ reserveSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn(), getNextQueueToken: jest.fn(), priceForUnit: jest.fn(s => s) }))
jest.mock('../core/paymentFlow', () => ({ requestPayment: jest.fn(async () => ({ paymentUrl: 'https://paypal.test/pay', orderId: 'O1', amountDue: 40 })), requestBalancePayment: jest.fn() }))
jest.mock('../core/memberships', () => ({ coverFor: jest.fn().mockResolvedValue(null), offers: jest.fn(() => []) }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['inbox']), notifyOwner: jest.fn().mockResolvedValue(true) }))
jest.mock('../services/payments', () => ({ getPaymentProvider: () => ({ id: 'paypal', isConfigured: () => true }) }))

const { getFreeUnitsForSlot } = require('../core/units')
const { requestPayment } = require('../core/paymentFlow')
const { getAppointmentsForBusiness, createAppointment } = require('../services/dynamo/appointments')
const { executeTool } = require('../services/tools')
const { toUtcIso, localDate } = require('../utils/time')
const { CATALOG } = require('../demo/templates')

const TZ = 'America/Chicago'
const business = { ...CATALOG[0].build(), businessId: 'biz-book' }   // Willow: daily 9–6; Ana does both services, Ben only Haircut
const ctx = () => ({ business, customer: { customerId: 'sam', name: 'Sam Rivera' }, channel: 'web' })
const day = d => localDate(new Date(Date.now() + d * 86_400_000).toISOString(), TZ)
const book = (time, more = {}) => executeTool('book_appointment', { service_name: 'Haircut', start_time: time, ...more }, ctx())

beforeEach(() => {
  jest.clearAllMocks()
  getFreeUnitsForSlot.mockResolvedValue(['staff-ana', 'staff-ben'])
  // No bookings unless a test adds some (one that does would otherwise leak into
  // the next, and the duplicate guard would answer "Already booked").
  getAppointmentsForBusiness.mockResolvedValue([])
})

test('an open slot gets its PayPal link', async () => {
  const r = await book(`${day(3)}T10:00`, { staff_name: 'Ana' })
  expect(r).toMatchObject({ paymentRequired: true, paymentUrl: 'https://paypal.test/pay' })
  expect(requestPayment.mock.calls[0][0]).toMatchObject({ preferredUnitId: 'staff-ana', startIso: toUtcIso(`${day(3)}T10:00`, TZ) })
})

test('after closing: refused, with the open times that day, and no PayPal link', async () => {
  const r = await book(`${day(3)}T22:00`)
  expect(r).toMatchObject({ booked: false })
  expect(r.error).toMatch(/10 PM isn't open for Haircut\. Open times that day: 9 AM, 10 AM/)
  expect(requestPayment).not.toHaveBeenCalled()
})

test('a time in the past: refused', async () => {
  const r = await book(`${day(-3)}T10:00`)
  expect(r.error).toMatch(/has already passed/)
  expect(requestPayment).not.toHaveBeenCalled()
})

test('off the grid (10:30 for an hourly service): refused with the times that work', async () => {
  const r = await book(`${day(3)}T10:30`)
  expect(r.error).toMatch(/10:30 AM isn't open for Haircut\. Open times that day: 9 AM/)
})

test('someone who doesn\'t do the service: says who does', async () => {
  const r = await executeTool('book_appointment', { service_name: 'Color & Gloss', start_time: `${day(3)}T11:00`, staff_name: 'Ben' }, ctx())
  expect(r.error).toBe("Ben doesn't do Color & Gloss. Ana can.")
  expect(requestPayment).not.toHaveBeenCalled()
})

test('the named person is busy: says so instead of quietly booking someone else', async () => {
  getFreeUnitsForSlot.mockResolvedValue(['staff-ben'])
  const r = await book(`${day(3)}T10:00`, { staff_name: 'Ana' })
  expect(r.error).toMatch(/^Ana isn't free at .*10 AM\./)
  expect(requestPayment).not.toHaveBeenCalled()
})

test('nobody free: "already taken"', async () => {
  getFreeUnitsForSlot.mockResolvedValue([])
  expect((await book(`${day(3)}T10:00`)).error).toMatch(/is already taken\. Nothing is open that day/)
})

test('a staff name nobody has: refused', async () => {
  expect((await book(`${day(3)}T10:00`, { staff_name: 'Zed' })).error).toBe('No staff member named "Zed".')
})

test('moving a booking to after closing is refused; nothing is moved', async () => {
  const start = toUtcIso(`${day(4)}T10:00`, TZ)
  getAppointmentsForBusiness.mockResolvedValue([{ appointmentId: 'a1', businessId: 'biz-book', customerId: 'sam', serviceId: 'svc-haircut', serviceName: 'Haircut', unitId: 'staff-ana', status: 'confirmed', startTime: start, endTime: start }])
  const r = await executeTool('reschedule_booking', { new_time: `${day(5)}T21:00` }, ctx())
  expect(r).toMatchObject({ rescheduled: false })
  expect(r.error).toMatch(/9 PM isn't open for Haircut/)
  expect(createAppointment).not.toHaveBeenCalled()
})

test('no paying at the visit: a priced service with no payment set is paid in full when booking', async () => {
  const noMode = { ...business, config: { ...business.config, services: business.config.services.map(s => (s.serviceId === 'svc-haircut' ? { ...s, paymentMode: 'none' } : s)) } }
  const r = await executeTool('book_appointment', { service_name: 'Haircut', start_time: `${day(3)}T10:00`, staff_name: 'Ana' }, { ...ctx(), business: noMode })
  expect(r).toMatchObject({ booked: false, paymentRequired: true, paymentUrl: 'https://paypal.test/pay' })
  expect(r.message).toMatch(/pay the full amount of \$40/)
  expect(requestPayment).toHaveBeenCalled()
})

test('a free service books straight away, and both sides are told', async () => {
  const { notifyOwner, notifyCustomer } = require('../services/notify')
  const free = { ...business, config: { ...business.config, services: business.config.services.map(s => (s.serviceId === 'svc-haircut' ? { ...s, price: 0, paymentMode: 'none' } : s)) } }
  const r = await executeTool('book_appointment', { service_name: 'Haircut', start_time: `${day(3)}T10:00`, staff_name: 'Ana' }, { ...ctx(), business: free })
  expect(r).toMatchObject({ booked: true, message: expect.stringMatching(/^Booked for .*10 AM\.$/) })
  expect(requestPayment).not.toHaveBeenCalled()
  expect(notifyOwner.mock.calls[0][0]).toMatchObject({ kind: 'new_booking', subject: expect.stringMatching(/^New booking: Haircut, /) })
  expect(notifyCustomer.mock.calls[0][0]).toMatchObject({ channel: 'inbox', kind: 'confirmation', text: expect.stringMatching(/^Your Haircut at Willow & Co\. Salon is booked for /) })
})
