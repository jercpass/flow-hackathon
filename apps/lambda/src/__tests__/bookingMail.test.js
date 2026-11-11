'use strict'

// Moving or cancelling a booking messages both sides' inboxes: the customer and the
// business. A customer's cancel refunds by policy through PayPal on its own.
// The calendar keeps how a booking was first made and shows who moved it.

jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn().mockResolvedValue({ customerId: 'sam', name: 'Sam Rivera', demoSessionId: 'x' }), updateCustomer: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), createAppointment: jest.fn(async () => ({ created: true })), updateAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ reserveSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn().mockResolvedValue(['staff-ana', 'staff-ben']), getNextQueueToken: jest.fn(), priceForUnit: jest.fn(s => s) }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['inbox']), notifyOwner: jest.fn().mockResolvedValue(true) }))
jest.mock('../core/memberships', () => ({ afterCancel: jest.fn().mockResolvedValue(1), offers: jest.fn(() => []) }))
jest.mock('../core/refunds', () => ({ ...jest.requireActual('../core/refunds'), refundAppointment: jest.fn() }))

const { getAppointmentsForBusiness, createAppointment } = require('../services/dynamo/appointments')
const { notifyCustomer, notifyOwner } = require('../services/notify')
const { refundAppointment } = require('../core/refunds')
const { executeTool } = require('../services/tools')
const ownerOps = require('../core/ownerOps')
const { CATALOG } = require('../demo/templates')

const BID = 'biz-mail'
const business = { ...CATALOG[0].build(), businessId: BID, demoSessionId: 'x', ownerInbox: true }
const ctx = () => ({ business, customer: { customerId: 'sam', name: 'Sam Rivera', demoSessionId: 'x' }, channel: 'web' })
const inHours = h => new Date(Date.now() + h * 3_600_000).toISOString()
const booking = (o = {}) => ({ appointmentId: 'appt-mail-1', businessId: BID, customerId: 'sam', customerName: 'Sam Rivera', serviceId: 'svc-haircut', serviceName: 'Haircut', unitId: 'staff-ana', status: 'confirmed', startTime: inHours(72), endTime: inHours(73), amountPaid: 40, totalAmount: 40, paymentId: 'CAP1', paymentProvider: 'paypal', currency: 'USD', createdVia: 'web', ...o })
const mailTo = () => ({ customer: notifyCustomer.mock.calls.map(c => c[0]), owner: notifyOwner.mock.calls.map(c => c[0]) })

beforeEach(() => jest.clearAllMocks())

