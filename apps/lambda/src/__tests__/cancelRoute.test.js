'use strict'

// Cancelling from the dashboard's Bookings page goes through the same code as
// the owner's MCP cancel_booking: quote first (policy / full / none), then cancel,
// free the seat, refund via PayPal, give a membership use back, tell the customer.

jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn(), updateBusiness: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), updateAppointment: jest.fn(), createAppointment: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn().mockResolvedValue({ customerId: 'sam', name: 'Sam Rivera', demoSessionId: 'c1' }) }))
jest.mock('../services/redis', () => ({ releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['inbox']), notifyOwner: jest.fn() }))
jest.mock('../core/memberships', () => ({ afterCancel: jest.fn().mockResolvedValue(1) }))
jest.mock('../core/refunds', () => ({ ...jest.requireActual('../core/refunds'), refundAppointment: jest.fn() }))

process.env.FLOW_LINK_SECRET = 'test-secret'
const { getBusiness } = require('../services/dynamo/businesses')
const { getAppointmentsForBusiness, updateAppointment } = require('../services/dynamo/appointments')
const redis = require('../services/redis')
const { notifyCustomer } = require('../services/notify')
const memberships = require('../core/memberships')
const { refundAppointment } = require('../core/refunds')
const { createToken } = require('../utils/jwt')
const { handler } = require('../handlers/dashboardApi')
const { CATALOG } = require('../demo/templates')

const BID = 'biz-cancel'
const call = async (body) => {
  const r = await handler({ httpMethod: 'POST', pathParameters: { proxy: 'bookings/cancel' }, headers: { Authorization: `Bearer ${createToken({ businessId: BID }, 3600)}` }, body: JSON.stringify(body) })
  return { status: r.statusCode, body: JSON.parse(r.body) }
}
const inDays = d => new Date(Date.now() + d * 86_400_000).toISOString()
// 72 hours out: the full-refund window under Willow's rules.
const paid = { appointmentId: 'appt-paid-1', businessId: BID, customerId: 'sam', customerName: 'Sam Rivera', serviceName: 'Haircut', unitId: 'staff-ana', status: 'confirmed', startTime: inDays(3), endTime: inDays(3.05), amountPaid: 40, totalAmount: 40, paymentId: 'CAP1', paymentProvider: 'paypal', currency: 'USD' }

beforeEach(() => {
  jest.clearAllMocks()
  getBusiness.mockResolvedValue({ ...CATALOG[0].build(), businessId: BID })
  getAppointmentsForBusiness.mockResolvedValue([paid])
})

test('the quote shows what was paid and every refund choice; nothing changes yet', async () => {
  const { status, body } = await call({ appointmentId: paid.appointmentId })
  expect(status).toBe(200)
  expect(body).toMatchObject({ needs_confirmation: true, paid: '$40', tells_customer: true })
  expect(body.options).toEqual({ policy: { amount: 40, label: '$40', pct: 100 }, full: { amount: 40, label: '$40' }, none: { amount: 0, label: '$0' } })
  expect(updateAppointment).not.toHaveBeenCalled()
  expect(refundAppointment).not.toHaveBeenCalled()
})

test('confirm: cancelled, seat freed, refunded by policy through PayPal', async () => {
  refundAppointment.mockResolvedValue({ refunded: true, amount: 40, status: 'COMPLETED' })
  const { body } = await call({ appointmentId: paid.appointmentId, refund: 'policy', reason: 'Ana is off sick', confirm: true })
  expect(body).toMatchObject({ cancelled: true, refunded: true, refund: '$40' })
  expect(updateAppointment).toHaveBeenCalledWith(BID, paid.startTime, paid.appointmentId, expect.objectContaining({ status: 'cancelled', cancelledBy: 'owner' }))
  expect(redis.releaseSlot).toHaveBeenCalledWith(BID, paid.startTime, 'staff-ana')
  expect(refundAppointment.mock.calls[0][0]).toMatchObject({ amount: 40, reason: 'Ana is off sick', initiatedBy: 'owner' })
  // The page says the customer was told only because a message really reached their inbox.
  expect(body.customer_notified).toBe(true)
  expect(notifyCustomer.mock.calls[0][0].text).toMatch(/Your Haircut at Willow & Co\. Salon on .* was cancelled by the business\. Reason: Ana is off sick\.[\s\S]*\$40 has been refunded to your PayPal account/)
})

test('paid in person: the quote and the result say to refund them directly; the customer hears the same', async () => {
  getAppointmentsForBusiness.mockResolvedValue([{ ...paid, paymentId: null, paymentProvider: null, createdVia: 'mcp_owner' }])
  const q = await call({ appointmentId: paid.appointmentId })
  expect(q.body).toMatchObject({ refund: '$40', refund_how: 'in person', message: expect.stringMatching(/^This cancels the booking\. They paid in person, so refund \$40 to them directly/) })
  const { body } = await call({ appointmentId: paid.appointmentId, refund: 'policy', confirm: true })
  expect(body).toMatchObject({ cancelled: true, refunded: false, refund: '$0', refund_to_pay_directly: '$40', customer_notified: true, message: 'They paid in person, so refund $40 to them directly.' })
  expect(notifyCustomer.mock.calls[0][0].text).toMatch(/The business will refund \$40 to you directly/)
})

test('a walk-in nobody can message: cancelled, and nobody is said to be told', async () => {
  getAppointmentsForBusiness.mockResolvedValue([{ ...paid, customerId: null, customerName: 'Jo', paymentId: null, amountPaid: 0 }])
  const { body } = await call({ appointmentId: paid.appointmentId, confirm: true })
  expect(body).toMatchObject({ cancelled: true, customer_notified: false })
  expect(notifyCustomer).not.toHaveBeenCalled()
})

test('no refund: cancelled and the customer is told', async () => {
  const { body } = await call({ appointmentId: paid.appointmentId, refund: 'none', confirm: true })
  expect(body).toMatchObject({ cancelled: true, refunded: false })
  expect(refundAppointment).not.toHaveBeenCalled()
  expect(notifyCustomer.mock.calls[0][0]).toMatchObject({ subject: expect.stringMatching(/Your booking was cancelled/) })
})

test('a PayPal failure still cancels and says plainly the refund needs doing', async () => {
  refundAppointment.mockRejectedValue(new Error('PayPal 500'))
  const { status, body } = await call({ appointmentId: paid.appointmentId, refund: 'full', confirm: true })
  expect(status).toBe(200)
  expect(body).toMatchObject({ cancelled: true, refunded: false, refund_failed: true, message: expect.stringMatching(/Refund it from PayPal/) })
})

test('a booking a membership covers gives its use back', async () => {
  getAppointmentsForBusiness.mockResolvedValue([{ ...paid, amountPaid: 0, paymentId: 'membership:m1', membershipId: 'm1', membershipPlan: 'Willow Monthly' }])
  const q = await call({ appointmentId: paid.appointmentId })
  expect(q.body).toMatchObject({ covered_by: 'Willow Monthly' })
  await call({ appointmentId: paid.appointmentId, confirm: true })
  expect(memberships.afterCancel).toHaveBeenCalled()
  expect(notifyCustomer.mock.calls[0][0].text).toMatch(/goes back to your Willow Monthly/)
})

test('bad input is refused', async () => {
  expect((await call({})).status).toBe(400)
  expect((await call({ appointmentId: paid.appointmentId, refund: 'double' })).status).toBe(400)
  getAppointmentsForBusiness.mockResolvedValue([])
  expect((await call({ appointmentId: 'nope-0000' })).body.error).toMatch(/No booking/)
})
