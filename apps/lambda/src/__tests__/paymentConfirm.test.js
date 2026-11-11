'use strict'

// finalizeOrder: seat check before capture, exactly-once confirm, auto-refund on failure.

jest.mock('../services/dynamo', () => ({ getBusiness: jest.fn(), getCustomer: jest.fn() }))
jest.mock('../services/dynamo/pendingPayments', () => ({ getPendingPayment: jest.fn(), consumePendingPayment: jest.fn() }))
jest.mock('../services/dynamo/processedMessages', () => ({ saveResult: jest.fn(), getResult: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ updateAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ holdSlotForPayment: jest.fn(), releaseSlot: jest.fn().mockResolvedValue() }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['email']) }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn() }))
jest.mock('../core/savedPaypal', () => ({ remember: jest.fn().mockResolvedValue({}), masked: jest.fn(() => 'j***@example.com') }))
jest.mock('../core/engine', () => ({
  createBooking: jest.fn(),
  getService: jest.fn((biz, id) => biz.config.services.find(s => s.serviceId === id))
}))
jest.mock('../services/payments', () => {
  const provider = { id: 'paypal', capture: jest.fn(), refund: jest.fn() }
  return { getProviderById: () => provider, __provider: provider }
})
jest.mock('../utils/receipt', () => ({
  renderReceiptPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
  buildReceipt: jest.fn(() => 'receipt'),
  formatIST: jest.fn(() => 'Oct 17, 2026, 03:00 PM')
}))

const { getBusiness, getCustomer } = require('../services/dynamo')
const { getPendingPayment, consumePendingPayment } = require('../services/dynamo/pendingPayments')
const { saveResult, getResult } = require('../services/dynamo/processedMessages')
const redis = require('../services/redis')
const { getFreeUnitsForSlot } = require('../core/units')
const { createBooking } = require('../core/engine')
const { notifyCustomer } = require('../services/notify')
const provider = require('../services/payments').__provider
const { finalizeOrder } = require('../core/paymentConfirm')

const business = {
  businessId: 'b1', name: 'Demo Salon', timezone: 'America/New_York',
  config: { currency: 'USD', services: [{ serviceId: 's1', name: 'Haircut', duration: 60, unitType: 'person' }] }
}
const pending = {
  referenceId: 'flow_1', provider: 'paypal', businessId: 'b1', serviceId: 's1', serviceName: 'Haircut',
  startIso: '2026-10-17T19:00:00.000Z', customerId: 'c1', amountDue: 40, currency: 'USD', channel: 'web', preferredUnitId: 'u1'
}
const capture = { captureId: 'CAP1', captureStatus: 'COMPLETED', amount: 40, currency: 'USD', paidAt: '2026-10-16T10:00:00Z' }

beforeEach(() => {
  jest.clearAllMocks()
  getBusiness.mockResolvedValue(business)
  getCustomer.mockResolvedValue({ customerId: 'c1', email: 'ana@example.com' })
  getPendingPayment.mockResolvedValue(pending)
  consumePendingPayment.mockResolvedValue(pending)
  getFreeUnitsForSlot.mockResolvedValue(['u1', 'u2'])
  redis.holdSlotForPayment.mockResolvedValue({ held: true })
  provider.capture.mockResolvedValue(capture)
  createBooking.mockResolvedValue({ appointmentId: 'a1', startTime: pending.startIso, amountPaid: 40 })
})

test('happy path: seat ok → capture → booking with PayPal capture id → customer notified', async () => {
  const r = await finalizeOrder('ORDER1')
  expect(provider.capture).toHaveBeenCalledWith('ORDER1')
  expect(createBooking).toHaveBeenCalledWith(expect.objectContaining({
    serviceId: 's1', paymentId: 'CAP1', preferredUnitId: 'u1', createdVia: 'web',
    payment: { provider: 'paypal', providerOrderId: 'ORDER1', currency: 'USD', payeeMerchantId: null, amount: 40, memberDiscountPct: null }   // the captured amount is what's recorded
  }))
  expect(r).toMatchObject({ status: 'confirmed', appointmentId: 'a1', amount: 40, currency: 'USD', channel: 'web' })
  expect(saveResult).toHaveBeenCalledWith('cap:CAP1', expect.objectContaining({ appointmentId: 'a1' }), expect.any(Number))
  expect(saveResult).toHaveBeenCalledWith('payres:ORDER1', expect.objectContaining({ status: 'confirmed' }))
  expect(notifyCustomer).toHaveBeenCalledWith(expect.objectContaining({ channel: 'web', text: expect.stringContaining('$40') }))
})