describe('the customer cancels', () => {
  test('3 days out: refunded in full through PayPal, one message each to the customer and the business', async () => {
    getAppointmentsForBusiness.mockResolvedValue([booking()])
    refundAppointment.mockResolvedValue({ refunded: true, amount: 40, status: 'COMPLETED' })
    const r = await executeTool('cancel_booking', { confirm: true }, ctx())
    expect(r).toMatchObject({ cancelled: true, refunded: true, refundAmount: 40 })
    expect(refundAppointment.mock.calls[0][0]).toMatchObject({ amount: 40, initiatedBy: 'customer', notify: false })
    const { customer, owner } = mailTo()
    expect(customer).toHaveLength(1)
    expect(customer[0]).toMatchObject({ channel: 'inbox', subject: expect.stringMatching(/^Your booking was cancelled/) })
    expect(customer[0].text).toMatch(/You cancelled your Haircut[\s\S]*\$40 has been refunded to your PayPal/)
    expect(owner).toHaveLength(1)
    expect(owner[0].subject).toMatch(/^Cancelled by the customer: Haircut/)
    expect(owner[0].text).toMatch(/Sam Rivera cancelled their Haircut .* with Ana\. The time is free again\.[\s\S]*\$40 was refunded to them through PayPal automatically \(100% under your cancellation policy\)/)
  })

  test('inside the last day: no refund under the policy, and both still hear about it', async () => {
    getAppointmentsForBusiness.mockResolvedValue([booking({ startTime: inHours(5), endTime: inHours(6) })])
    await executeTool('cancel_booking', { confirm: true }, ctx())
    expect(refundAppointment).not.toHaveBeenCalled()
    expect(mailTo().customer[0].text).toMatch(/No refund applies under the cancellation policy/)
    expect(mailTo().owner[0].text).toMatch(/No refund applies under your cancellation policy/)
  })

  test('PayPal fails: still cancelled, the customer is told it is coming, the business is told to refund', async () => {
    getAppointmentsForBusiness.mockResolvedValue([booking()])
    refundAppointment.mockRejectedValue(new Error('PayPal 500'))
    const r = await executeTool('cancel_booking', { confirm: true }, ctx())
    expect(r).toMatchObject({ cancelled: true, refundPending: true })
    expect(mailTo().customer[0].text).toMatch(/\$40 refund is being processed/)
    expect(mailTo().owner[0].text).toMatch(/didn't go through automatically\. Refund it from PayPal/)
  })

  test('covered by a membership: the use goes back, and both are told', async () => {
    getAppointmentsForBusiness.mockResolvedValue([booking({ amountPaid: 0, paymentId: 'membership:m1', membershipId: 'm1', membershipPlan: 'Willow Monthly' })])
    await executeTool('cancel_booking', { confirm: true }, ctx())
    expect(mailTo().customer[0].text).toMatch(/goes back to your Willow Monthly \(1 left\)/)
    expect(mailTo().owner[0].text).toMatch(/Haircut went back to their Willow Monthly/)
  })
})

test('the customer moves a booking: both are told, and it keeps how it was booked', async () => {
  getAppointmentsForBusiness.mockResolvedValue([booking()])
  const r = await executeTool('reschedule_booking', { new_time: `${require('../utils/time').localDate(inHours(96), 'America/Chicago')}T11:00` }, ctx())
  expect(r).toMatchObject({ rescheduled: true })
  expect(createAppointment.mock.calls[0][0]).toMatchObject({ bookedVia: 'web', movedBy: 'customer' })
  expect(mailTo().customer[0].subject).toMatch(/^Your booking moved/)
  expect(mailTo().owner[0].subject).toMatch(/^Moved by the customer: Haircut/)
})

test('the owner moves a booking: the customer is told, the business gets a record', async () => {
  getAppointmentsForBusiness.mockResolvedValue([booking()])
  const r = await ownerOps.rescheduleBooking(business, { booking_id: 'appt-mail-1', new_time: '2026-12-01T10:00', unit_id: 'staff-ben' })
  expect(r).toMatchObject({ rescheduled: true, customer_notified: true, staff: 'Ben' })
  expect(createAppointment.mock.calls[0][0]).toMatchObject({ bookedVia: 'web', movedBy: 'owner' })
  expect(mailTo().customer[0].text).toMatch(/Willow & Co\. Salon moved your Haircut from .* to .* with Ben/)
  expect(mailTo().owner[0].text).toMatch(/^You moved Sam Rivera's Haircut .* The customer was told in their inbox\./)
})

test('calendar: "Booked via" stays the first channel; the move is its own line', async () => {
  const moved = booking({ createdVia: 'owner_reschedule', bookedVia: 'speaker', movedBy: 'owner' })
  const old = booking({ appointmentId: 'appt-old-1', createdVia: 'owner_reschedule' })   // moved before bookedVia existed
  getAppointmentsForBusiness.mockResolvedValue([moved, old, booking({ appointmentId: 'appt-new-1' })])
  const { events } = await ownerOps.calendar(business, {})
  expect(events.map(e => [e.channel, e.moved])).toEqual([['speaker', 'owner'], [null, 'owner'], ['web', null]])
})

test('messages name the service, even for a booking made before the name was stored on it', async () => {
  const { serviceName, ...old } = booking()
  getAppointmentsForBusiness.mockResolvedValue([old])
  refundAppointment.mockResolvedValue({ refunded: true, amount: 40, status: 'COMPLETED' })
  await executeTool('cancel_booking', { confirm: true }, ctx())
  expect(mailTo().customer[0].text).toMatch(/You cancelled your Haircut/)
  expect(mailTo().owner[0].subject).toMatch(/: Haircut,/)
})

test('a new booking keeps the service name, so its messages say "Haircut"', async () => {
  getAppointmentsForBusiness.mockResolvedValue([])
  const { createBooking } = require('../core/engine')
  const a = await createBooking({ business, serviceId: 'svc-haircut', startIso: inHours(48), customer: { customerId: 'sam', phone: null, name: 'Sam Rivera' }, paymentId: 'CAP9', createdVia: 'web', payment: { provider: 'paypal' } })
  expect(a.serviceName).toBe('Haircut')
  expect(createAppointment.mock.calls[0][0].serviceName).toBe('Haircut')
})
