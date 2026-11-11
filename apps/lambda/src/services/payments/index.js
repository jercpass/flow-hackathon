// @ts-check
'use strict'

// ─── Payment provider registry ────────────────────────────────────────────────
// One interface, many gateways. Everything outside services/payments talks to
// the provider returned here — never to a gateway module directly.
//
//   isConfigured(business)
//   createCheckout({ referenceId, amount, currency, description, business, customer, returnUrl, cancelUrl })
//       → { providerOrderId, approveUrl }
//   capture(providerOrderId) → { status, captureId, amount, currency, paidAt, payerEmail, ... }
//   getOrder(providerOrderId)
//   refund({ captureId, amount, currency, requestId, note }) → { refundId, status, amount }
//   verifyWebhook(headers, rawBody) → boolean
//
// Selection: business.paymentProvider → PAYMENT_PROVIDER env → 'paypal'.

const PROVIDERS = {
  paypal: () => require('./paypal')
}

function providerIdFor(business) {
  const id = String(
    business?.paymentProvider ||
    process.env.PAYMENT_PROVIDER || 'paypal'
  ).toLowerCase()
  return PROVIDERS[id] ? id : 'paypal'
}

function getPaymentProvider(business) {
  return PROVIDERS[providerIdFor(business)]()
}

function getProviderById(id) {
  const load = PROVIDERS[id]
  if (!load) throw new Error(`unknown payment provider: ${id}`)
  return load()
}

module.exports = { getPaymentProvider, getProviderById, providerIdFor }
