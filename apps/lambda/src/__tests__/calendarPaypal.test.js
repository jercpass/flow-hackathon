'use strict'

// The owner calendar follows PayPal: each
// booking says what PayPal says about its payment, a seat held while the
// customer pays is shown until PayPal settles it, and a dispute is flagged with
// its respond-by date.

jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), updateAppointment: jest.fn() }))
jest.mock('../services/dynamo/pendingPayments', () => ({ getPendingPayment: jest.fn() }))

const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const { getPendingPayment } = require('../services/dynamo/pendingPayments')
const { setStore, memory } = require('../services/demoStore')
const holds = require('../core/holds')
const ownerOps = require('../core/ownerOps')
const { CATALOG } = require('../demo/templates')

const business = { ...CATALOG[0].build(), businessId: 'B1' }
const at = h => new Date(Date.now() + h * 3_600_000).toISOString()
const booking = (id, o = {}) => ({ appointmentId: id, businessId: 'B1', customerId: 'c', customerName: 'Sam', serviceName: 'Haircut', unitId: 'staff-ana', status: 'confirmed', startTime: at(26), endTime: at(27), amountPaid: 40, totalAmount: 40, paymentId: 'CAP12345678', currency: 'USD', createdVia: 'web', ...o })

beforeEach(() => {
  jest.clearAllMocks()
  setStore(memory())
  getPendingPayment.mockResolvedValue(null)
})

test('each booking carries its PayPal state and colour', async () => {
  getAppointmentsForBusiness.mockResolvedValue([
    booking('a-paid', { paidUnder: 'allowance', paymentMandateId: 'pm_1' }),
    booking('a-dep', { amountPaid: 30, totalAmount: 120 }),
    booking('a-ref', { refundAmount: 40 }),
    booking('a-rev', { paymentStatus: 'reversed', reversedAmount: 40 }),
    booking('a-dis', { dispute: { id: 'PP-D-1', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', dueAt: at(240) } })
  ])
  const { events } = await ownerOps.calendar(business, {})
  const by = Object.fromEntries(events.map(e => [e.id, e]))
  expect(by['a-paid']).toMatchObject({ pay: 'paid', eventColor: 'blue' })
  expect(by['a-paid'].paypal[0]).toMatch(/signed mandate \(pm_1\)/)
  expect(by['a-dep']).toMatchObject({ pay: 'deposit', eventColor: 'orange' })
  expect(by['a-ref']).toMatchObject({ pay: 'refunded', eventColor: 'red' })
  expect(by['a-rev']).toMatchObject({ pay: 'reversed', eventColor: 'purple' })
  expect(by['a-rev'].paypal.join(' ')).toMatch(/PayPal took back \$40/)
  expect(by['a-dis']).toMatchObject({ pay: 'disputed', eventColor: 'deep-orange', disputeId: 'PP-D-1', disputeOpen: true })
  expect(by['a-dis'].paypal.join(' ')).toMatch(/respond by/)
})

test('a seat held for a PayPal payment shows until PayPal settles it', async () => {
  getAppointmentsForBusiness.mockResolvedValue([])
  await holds.add(business, { orderId: 'ORD1', startIso: at(30), minutes: 60, unitId: 'staff-ben', serviceName: 'Haircut', customerName: 'John', amount: 40, currency: 'USD', channel: 'web' })
  getPendingPayment.mockResolvedValue({ businessId: 'B1' })
  let { events } = await ownerOps.calendar(business, {})
  expect(events).toEqual([expect.objectContaining({ id: 'hold:ORD1', status: 'held', pay: 'held', resourceId: 'staff-ben', customer: 'John', amountDue: '$40', draggable: false })])

  await holds.markReviewing('B1', 'ORD1')
  ;({ events } = await ownerOps.calendar(business, {}))
  expect(events[0]).toMatchObject({ pay: 'reviewing' })

  // Paid (or given up): the pending payment is gone, so is the bar.
  getPendingPayment.mockResolvedValue(null)
  ;({ events } = await ownerOps.calendar(business, {}))
  expect(events).toEqual([])
})
