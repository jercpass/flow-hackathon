'use strict'

// ─── PayPal sandbox smoke test for services/payments/paypal.js ─────────────────
// Exercises the real sandbox API: create order → (you approve in the browser with
// a SANDBOX buyer account) → capture → partial refund → read refund back.
//
//   node scripts/paypal-sandbox-e2e.js            # amount 40.00 USD, refund 60%
//   node scripts/paypal-sandbox-e2e.js 25 50      # amount 25.00, refund 50%
//
// Needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox) in apps/lambda/.env.

const { loadEnv } = require('./loadEnv')
loadEnv()
process.env.PAYPAL_ENV = process.env.PAYPAL_ENV || 'sandbox'
if (process.env.PAYPAL_ENV !== 'sandbox') { console.error('Refusing to run against live PayPal.'); process.exit(1) }

const paypal = require('../src/services/payments/paypal')
const { round2, formatMoney } = require('../src/utils/money')

const amount = Number(process.argv[2] || 40)
const refundPct = Number(process.argv[3] || 60)
const currency = 'USD'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const referenceId = `e2e_${Date.now()}`
  const checkout = await paypal.createCheckout({
    referenceId, amount, currency,
    description: 'Flow sandbox test: Haircut, Fri 10:00',
    business: { name: 'Flow Demo Salon' },
    returnUrl: 'https://example.com/flow/return',
    cancelUrl: 'https://example.com/flow/cancel'
  })
  console.log(`\n1) Order created: ${checkout.providerOrderId} (${checkout.status}) for ${formatMoney(amount, currency)}`)
  console.log(`\n   Approve it with your SANDBOX buyer account:\n   ${checkout.approveUrl}\n`)
  console.log('   (After approving, PayPal redirects to example.com — that is expected; just close it.)')

  const deadline = Date.now() + 15 * 60_000
  let order
  for (;;) {
    order = await paypal.getOrder(checkout.providerOrderId)
    if (order.status === 'APPROVED' || order.status === 'COMPLETED') break
    if (Date.now() > deadline) throw new Error('timed out waiting for approval')
    await sleep(5000)
  }
  console.log(`2) Order ${order.status} by ${order.payerEmail || 'buyer'}`)

  const cap = await paypal.capture(checkout.providerOrderId)
  console.log(`3) Captured: ${cap.captureId} ${cap.captureStatus} ${formatMoney(cap.amount, cap.currency)}`)

  const again = await paypal.capture(checkout.providerOrderId)
  console.log(`   Re-capture is idempotent: same capture id = ${again.captureId === cap.captureId}`)

  const refundAmount = round2(cap.amount * refundPct / 100)
  const r = await paypal.refund({ captureId: cap.captureId, amount: refundAmount, currency, requestId: `ref_${referenceId}`, note: `${refundPct}% refund per cancellation policy` })
  console.log(`4) Refund ${r.refundId}: ${r.status} ${formatMoney(r.amount, r.currency)} (${refundPct}%)`)

  const r2 = await paypal.refund({ captureId: cap.captureId, amount: refundAmount, currency, requestId: `ref_${referenceId}` })
  console.log(`   Retried refund is idempotent: same refund id = ${r2.refundId === r.refundId}`)

  const back = await paypal.getRefund(r.refundId)
  console.log(`5) Refund read back: ${back.status} ${formatMoney(back.amount, back.currency)}\n\nPASS`)
}

main().catch(err => { console.error('\nFAIL:', err.message, err.debugId ? `(debug_id ${err.debugId})` : ''); process.exit(1) })