test('slot gone before capture → never captured, customer told they were not charged', async () => {
  getFreeUnitsForSlot.mockResolvedValue(['u2'])  // u1 got booked by someone else
  const r = await finalizeOrder('ORDER1')
  expect(provider.capture).not.toHaveBeenCalled()
  expect(createBooking).not.toHaveBeenCalled()
  expect(r).toMatchObject({ status: 'slot_taken', charged: false })
  expect(notifyCustomer.mock.calls[0][0].text).toMatch(/NOT been charged/)
})

test('another customer holds the seat → not captured', async () => {
  redis.holdSlotForPayment.mockResolvedValue({ held: false })
  const r = await finalizeOrder('ORDER1')
  expect(provider.capture).not.toHaveBeenCalled()
  expect(r.status).toBe('slot_taken')
})

test('second call (return + webhook race) returns the stored result without re-booking', async () => {
  getPendingPayment.mockResolvedValue(null)
  getResult.mockResolvedValue({ status: 'confirmed', appointmentId: 'a1' })
  const r = await finalizeOrder('ORDER1')
  expect(r).toEqual({ status: 'confirmed', appointmentId: 'a1' })
  expect(provider.capture).not.toHaveBeenCalled()
  expect(createBooking).not.toHaveBeenCalled()
})

test('lost the consume race after capture → no second booking', async () => {
  consumePendingPayment.mockResolvedValue(null)
  getResult.mockResolvedValue(null)
  const r = await finalizeOrder('ORDER1')
  expect(createBooking).not.toHaveBeenCalled()
  expect(r.status).toBe('processing')
})

test('booking fails after capture → full automatic refund', async () => {
  createBooking.mockRejectedValue(new Error('slot was just taken by another customer'))
  provider.refund.mockResolvedValue({ refundId: 'R1', status: 'COMPLETED', amount: 40 })
  const r = await finalizeOrder('ORDER1')
  expect(provider.refund).toHaveBeenCalledWith(expect.objectContaining({ captureId: 'CAP1', amount: 40, requestId: 'ref_fail_ORDER1' }))
  expect(r).toMatchObject({ status: 'refunded', refunded: true, amount: 40 })
  expect(redis.releaseSlot).toHaveBeenCalled()
})

test('underpayment is refunded, never booked', async () => {
  provider.capture.mockResolvedValue({ ...capture, amount: 4 })
  provider.refund.mockResolvedValue({ refundId: 'R1', status: 'COMPLETED', amount: 4 })
  const r = await finalizeOrder('ORDER1')
  expect(createBooking).not.toHaveBeenCalled()
  expect(r).toMatchObject({ status: 'refunded', reason: 'AMOUNT_MISMATCH' })
})

test('PENDING capture waits for the webhook and keeps the intent', async () => {
  provider.capture.mockResolvedValue({ ...capture, captureStatus: 'PENDING' })
  const r = await finalizeOrder('ORDER1')
  expect(r.status).toBe('pending')
  expect(consumePendingPayment).not.toHaveBeenCalled()
})

test('declined instrument lets the buyer retry (intent kept)', async () => {
  provider.capture.mockRejectedValue(Object.assign(new Error('x'), { code: 'INSTRUMENT_DECLINED' }))
  const r = await finalizeOrder('ORDER1')
  expect(r).toMatchObject({ status: 'declined', retry: true })
  expect(consumePendingPayment).not.toHaveBeenCalled()
})

test('a failure AFTER the booking exists (notify/index) never refunds it', async () => {
  saveResult.mockRejectedValueOnce(new Error('dynamo blip'))
  notifyCustomer.mockRejectedValueOnce(new Error('ses down'))
  const r = await finalizeOrder('ORDER1')
  expect(r.status).toBe('confirmed')
  expect(provider.refund).not.toHaveBeenCalled()
})

