'use strict'

// The PayPal calls the server SDK doesn't cover, made over plain REST: webhook
// verification, Partner Referrals onboarding and merchant status. The money
// path (orders, captures, refunds, saved PayPal) is in paypalSdk.test.js.

jest.mock('axios')
const axios = require('axios')
const paypal = require('../services/payments/paypal')

const TOKEN = { data: { access_token: 'tok', expires_in: 32400 } }

beforeEach(() => {
  jest.resetAllMocks()
  paypal._resetTokenCache()
  process.env.PAYPAL_CLIENT_ID = 'id'
  process.env.PAYPAL_CLIENT_SECRET = 'secret'
  process.env.PAYPAL_ENV = 'sandbox'
  process.env.PAYPAL_WEBHOOK_ID = 'WH1'
  axios.post.mockResolvedValue(TOKEN)
})

test('verifyWebhook splices the raw body verbatim and checks SUCCESS', async () => {
  const raw = '{"id":"WH-EVT","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP1"}}'
  axios.post.mockResolvedValueOnce(TOKEN).mockResolvedValueOnce({ data: { verification_status: 'SUCCESS' } })
  const ok = await paypal.verifyWebhook({
    'PAYPAL-AUTH-ALGO': 'SHA256withRSA', 'Paypal-Cert-Url': 'https://cert', 'paypal-transmission-id': 't1',
    'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-10-16T10:00:00Z'
  }, raw)
  expect(ok).toBe(true)
  const sent = axios.post.mock.calls[1][1]
  expect(sent.endsWith(`"webhook_event":${raw}}`)).toBe(true)
  expect(JSON.parse(sent)).toMatchObject({ webhook_id: 'WH1', transmission_id: 't1', auth_algo: 'SHA256withRSA' })
})

test('verifyWebhook rejects missing signature headers without calling PayPal', async () => {
  expect(await paypal.verifyWebhook({}, '{}')).toBe(false)
  expect(axios.post).not.toHaveBeenCalled()
})

test('onboarding link asks for PAYMENT, REFUND and invoicing with our business as tracking id', async () => {
  axios.mockResolvedValueOnce({ data: { links: [{ rel: 'self', href: 'x' }, { rel: 'action_url', href: 'https://sandbox.paypal.com/bizsignup/partner/entry?referralToken=abc' }] } })
  const r = await paypal.createOnboardingLink({ businessId: 'biz-1', returnUrl: 'https://dash/payments?paypal=return' })
  expect(r.url).toContain('referralToken=abc')
  const req = axios.mock.calls[0][0]
  expect(req.url).toBe('https://api-m.sandbox.paypal.com/v2/customer/partner-referrals')
  expect(req.data.tracking_id).toBe('biz-1')
  expect(req.data.operations[0].api_integration_preference.rest_api_integration.third_party_details.features).toEqual(['PAYMENT', 'REFUND', 'INVOICE_READ_WRITE', 'ACCESS_MERCHANT_INFORMATION'])
  expect(req.data.partner_config_override.return_url).toBe('https://dash/payments?paypal=return')
})

test('merchant status reads receivable/refund scopes, or returns null without a partner id', async () => {
  delete process.env.PAYPAL_PARTNER_MERCHANT_ID
  expect(await paypal.getMerchantStatus('SALON1')).toBeNull()

  process.env.PAYPAL_PARTNER_MERCHANT_ID = 'PLATFORM1'
  axios.mockResolvedValueOnce({ data: {
    merchant_id: 'SALON1', tracking_id: 'biz-1', payments_receivable: true, primary_email_confirmed: true, primary_email: 'salon@example.com',
    oauth_integrations: [{ oauth_third_party: [{ scopes: ['https://uri.paypal.com/services/payments/refund', 'https://uri.paypal.com/services/payments/realtimepayment'] }] }]
  } })
  const m = await paypal.getMerchantStatus('SALON1')
  expect(axios.mock.calls[0][0].url).toBe('https://api-m.sandbox.paypal.com/v1/customer/partners/PLATFORM1/merchant-integrations/SALON1')
  expect(m).toMatchObject({ merchantId: 'SALON1', trackingId: 'biz-1', paymentsReceivable: true, canRefund: true, email: 'salon@example.com' })
})

test('live mode requires the business to have connected PayPal', () => {
  process.env.PAYPAL_ENV = 'live'
  expect(paypal.isConfigured({})).toBe(false)
  expect(paypal.isConfigured({ paypalMerchantId: 'SALON1' })).toBe(true)
  process.env.PAYPAL_ENV = 'sandbox'
  expect(paypal.isConfigured({})).toBe(true)
})
