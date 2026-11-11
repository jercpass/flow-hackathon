'use strict'

// PayPal adapter for saved PayPal (Vault v3) on PayPal's server SDK: save on the
// first payment, pay with the saved account, save another account without
// paying, remove it. PayPal is stubbed below the SDK (paypalSdkStub).

const paypal = require('../services/payments/paypal')
const { stubPayPal, paypalError } = require('./paypalSdkStub')

const business = { name: 'Willow & Co.' }

let pp
beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = 'id'
  process.env.PAYPAL_CLIENT_SECRET = 'secret'
  process.env.PAYPAL_ENV = 'sandbox'
  paypal._resetTokenCache()
  pp = stubPayPal()
})

const paidOrder = vault => ({
  id: 'ORDER9', status: 'COMPLETED',
  payment_source: { paypal: { email_address: 'john.doe@example.com', ...(vault ? { attributes: { vault } } : {}) } },
  purchase_units: [{ custom_id: 'flow_1', amount: { currency_code: 'USD', value: '30.00' }, payments: { captures: [{ id: 'CAP9', status: 'COMPLETED', amount: { currency_code: 'USD', value: '30.00' } }] } }]
})

test('first payment asks PayPal to save the account; without saveForLater it does not', async () => {
  pp.on('POST', '/v2/checkout/orders', { body: { id: 'O1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://pp/approve' }] } })
  await paypal.createCheckout({ referenceId: 'flow_1', amount: 30, currency: 'USD', business, returnUrl: 'r', cancelUrl: 'c', saveForLater: true })
  expect(pp.requests[0].body.payment_source.paypal.attributes).toEqual({ vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } })

  await paypal.createCheckout({ referenceId: 'flow_2', amount: 30, currency: 'USD', business, returnUrl: 'r', cancelUrl: 'c' })
  expect(pp.requests[1].body.payment_source.paypal.attributes).toBeUndefined()
})

test('the capture carries the saved account (vault id + email) only when PayPal vaulted it', async () => {
  pp.once('POST', '/v2/checkout/orders/ORDER9/capture', { body: paidOrder({ id: 'VAULT1', status: 'VAULTED', customer: { id: 'PPC1' } }) })
  expect((await paypal.capture('ORDER9')).savedPaypal).toEqual({ vaultId: 'VAULT1', email: 'john.doe@example.com' })

  pp.once('POST', '/v2/checkout/orders/ORDER9/capture', { body: paidOrder(null) })
  expect((await paypal.capture('ORDER9')).savedPaypal).toBeNull()

  pp.once('POST', '/v2/checkout/orders/ORDER9/capture', { body: paidOrder({ id: 'VAULT1', status: 'APPROVED' }) })
  expect((await paypal.capture('ORDER9')).savedPaypal).toBeNull()
})

test('chargeSaved pays with the vault id; COMPLETED comes back captured', async () => {
  pp.on('POST', '/v2/checkout/orders', { body: paidOrder(null) })
  const r = await paypal.chargeSaved({ referenceId: 'flow_1', amount: 30, currency: 'USD', business, vaultId: 'VAULT1', returnUrl: 'r', cancelUrl: 'c' })
  const req = pp.requests[0]
  expect(req.body.payment_source.paypal.vault_id).toBe('VAULT1')
  expect(req.headers['paypal-request-id']).toBe('ordv_flow_1')
  expect(r).toMatchObject({ providerOrderId: 'ORDER9', approveUrl: null, captured: { captureId: 'CAP9', captureStatus: 'COMPLETED', amount: 30 } })
})

test('chargeSaved: PayPal wants the buyer again → the approve link, nothing captured', async () => {
  pp.on('POST', '/v2/checkout/orders', { body: { id: 'O2', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://pp/again' }] } })
  const r = await paypal.chargeSaved({ referenceId: 'flow_2', amount: 30, currency: 'USD', business, vaultId: 'VAULT1' })
  expect(r).toMatchObject({ captured: null, approveUrl: 'https://pp/again' })
})

test('change account: setup token link, then exchanged for the new vault id', async () => {
  pp.on('POST', '/v3/vault/setup-tokens', { body: { id: 'SETUP1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'approve', href: 'https://pp/setup' }] } })
  const s = await paypal.createVaultSetup({ requestId: 'c1-x', returnUrl: 'r', cancelUrl: 'c' })
  expect(s).toEqual({ setupTokenId: 'SETUP1', approveUrl: 'https://pp/setup' })
  const setup = pp.last('POST', '/v3/vault/setup-tokens')
  expect(setup.headers['paypal-request-id']).toBe('setup_c1-x')
  expect(setup.body.payment_source.paypal).toMatchObject({ usage_type: 'MERCHANT', customer_type: 'CONSUMER', permit_multiple_payment_tokens: false, experience_context: { shipping_preference: 'NO_SHIPPING', return_url: 'r', cancel_url: 'c' } })

  pp.on('POST', '/v3/vault/payment-tokens', { body: { id: 'VAULT2', payment_source: { paypal: { email_address: 'other@example.com' } } } })
  expect(await paypal.finishVaultSetup('SETUP1')).toEqual({ vaultId: 'VAULT2', email: 'other@example.com' })
  expect(pp.last('POST', '/v3/vault/payment-tokens').body).toEqual({ payment_source: { token: { id: 'SETUP1', type: 'SETUP_TOKEN' } } })
})

test('remove: deletes the payment token; already gone at PayPal counts as removed', async () => {
  pp.once('DELETE', '/v3/vault/payment-tokens/VAULT1', { status: 204, body: '' })
  await expect(paypal.deleteSaved('VAULT1')).resolves.toEqual({ removed: true })
  expect(pp.requests[0]).toMatchObject({ method: 'DELETE', path: '/v3/vault/payment-tokens/VAULT1' })

  pp.once('DELETE', '/v3/vault/payment-tokens/VAULT1', paypalError(404, 'RESOURCE_NOT_FOUND'))
  await expect(paypal.deleteSaved('VAULT1')).resolves.toEqual({ removed: true })

  pp.once('DELETE', '/v3/vault/payment-tokens/VAULT1', paypalError(500, 'INTERNAL_SERVER_ERROR'))
  await expect(paypal.deleteSaved('VAULT1')).rejects.toMatchObject({ status: 500 })
})
