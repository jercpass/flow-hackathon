'use strict'

jest.mock('../services/dynamo/appointments', () => ({ updateAppointment: jest.fn() }))
jest.mock('../services/payments', () => {
  const provider = { id: 'paypal', refund: jest.fn() }
  return { getProviderById: jest.fn(() => provider), providerIdFor: () => 'paypal', __provider: provider }
})

const { quoteRefund, refundAppointment } = require('../core/refunds')
const { updateAppointment } = require('../services/dynamo/appointments')
const provider = require('../services/payments').__provider

const NOW = Date.parse('2026-10-16T12:00:00Z')
const inHours = h => new Date(NOW + h * 3_600_000).toISOString()
// Typical dashboard schedule: 48h+ → 100%, 24h+ → 50%, under 24h → 0%
const TIERS = [{ hoursBefore: 24, refundPct: 50 }, { hoursBefore: 48, refundPct: 100 }, { hoursBefore: 0, refundPct: 0 }]

describe('quoteRefund', () => {
  test.each([
    [72, 100, 40],
    [48, 100, 40],      // exactly on the boundary → that tier applies
    [47.9, 50, 20],
    [24, 50, 20],
    [5, 0, 0],
    [-1, 0, 0]          // after start / no-show
  ])('%sh before start → %s%% = $%s', (h, pct, amount) => {
    const q = quoteRefund({ amountPaid: 40, startTime: inHours(h) }, TIERS, NOW)
    expect(q.pct).toBe(pct)
    expect(q.amount).toBe(amount)
  })

  test('no tiers configured → full refund before start', () => {
    expect(quoteRefund({ amountPaid: 40, startTime: inHours(2) }, [], NOW)).toMatchObject({ pct: 100, amount: 40 })
    expect(quoteRefund({ amountPaid: 40, startTime: inHours(2) }, undefined, NOW)).toMatchObject({ pct: 100, amount: 40 })
  })

  test('already-refunded part is excluded and cents are rounded', () => {
    const q = quoteRefund({ amountPaid: 33.33, refundAmount: 10, startTime: inHours(30) }, TIERS, NOW)
    expect(q.refundable).toBe(23.33)
    expect(q.amount).toBe(11.67)
  })

  test('unpaid booking → nothing to refund', () => {
    expect(quoteRefund({ amountPaid: 0, startTime: inHours(100) }, TIERS, NOW).amount).toBe(0)
  })
})

describe('refundAppointment', () => {
  const business = { businessId: 'b1', name: 'Demo Salon', config: { currency: 'USD' } }
  const appt = { appointmentId: 'a1', startTime: inHours(30), amountPaid: 40, paymentId: 'CAP1', paymentProvider: 'paypal', currency: 'USD', serviceName: 'Haircut' }

  beforeEach(() => jest.clearAllMocks())

  test('refunds through the capturing provider with a stable request id and records it', async () => {
    provider.refund.mockResolvedValue({ refundId: 'R1', status: 'COMPLETED', amount: 20, currency: 'USD' })
    const r = await refundAppointment({ business, appointment: appt, amount: 20, reason: '50% refund' })
    expect(provider.refund).toHaveBeenCalledWith(expect.objectContaining({ captureId: 'CAP1', amount: 20, currency: 'USD', requestId: 'ref_a1' }))
    expect(r).toMatchObject({ refunded: true, amount: 20, refundId: 'R1' })
    expect(updateAppointment).toHaveBeenCalledWith('b1', appt.startTime, 'a1', expect.objectContaining({ refundAmount: 20, paymentStatus: 'partially_refunded', refundStatus: 'COMPLETED' }))
  })

  test('full refund marks the appointment refunded', async () => {
    provider.refund.mockResolvedValue({ refundId: 'R1', status: 'COMPLETED', amount: 40, currency: 'USD' })
    await refundAppointment({ business, appointment: appt, amount: 40 })
    expect(updateAppointment.mock.calls[0][3].paymentStatus).toBe('refunded')
  })

  test('zero amount or no payment on record never calls the provider', async () => {
    expect(await refundAppointment({ business, appointment: appt, amount: 0 })).toMatchObject({ refunded: false })
    expect(await refundAppointment({ business, appointment: { ...appt, paymentId: null }, amount: 10 })).toMatchObject({ refunded: false, manual: true })
    expect(provider.refund).not.toHaveBeenCalled()
  })
})
