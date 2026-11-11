'use strict'

// PayPal webhooks for the unhappy paths: a
// reversal is not a refund, a denied or reversed approval frees the seat, a
// capture PayPal is reviewing stays on the calendar, and vault and dispute events
// go to their modules. Unsigned events are refused.

jest.mock('../services/payments/paypal', () => ({ verifyWebhook: jest.fn() }))
jest.mock('../core/paymentConfirm', () => ({ finalizeOrder: jest.fn(), cancelCheckout: jest.fn(), resultKey: id => `res:${id}`, releaseHeldSeat: jest.fn() }))
jest.mock('../services/dynamo/pendingPayments', () => ({ getPendingPayment: jest.fn(), consumePendingPayment: jest.fn() }))
jest.mock('../services/dynamo/processedMessages', () => ({ hasProcessed: jest.fn(), markProcessed: jest.fn(), saveResult: jest.fn(), getResult: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ updateAppointment: jest.fn() }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn(async id => ({ businessId: id, name: 'Willow' })) }))
jest.mock('../services/notify', () => ({ notifyOwner: jest.fn(async () => ({})), notifyCustomer: jest.fn(async () => ({})) }))
jest.mock('../core/savedPaypal', () => ({ onTokenDeleted: jest.fn() }))
jest.mock('../core/disputes', () => ({ onWebhook: jest.fn() }))

const paypal = require('../services/payments/paypal')
const { releaseHeldSeat } = require('../core/paymentConfirm')
const { getPendingPayment, consumePendingPayment } = require('../services/dynamo/pendingPayments')
const processed = require('../services/dynamo/processedMessages')
const { updateAppointment } = require('../services/dynamo/appointments')
const notify = require('../services/notify')
const { setStore, memory } = require('../services/demoStore')
const holds = require('../core/holds')
const { webhook } = require('../handlers/paypal')

const send = body => webhook({ headers: { 'paypal-transmission-sig': 'x' }, body: JSON.stringify({ id: `WH-${Math.random()}`, ...body }) })
const pending = { businessId: 'B1', serviceName: 'Haircut', customerId: 'C1', startIso: '2026-11-02T16:00:00.000Z' }

beforeEach(() => {
  jest.clearAllMocks()
  setStore(memory())
  paypal.verifyWebhook.mockResolvedValue(true)
  processed.hasProcessed.mockResolvedValue(false)
})

test('an unsigned event is refused', async () => {
  paypal.verifyWebhook.mockResolvedValue(false)
  expect((await send({ event_type: 'PAYMENT.CAPTURE.REVERSED', resource: {} })).statusCode).toBe(401)
})

test('a reversal is recorded as PayPal taking the money back, not as a refund, and the owner is told', async () => {
  processed.getResult.mockResolvedValue({ businessId: 'B1', startTime: 'T', appointmentId: 'A1', amountPaid: 40 })
  const r = await send({ event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: 'R1', status: 'COMPLETED', amount: { value: '40.00' }, links: [{ rel: 'up', href: 'https://api/v2/payments/captures/CAP1' }] } })
  expect(r.statusCode).toBe(200)
  expect(processed.getResult).toHaveBeenCalledWith('cap:CAP1')
  const changes = updateAppointment.mock.calls[0][3]
  expect(changes).toMatchObject({ paymentStatus: 'reversed', reversedAmount: 40 })
  expect(changes.refundAmount).toBeUndefined()
  expect(notify.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ kind: 'payment_reversed' }))
})

test('a refund still syncs as a refund', async () => {
  processed.getResult.mockResolvedValue({ businessId: 'B1', startTime: 'T', appointmentId: 'A1', amountPaid: 40 })
  await send({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'R2', status: 'COMPLETED', amount: { value: '20.00' }, seller_payable_breakdown: { total_refunded_amount: { value: '20.00' } }, links: [{ rel: 'up', href: 'https://api/v2/payments/captures/CAP1' }] } })
  expect(updateAppointment.mock.calls[0][3]).toMatchObject({ refundAmount: 20, paymentStatus: 'partially_refunded' })
})

test('a denied capture, or an approval PayPal reversed, frees the seat and takes it off the calendar', async () => {
  for (const [event_type, resource, orderId] of [
    ['PAYMENT.CAPTURE.DENIED', { status: 'DENIED', supplementary_data: { related_ids: { order_id: 'ORD1' } } }, 'ORD1'],
    ['CHECKOUT.PAYMENT-APPROVAL.REVERSED', { order_id: 'ORD2' }, 'ORD2']
  ]) {
    jest.clearAllMocks()
    getPendingPayment.mockResolvedValue(pending)
    await holds.add({ businessId: 'B1' }, { orderId, startIso: pending.startIso, minutes: 60, serviceName: 'Haircut' })
    consumePendingPayment.mockResolvedValue(pending)
    await send({ event_type, resource })
    expect(consumePendingPayment).toHaveBeenCalledWith(orderId)
    expect(releaseHeldSeat).toHaveBeenCalledWith(pending)
    expect(processed.saveResult).toHaveBeenCalledWith(`res:${orderId}`, expect.objectContaining({ status: 'failed' }))
    expect(await holds.list('B1', '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z')).toEqual([])
  }
})

test('a capture PayPal is reviewing stays on the calendar as "reviewing"', async () => {
  getPendingPayment.mockResolvedValue(pending)
  await holds.add({ businessId: 'B1' }, { orderId: 'ORD3', startIso: pending.startIso, minutes: 60, serviceName: 'Haircut', customerName: 'John' })
  await send({ event_type: 'PAYMENT.CAPTURE.PENDING', resource: { status: 'PENDING', status_details: { reason: 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION' }, supplementary_data: { related_ids: { order_id: 'ORD3' } } } })
  const [h] = await holds.list('B1', '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z')
  expect(h).toMatchObject({ orderId: 'ORD3', status: 'reviewing', customerName: 'John' })
  expect(h.until - Date.now()).toBeGreaterThan(24 * 3600_000)
})

test('vault and dispute events go to their modules', async () => {
  await send({ event_type: 'VAULT.PAYMENT-TOKEN.DELETED', resource: { id: 'VAULT1' } })
  expect(require('../core/savedPaypal').onTokenDeleted).toHaveBeenCalledWith('VAULT1', 'VAULT.PAYMENT-TOKEN.DELETED')
  await send({ event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-1' } })
  expect(require('../core/disputes').onWebhook).toHaveBeenCalledWith('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'PP-D-1' })
})
