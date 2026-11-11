'use strict'

// The money path on PayPal's server SDK (APIMatic-generated): orders, captures,
// refunds and payment lookups. PayPal is stubbed below the SDK (paypalSdkStub),
// so each test checks the JSON the SDK really sends and parses PayPal's own JSON.

const paypal = require('../services/payments/paypal')
const { stubPayPal, paypalError } = require('./paypalSdkStub')

const completedOrder = {
  id: 'ORDER1',
  status: 'COMPLETED',
  payer: { email_address: 'buyer@example.com', name: { given_name: 'Ana', surname: 'Lee' } },
  purchase_units: [{
    custom_id: 'flow_abc',
    amount: { currency_code: 'USD', value: '40.00' },
    payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '40.00' }, create_time: '2026-10-16T10:00:00Z' }] }
  }]
}
const usd = value => ({ currency_code: 'USD', value })

let pp
beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = 'id'
  process.env.PAYPAL_CLIENT_SECRET = 'secret'
  process.env.PAYPAL_ENV = 'sandbox'
  delete process.env.PAYPAL_BN_CODE
  paypal._resetTokenCache()
  pp = stubPayPal()
})

test('createCheckout sends a CAPTURE order with our reference and returns the payer-action link', async () => {
  pp.on('POST', '/v2/checkout/orders', { body: { id: 'ORDER1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER1' }] } })

  const r = await paypal.createCheckout({
    referenceId: 'flow_abc', amount: 40, currency: 'USD', description: 'Haircut',
    business: { name: "Ana's Salon!", paypalMerchantId: 'MERCH1' }, returnUrl: 'https://r', cancelUrl: 'https://c'
  })

  expect(r).toEqual({ providerOrderId: 'ORDER1', approveUrl: 'https://sandbox.paypal.com/checkoutnow?token=ORDER1', status: 'PAYER_ACTION_REQUIRED' })
  const req = pp.last('POST', '/v2/checkout/orders')
  expect(req.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders')
  expect(req.headers['paypal-request-id']).toBe('ord_flow_abc')
  expect(req.headers.prefer).toBe('return=representation')
  expect(req.headers.authorization).toBe('Bearer sdk-token')
  expect(req.body.intent).toBe('CAPTURE')
  const unit = req.body.purchase_units[0]
  expect(unit.custom_id).toBe('flow_abc')
  expect(unit.amount).toEqual({ currency_code: 'USD', value: '40.00' })
  expect(unit.payee).toEqual({ merchant_id: 'MERCH1' })
  expect(unit.soft_descriptor).toBe('Anas Salon')
  expect(req.body.payment_source.paypal.experience_context).toMatchObject({ return_url: 'https://r', cancel_url: 'https://c', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', landing_page: 'LOGIN' })
})

test('the partner attribution (BN) code rides on orders when set', async () => {
  process.env.PAYPAL_BN_CODE = 'FLOW_SP'
  pp.on('POST', '/v2/checkout/orders', { body: { id: 'O', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://pp' }] } })
  await paypal.createCheckout({ referenceId: 'flow_bn', amount: 10, currency: 'USD', returnUrl: 'r', cancelUrl: 'c' })
  expect(pp.last('POST', '/v2/checkout/orders').headers['paypal-partner-attribution-id']).toBe('FLOW_SP')
})

test('the SDK fetches its access token once and reuses it', async () => {
  pp.on('GET', '/v2/checkout/orders/ORDER1', { body: completedOrder })
  await paypal.getOrder('ORDER1')
  await paypal.getOrder('ORDER1')
  expect(pp.tokenCalls()).toBe(1)
  expect(pp.requests).toHaveLength(2)
})

test('capture normalises the capture and is idempotent on ORDER_ALREADY_CAPTURED', async () => {
  pp.once('POST', '/v2/checkout/orders/ORDER1/capture', { body: completedOrder })
  const first = await paypal.capture('ORDER1')
  expect(first).toMatchObject({ captureId: 'CAP1', captureStatus: 'COMPLETED', amount: 40, currency: 'USD', referenceId: 'flow_abc', payerEmail: 'buyer@example.com', payerName: 'Ana Lee', paidAt: '2026-10-16T10:00:00Z' })
  expect(pp.last('POST', '/v2/checkout/orders/ORDER1/capture').headers['paypal-request-id']).toBe('cap_ORDER1')

  pp.once('POST', '/v2/checkout/orders/ORDER1/capture', paypalError(422, 'ORDER_ALREADY_CAPTURED'))
  pp.on('GET', '/v2/checkout/orders/ORDER1', { body: completedOrder })
  const second = await paypal.capture('ORDER1')
  expect(second.captureId).toBe('CAP1')
  expect(pp.requests.map(r => r.method)).toEqual(['POST', 'POST', 'GET'])
})

test('capture surfaces other PayPal errors with the issue as code', async () => {
  pp.on('POST', '/v2/checkout/orders/ORDER1/capture', paypalError(422, 'INSTRUMENT_DECLINED'))
  await expect(paypal.capture('ORDER1')).rejects.toMatchObject({ code: 'INSTRUMENT_DECLINED', status: 422, debugId: 'dbg1' })
})

test('refund sends a partial amount with a stable request id', async () => {
  pp.on('POST', '/v2/payments/captures/CAP1/refund', { body: { id: 'REF1', status: 'COMPLETED', amount: usd('24.00') } })
  const r = await paypal.refund({ captureId: 'CAP1', amount: 24, currency: 'USD', requestId: 'ref_appt1', note: '60% refund' })
  expect(r).toEqual({ refundId: 'REF1', status: 'COMPLETED', amount: 24, currency: 'USD' })
  const req = pp.last('POST', '/v2/payments/captures/CAP1/refund')
  expect(req.url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/CAP1/refund')
  expect(req.headers['paypal-request-id']).toBe('ref_appt1')
  expect(req.headers['paypal-auth-assertion']).toBeUndefined()
  expect(req.body).toEqual({ amount: { currency_code: 'USD', value: '24.00' }, note_to_payer: '60% refund' })
})

test('refund for a connected business acts on its behalf via PayPal-Auth-Assertion', async () => {
  pp.on('POST', '/v2/payments/captures/CAP1/refund', { body: { id: 'REF2', status: 'COMPLETED', amount: usd('40.00') } })
  await paypal.refund({ captureId: 'CAP1', amount: 40, currency: 'USD', requestId: 'ref_a2', merchantId: 'SALON1' })
  const [h, p, sig] = pp.last('POST', '/v2/payments/captures/CAP1/refund').headers['paypal-auth-assertion'].split('.')
  expect(JSON.parse(Buffer.from(h, 'base64url'))).toEqual({ alg: 'none' })
  expect(JSON.parse(Buffer.from(p, 'base64url'))).toEqual({ iss: 'id', payer_id: 'SALON1' })
  expect(sig).toBe('')
})

test('getRefund reads a refund back', async () => {
  pp.on('GET', '/v2/payments/refunds/REF1', { body: { id: 'REF1', status: 'PENDING', amount: usd('12.50') } })
  expect(await paypal.getRefund('REF1')).toEqual({ refundId: 'REF1', status: 'PENDING', amount: 12.5, currency: 'USD' })
})

test('getPayment reads the order: PayPal fee, net and every refund (cancelled ones ignored)', async () => {
  const unit = completedOrder.purchase_units[0]
  pp.on('GET', '/v2/checkout/orders/ORDER1', { body: { ...completedOrder, purchase_units: [{ ...unit, payments: {
    captures: [{ ...unit.payments.captures[0], status: 'PARTIALLY_REFUNDED', seller_receivable_breakdown: { gross_amount: usd('40.00'), paypal_fee: usd('1.89'), net_amount: usd('38.11') } }],
    refunds: [
      { id: 'R1', status: 'COMPLETED', amount: usd('20.00'), create_time: '2026-10-16T11:00:00Z' },
      { id: 'R2', status: 'CANCELLED', amount: usd('5.00') }
    ]
  } }] } })
  const r = await paypal.getPayment({ providerOrderId: 'ORDER1', captureId: 'CAP1' })
  // (The SDK leaves an empty "?" for the optional fields= parameter; PayPal ignores it.)
  expect(pp.requests[0]).toMatchObject({ method: 'GET', path: '/v2/checkout/orders/ORDER1' })
  expect(new URL(pp.requests[0].url).host).toBe('api-m.sandbox.paypal.com')
  expect(r).toMatchObject({ captureId: 'CAP1', captureStatus: 'PARTIALLY_REFUNDED', amount: 40, fee: 1.89, net: 38.11, refundedTotal: 20 })
  expect(r.refunds).toEqual([
    { refundId: 'R1', status: 'COMPLETED', amount: 20, createdAt: '2026-10-16T11:00:00Z' },
    { refundId: 'R2', status: 'CANCELLED', amount: 5, createdAt: null }
  ])
})

test('getPayment falls back to the capture when the order id is unknown', async () => {
  pp.on('GET', '/v2/payments/captures/CAP1', { body: { id: 'CAP1', status: 'COMPLETED', amount: usd('40.00'), seller_receivable_breakdown: { gross_amount: usd('40.00'), paypal_fee: usd('1.89'), net_amount: usd('38.11') }, supplementary_data: { related_ids: { order_id: 'ORDER1' } }, payee: { merchant_id: 'SALON1' } } })
  const r = await paypal.getPayment({ providerOrderId: null, captureId: 'CAP1' })
  expect(pp.requests[0].url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/CAP1')
  expect(r).toMatchObject({ providerOrderId: 'ORDER1', captureStatus: 'COMPLETED', fee: 1.89, net: 38.11, payeeMerchantId: 'SALON1', refunds: null, refundedTotal: null })
})

test('saved PayPal charges say who started them: the customer (with risk data) or Flow under agreed terms', async () => {
  pp.on('POST', '/v2/checkout/orders', { body: completedOrder })
  const base = { referenceId: 'flow_abc', amount: 40, currency: 'USD', description: 'Haircut', business: { name: 'Willow' }, vaultId: 'V1', returnUrl: 'https://r', cancelUrl: 'https://c' }

  await paypal.chargeSaved({ ...base, clientMetadataId: 'cmid123' })
  let req = pp.requests[0]
  expect(req.body.payment_source.paypal).toMatchObject({ vault_id: 'V1', stored_credential: { payment_initiator: 'CUSTOMER' } })
  expect(req.body.payment_source.paypal.stored_credential.usage_pattern).toBeUndefined()
  expect(req.headers['paypal-client-metadata-id']).toBe('cmid123')

  await paypal.chargeSaved({ ...base, initiator: 'MERCHANT', usagePattern: 'UNSCHEDULED_PREPAID', invoiceId: 'pm_123', clientMetadataId: 'cmid123' })
  req = pp.requests[1]
  expect(req.body.payment_source.paypal.stored_credential).toEqual({ payment_initiator: 'MERCHANT', usage_pattern: 'UNSCHEDULED_PREPAID' })
  expect(req.body.purchase_units[0].invoice_id).toBe('pm_123')
  // Risk data belongs to a customer in a browser, not to a charge Flow starts.
  expect(req.headers['paypal-client-metadata-id']).toBeUndefined()
})

test('a network failure reaches the caller as it is (not dressed up as a PayPal error)', async () => {
  const sdk = require('../services/payments/paypalSdk')
  sdk._useAdapter(async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
  await expect(paypal.getOrder('ORDER1')).rejects.toMatchObject({ message: expect.stringMatching(/socket hang up/) })
})

describe('memberships (Subscriptions)', () => {
  test('a plan: the catalog product over REST (not in the SDK), then the monthly plan on the SDK', async () => {
    // Flow's own REST calls use axios's default adapter: point it at the same stub.
    const axios = require('axios')
    const before = axios.defaults.adapter
    axios.defaults.adapter = pp.adapter
    try {
      pp.on('POST', '/v1/catalogs/products', { body: { id: 'PROD1', name: 'Willow: Cut Club' } })
      pp.on('POST', '/v1/billing/plans', { body: { id: 'PLAN1', status: 'ACTIVE' } })
      const r = await paypal.createMembershipPlan({ name: 'Cut Club', price: 35, currency: 'USD', businessName: 'Willow', requestId: 'm1' })
      expect(r).toEqual({ productId: 'PROD1', planId: 'PLAN1' })
      const plan = pp.last('POST', '/v1/billing/plans')
      expect(plan.headers['paypal-request-id']).toBe('plan_m1')
      expect(plan.body).toEqual({
        product_id: 'PROD1', name: 'Cut Club', status: 'ACTIVE',
        billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { currency_code: 'USD', value: '35.00' } } }],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 }
      })
      expect(pp.last('POST', '/v1/catalogs/products').body).toMatchObject({ name: 'Willow: Cut Club', type: 'SERVICE' })
    } finally {
      axios.defaults.adapter = before
    }
  })

  test('subscribing returns the approve link; customId and the return URLs go to PayPal', async () => {
    pp.on('POST', '/v1/billing/subscriptions', { body: { id: 'I-SUB1', status: 'APPROVAL_PENDING', links: [{ rel: 'approve', href: 'https://pp/sub' }, { rel: 'self', href: 'x' }] } })
    const r = await paypal.createSubscription({ planId: 'PLAN1', customId: 'mem_1', businessName: 'Willow', returnUrl: 'https://r', cancelUrl: 'https://c' })
    expect(r).toEqual({ subscriptionId: 'I-SUB1', approveUrl: 'https://pp/sub', status: 'APPROVAL_PENDING' })
    const req = pp.last('POST', '/v1/billing/subscriptions')
    expect(req.headers['paypal-request-id']).toBe('sub_mem_1')
    expect(req.body).toEqual({ plan_id: 'PLAN1', custom_id: 'mem_1', application_context: { brand_name: 'Willow', user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: 'https://r', cancel_url: 'https://c' } })
  })

  test('a subscription is read back, and cancelled with a reason', async () => {
    pp.on('GET', '/v1/billing/subscriptions/I-SUB1', { body: {
      id: 'I-SUB1', status: 'ACTIVE', plan_id: 'PLAN1', custom_id: 'mem_1', subscriber: { email_address: 'john@example.com' },
      billing_info: { outstanding_balance: usd('0.00'), failed_payments_count: 0, next_billing_time: '2026-12-03T10:00:00Z', last_payment: { amount: usd('35.00'), time: '2026-11-03T10:00:00Z' } }
    } })
    expect(await paypal.getSubscription('I-SUB1')).toEqual({
      subscriptionId: 'I-SUB1', status: 'ACTIVE', planId: 'PLAN1', customId: 'mem_1', nextBillingTime: '2026-12-03T10:00:00Z',
      lastPayment: { amount: 35, time: '2026-11-03T10:00:00Z' }, failedPayments: 0, payerEmail: 'john@example.com'
    })

    pp.on('POST', '/v1/billing/subscriptions/I-SUB1/cancel', { status: 204, body: '' })
    expect(await paypal.cancelSubscription('I-SUB1', 'Moving away')).toEqual({ subscriptionId: 'I-SUB1', status: 'CANCELLED' })
    expect(pp.last('POST', '/v1/billing/subscriptions/I-SUB1/cancel').body).toEqual({ reason: 'Moving away' })
  })
})

test('every SDK-backed step says so on the Under the hood timeline', () => {
  const src = require('fs').readFileSync(require.resolve('../services/payments/paypal'), 'utf8')
  for (const fn of ['createCheckout', 'capture', 'chargeSaved', 'createVaultSetup', 'finishVaultSetup', 'deleteSaved', 'refund', 'getPayment', 'createMembershipPlan', 'createSubscription', 'getSubscription', 'cancelSubscription']) {
    expect(src).toMatch(new RegExp(`\\b${fn}:\\s+viaSdk\\(`))
  }
})
