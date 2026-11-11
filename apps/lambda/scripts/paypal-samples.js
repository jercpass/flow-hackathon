'use strict'

// ─── Real sandbox PayPal payments for the demo's sample bookings ─────────────
// Run once (again only to make a fresh pool):
//
//   node scripts/paypal-samples.js --dry-run   # what it would charge; no PayPal calls
//   node scripts/paypal-samples.js             # make the pool (one approval from you)
//
// 1. Prints one PayPal link: approve it with the SANDBOX buyer account. That
//    saves the buyer's PayPal (Vault), so the rest needs no more clicks.
// 2. Charges that saved PayPal once for every sample a session can need, in
//    every business, whatever time of day the session starts.
// 3. Refunds the cancelled samples in full.
// 4. Writes src/demo/paypalSamples.json. Commit it and deploy the API.
//
// Sandbox only, and fake money: everything lands in Flow's own sandbox account.
// Needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox) in apps/lambda/.env,
// the same app the deployed API uses (the file records a hash of the client ID).

const fs = require('fs')
const path = require('path')
const { loadEnv } = require('./loadEnv')
loadEnv()
process.env.PAYPAL_ENV = process.env.PAYPAL_ENV || 'sandbox'
if (process.env.PAYPAL_ENV !== 'sandbox') { console.error('Refusing to run against live PayPal.'); process.exit(1) }

const { CATALOG } = require('../src/demo/templates')
const { planOthers, clientIdHash, kindOf } = require('../src/demo/seedBookings')
const { formatMoney } = require('../src/utils/money')
const { dayjs } = require('../src/utils/time')

const OUT = path.join(__dirname, '..', 'src', 'demo', 'paypalSamples.json')
const DRY = process.argv.includes('--dry-run')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * For each business: the most payments of each kind (amount, paid or refunded)
 * one session can need, over a session starting at any 15 minutes of a week.
 */
function needs() {
  const out = {}
  const monday = dayjs.tz('2026-11-02 00:00', 'America/Chicago').valueOf()
  for (const c of CATALOG) {
    const business = { ...c.build(), businessId: `pool-${c.slug}` }
    const most = {}
    for (let t = monday; t < monday + 7 * 86_400_000; t += 15 * 60_000) {
      const count = {}
      for (const s of planOthers(business, { now: t })) {
        if (!(s.paid > 0)) continue
        const k = kindOf(s.paid, business.config.currency || 'USD', s.status === 'cancelled')
        count[k] = (count[k] || 0) + 1
      }
      for (const [k, n] of Object.entries(count)) most[k] = Math.max(most[k] || 0, n)
    }
    out[c.slug] = {
      name: business.name,
      kinds: Object.entries(most).map(([k, n]) => {
        const [amount, currency, state] = k.split(' ')
        return { amount: Number(amount), currency, refunded: state === 'refunded', count: n }
      })
    }
  }
  return out
}

async function main() {
  const plan = needs()
  const total = Object.values(plan).reduce((s, b) => s + b.kinds.reduce((x, k) => x + k.count, 0), 0)
  const refunds = Object.values(plan).reduce((s, b) => s + b.kinds.filter(k => k.refunded).reduce((x, k) => x + k.count, 0), 0)
  console.log(`\nSample payments needed: ${total} (${refunds} of them refunded in full)\n`)
  for (const [slug, b] of Object.entries(plan)) {
    console.log(`  ${b.name} (${slug})`)
    for (const k of b.kinds) console.log(`    ${k.count} × ${formatMoney(k.amount, k.currency)}${k.refunded ? ', refunded' : ''}`)
  }
  if (DRY) { console.log('\nDry run: no PayPal calls made.'); return }
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are missing from apps/lambda/.env')

  const paypal = require('../src/services/payments/paypal')
  const stamp = Date.now()
  const returnUrl = 'https://example.com/flow/return'
  const cancelUrl = 'https://example.com/flow/cancel'

  // 1. One approval: save the sandbox buyer's PayPal.
  const setup = await paypal.createVaultSetup({ requestId: `samples_${stamp}`, returnUrl, cancelUrl, brandName: 'Flow demo samples' })
  console.log(`\n1) Approve this with your SANDBOX buyer account (it saves PayPal; nothing is charged yet):\n\n   ${setup.approveUrl}\n`)
  console.log('   PayPal then sends you to example.com: that is expected, just close it. Waiting for your approval…')
  let vaultId
  for (const deadline = Date.now() + 15 * 60_000; !vaultId;) {
    try { vaultId = (await paypal.finishVaultSetup(setup.setupTokenId)).vaultId } catch { /* not approved yet */ }
    if (vaultId) break
    if (Date.now() > deadline) throw new Error('timed out waiting for the approval (15 minutes)')
    await sleep(5000)
  }
  console.log('   Saved.\n\n2) Charging the samples…')

  // 2 and 3. Charge each sample payment; refund the cancelled ones.
  const businesses = {}
  let n = 0
  for (const [slug, b] of Object.entries(plan)) {
    businesses[slug] = []
    for (const k of b.kinds) {
      for (let i = 0; i < k.count; i++) {
        n++
        const referenceId = `sample_${slug}_${n}_${stamp}`
        const charge = await paypal.chargeSaved({
          referenceId, amount: k.amount, currency: k.currency, vaultId, returnUrl, cancelUrl,
          description: `Flow demo sample booking: ${b.name}`, business: { name: b.name }
        })
        const cap = charge.captured
        if (!cap || cap.captureStatus !== 'COMPLETED') throw new Error(`payment ${n} for ${b.name} didn't complete (${charge.status}${cap ? `, capture ${cap.captureStatus}` : ''})`)
        const row = { amount: k.amount, currency: k.currency, orderId: charge.providerOrderId, captureId: cap.captureId }
        if (k.refunded) {
          const r = await paypal.refund({ captureId: cap.captureId, amount: k.amount, currency: k.currency, requestId: `ref_${referenceId}`, note: 'Flow demo sample booking: cancelled' })
          if (r.status !== 'COMPLETED') throw new Error(`refund for payment ${n} is ${r.status}`)
          row.refundId = r.refundId
        }
        businesses[slug].push(row)
        console.log(`   ${String(n).padStart(2)}/${total}  ${b.name}: ${formatMoney(k.amount, k.currency)} ${row.refundId ? 'paid and refunded' : 'paid'}`)
        await sleep(300)   // gentle on the sandbox
      }
    }
  }

  // 4. The pool file.
  const pool = {
    note: 'Real PayPal sandbox payments behind the demo sample bookings, shared by every session. Made by scripts/paypal-samples.js. Fake money; not secret.',
    createdAt: new Date().toISOString(),
    env: 'sandbox',
    clientIdHash: clientIdHash(process.env.PAYPAL_CLIENT_ID),
    businesses
  }
  fs.writeFileSync(OUT, JSON.stringify(pool, null, 2) + '\n')
  console.log(`\n3) Wrote ${path.relative(process.cwd(), OUT)}: ${n} payments, ${refunds} refunded.\n\nNext: commit that file, then deploy the API (npm run deploy --workspace=apps/lambda).\nDONE`)
}

main().catch(err => { console.error('\nFAIL:', err.message, err.debugId ? `(debug_id ${err.debugId})` : ''); process.exit(1) })