test('connected business: booking records the payee and a failed booking refunds on its behalf', async () => {
  getPendingPayment.mockResolvedValue({ ...pending, payeeMerchantId: 'SALON1' })
  consumePendingPayment.mockResolvedValue({ ...pending, payeeMerchantId: 'SALON1' })
  createBooking.mockRejectedValueOnce(new Error('slot was just taken by another customer'))
  provider.refund.mockResolvedValue({ refundId: 'R1', status: 'COMPLETED', amount: 40 })
  await finalizeOrder('ORDER1')
  expect(createBooking.mock.calls[0][0].payment.payeeMerchantId).toBe('SALON1')
  expect(provider.refund).toHaveBeenCalledWith(expect.objectContaining({ merchantId: 'SALON1' }))
})

test('the finalize steps land on the customer\'s timeline (scope saved at checkout)', async () => {
  const trace = require('../services/trace')
  const sink = trace.memorySink()
  trace.setSink(sink)
  const scoped = { ...pending, traceScope: 'sess:judge1' }
  getPendingPayment.mockResolvedValue(scoped)
  consumePendingPayment.mockResolvedValue(scoped)
  await finalizeOrder('ORDER1', { source: 'return' })
  trace.setSink(null)
  const titles = sink.events.filter(e => e.scope === 'sess:judge1').map(e => e.title)
  expect(titles).toEqual(expect.arrayContaining([
    'Buyer approved → back from PayPal',
    'Seat re-checked before charging: still free ✓',
    'Exactly-once claim won (conditional delete)'
  ]))
  expect(titles.indexOf('Seat re-checked before charging: still free ✓')).toBeLessThan(titles.indexOf('Exactly-once claim won (conditional delete)'))
})

test('notes saved at booking time travel from the payment hold onto the booking', async () => {
  const note = 'From a doctor note (PDF): allergic to ammonia'
  getPendingPayment.mockResolvedValue({ ...pending, customerNotes: note })
  consumePendingPayment.mockResolvedValue({ ...pending, customerNotes: note })
  await finalizeOrder('ORDER-NOTES')
  expect(createBooking.mock.calls[0][0].notes).toBe(note)
})

test('reference photos travel from the payment hold onto the booking too', async () => {
  getPendingPayment.mockResolvedValue({ ...pending, customerPhotos: ['ph_abc123xyz'] })
  consumePendingPayment.mockResolvedValue({ ...pending, customerPhotos: ['ph_abc123xyz'] })
  await finalizeOrder('ORDER-PHOTOS')
  expect(createBooking.mock.calls[0][0].photos).toEqual(['ph_abc123xyz'])
})

// ── Saved PayPal ──
describe('saved PayPal', () => {
  const savedPaypal = require('../core/savedPaypal')

  test('a first payment the buyer agreed to save: the account is kept for one-step booking', async () => {
    provider.capture.mockResolvedValue({ ...capture, savedPaypal: { vaultId: 'VAULT1', email: 'john.doe@example.com' } })
    const r = await finalizeOrder('ORDER1')
    expect(savedPaypal.remember).toHaveBeenCalledWith('c1', { vaultId: 'VAULT1', email: 'john.doe@example.com' })
    expect(r).toMatchObject({ status: 'confirmed', savedPaypal: 'j***@example.com' })
  })

  test('no consent to save: nothing is kept', async () => {
    await finalizeOrder('ORDER1')
    expect(savedPaypal.remember).not.toHaveBeenCalled()
  })

  test('paid with the saved PayPal (already captured): no second capture, booking made', async () => {
    const r = await finalizeOrder('ORDER1', { source: 'saved', captured: capture })
    expect(provider.capture).not.toHaveBeenCalled()
    expect(getFreeUnitsForSlot).not.toHaveBeenCalled()
    expect(createBooking).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'CAP1' }))
    expect(r).toMatchObject({ status: 'confirmed' })
  })

  test('already captured but the booking fails → refunded in full automatically', async () => {
    createBooking.mockRejectedValue(Object.assign(new Error('taken'), { code: 'SLOT_TAKEN' }))
    provider.refund.mockResolvedValue({ refundId: 'R1' })
    const r = await finalizeOrder('ORDER1', { source: 'saved', captured: capture })
    expect(provider.refund).toHaveBeenCalledWith(expect.objectContaining({ captureId: 'CAP1', amount: 40 }))
    expect(r).toMatchObject({ status: 'refunded', refunded: true })
  })
})
