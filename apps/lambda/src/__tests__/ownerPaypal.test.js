'use strict'

// PayPal on the owner's AI: run by Flow's backend (no token from the owner),
// read-only, checked live against PayPal and compared with Flow's records.

jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), createAppointment: jest.fn(), updateAppointment: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn().mockResolvedValue(null) }))
jest.mock('../services/payments/paypal', () => ({ getPayment: jest.fn(), getMerchantStatus: jest.fn() }))

const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const paypal = require('../services/payments/paypal')
const op = require('../core/ownerPaypal')
const { BUSINESS_TOOLS } = require('../mcp/sessionServers')

const business = { businessId: 'b1', name: 'Willow & Co.', timezone: 'America/Chicago', config: { currency: 'USD', services: [], staff: [] } }
const soon = new Date(Date.now() + 86_400_000).toISOString()
const appt = over => ({ appointmentId: 'appt-0001-aaaa', startTime: soon, serviceName: 'Haircut', customerName: 'Sam Rivera', status: 'confirmed', amountPaid: 40, currency: 'USD', paymentProvider: 'paypal', paymentId: 'CAP1', providerOrderId: 'ORDER1', createdAt: '2026-10-16T10:00:00Z', ...over })
const record = over => ({ providerOrderId: 'ORDER1', captureId: 'CAP1', captureStatus: 'COMPLETED', amount: 40, currency: 'USD', fee: 1.89, net: 38.11, refunds: [], refundedTotal: 0, payerName: 'Sam Rivera', payerEmail: 'sam@example.com', ...over })

beforeEach(() => {
  jest.clearAllMocks()
  process.env.PAYPAL_CLIENT_ID = 'id'
  process.env.PAYPAL_CLIENT_SECRET = 'secret'
  delete process.env.PAYPAL_ENV
})

test('the business link offers the PayPal tools, and none of them move money', () => {
  const names = BUSINESS_TOOLS.map(t => t.name)
  expect(names).toEqual(expect.arrayContaining(['paypal_account', 'paypal_payments', 'paypal_payment']))
  for (const t of BUSINESS_TOOLS.filter(x => x.name.startsWith('paypal_'))) expect(Object.keys(t.properties)).not.toContain('confirm')
})

test('paypal_payments: live fees and net from PayPal, seeded history labelled, mismatches flagged', async () => {
  getAppointmentsForBusiness.mockResolvedValue([
    appt(),
    appt({ appointmentId: 'bppt-0002-bbbb', paymentId: 'CAP2', providerOrderId: 'ORDER2', refundAmount: 20, createdAt: '2026-10-16T11:00:00Z' }),
    appt({ appointmentId: 'hist-0003-cccc', paymentId: 'hist-xyz', providerOrderId: null, seeded: true, createdAt: '2026-09-01T10:00:00Z' }),
    appt({ appointmentId: 'blk-0004', status: 'blocked', amountPaid: 0 })
  ])
  // PayPal hasn't recorded the second booking's refund (Flow says $20 back).
  paypal.getPayment.mockImplementation(async ({ providerOrderId }) => providerOrderId === 'ORDER1'
    ? record()
    : record({ providerOrderId: 'ORDER2', captureId: 'CAP2' }))

  const r = await op.paypalPayments(business, { days: 7 })
  expect(paypal.getPayment).toHaveBeenCalledTimes(2)                       // the seeded visit is never looked up
  expect(paypal.getPayment).toHaveBeenCalledWith({ providerOrderId: 'ORDER1', captureId: 'CAP1' })
  expect(r.checked_with_paypal).toBe(2)
  expect(r.totals_from_paypal).toEqual({ gross: '$80', paypal_fees: '$3.78', net_to_business: '$76.22', refunded: '$0' })
  expect(r.out_of_sync).toEqual(['bppt-000'])
  const [newest, first, seeded] = r.payments
  expect(newest).toMatchObject({ in_sync: false, mismatch: { flow_refunded: 20, paypal_refunded: 0 } })
  expect(first).toMatchObject({ in_sync: true, paypal: { status: 'COMPLETED', gross: '$40', paypal_fee: '$1.89', net_to_business: '$38.11' } })
  expect(seeded).toMatchObject({ paypal: null, note: expect.stringMatching(/never charged through PayPal/) })
})

test('paypal_payment: full record with masked payer email; unknown booking is a clear error', async () => {
  getAppointmentsForBusiness.mockResolvedValue([appt({ refundAmount: 20 })])
  paypal.getPayment.mockResolvedValue(record({ captureStatus: 'PARTIALLY_REFUNDED', refundedTotal: 20, refunds: [{ refundId: 'R1', status: 'COMPLETED', amount: 20, createdAt: 't' }] }))
  const r = await op.paypalPayment(business, { booking_id: 'appt-0001' })
  expect(r).toMatchObject({ in_sync: true, paypal: { status: 'PARTIALLY_REFUNDED', payer_email: 's***@example.com', payee: "Flow's platform sandbox account", refunds: [{ refund_id: 'R1', amount: '$20' }] } })
  expect(await op.paypalPayment(business, { booking_id: 'nope-nope' })).toEqual({ error: expect.stringMatching(/No booking/) })
})

test('a failed PayPal lookup is reported per payment, not thrown', async () => {
  getAppointmentsForBusiness.mockResolvedValue([appt()])
  paypal.getPayment.mockRejectedValue(Object.assign(new Error('PayPal 404'), { code: 'RESOURCE_NOT_FOUND' }))
  const r = await op.paypalPayments(business)
  expect(r.payments[0]).toMatchObject({ paypal: null, note: 'PayPal lookup failed (RESOURCE_NOT_FOUND)' })
})

test('paypal_account: connected business verified with PayPal; demo business explains the platform account', async () => {
  paypal.getMerchantStatus.mockResolvedValue({ paymentsReceivable: true, emailConfirmed: true, email: 'owner@willow.test', canRefund: true })
  const c = await op.paypalAccount({ ...business, paypalMerchantId: 'MERCHANT123' })
  expect(c).toMatchObject({ connected: true, merchant_id: 'MER…123', payments_receivable: true, can_refund_on_your_behalf: true, email: 'o***@willow.test' })
  const d = await op.paypalAccount(business)
  expect(d).toMatchObject({ connected: false, environment: 'sandbox', paid_into: expect.stringMatching(/demo PayPal sandbox account/) })
  expect(paypal.getMerchantStatus).toHaveBeenCalledTimes(1)
})

test('without PayPal keys the tools say so instead of failing', async () => {
  delete process.env.PAYPAL_CLIENT_ID
  expect(await op.paypalPayments(business)).toEqual({ error: expect.stringMatching(/isn't set up/) })
  expect(paypal.getPayment).not.toHaveBeenCalled()
})
