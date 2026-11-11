'use strict'

// ─── One-command demo setup ───────────────────────────────────────────────────
// Creates/refreshes the demo salon in the dev tables, already linked to your
// sandbox "salon" PayPal account, so the demo never needs onboarding repeated.
//
//   node scripts/seed-demo.js
//
// Reads from apps/lambda/.env:
//   DEMO_SALON_MERCHANT_ID  sandbox BUSINESS account playing the salon (optional;
//                           unset → payments go to the platform sandbox account)
//   DEMO_SALON_EMAIL        that account's email (shown on the dashboard)
//   DEMO_OWNER_EMAIL   optional owner email on the demo salon

const { loadEnv } = require('./loadEnv')
loadEnv()
Object.assign(process.env, {
  AWS_REGION: process.env.AWS_REGION || 'ap-south-1',
  DYNAMO_BUSINESSES: process.env.DYNAMO_BUSINESSES || 'flow-businesses'
})

const { saveBusiness, getBusiness } = require('../src/services/dynamo/businesses')
const { BUSINESS_ID, demoBusiness } = require('./demoData')

async function main() {
  const biz = demoBusiness()
  const existing = await getBusiness(BUSINESS_ID).catch(() => null)
  if (process.env.DEMO_OWNER_EMAIL) {
    biz.ownerEmail = process.env.DEMO_OWNER_EMAIL
    biz.ownerPhone = existing?.ownerPhone || '+10000000000'
  }
  await saveBusiness(biz)

  console.log(`Seeded ${biz.name} (${BUSINESS_ID})`)
  console.log(`  PayPal payee: ${biz.paypalMerchantId ? `${biz.paypalMerchantId} (demo salon sandbox account)` : 'platform sandbox account (set DEMO_SALON_MERCHANT_ID to pay the salon directly)'}`)
  console.log(`  Refund policy: 48h+ 100% · 24h+ 50% · <24h 0%`)
  if (biz.ownerEmail) console.log(`  Owner: ${biz.ownerEmail}`)
  process.exit(0)
}

main().catch(err => { console.error('FAIL:', err.message); process.exit(1) })
