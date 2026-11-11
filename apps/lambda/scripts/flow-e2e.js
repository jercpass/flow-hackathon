'use strict'

// ─── Flow full-stack sandbox run ───────────────────────────────────────────
// Drives the REAL code path end to end against the AWS dev tables + Redis and the
// PayPal sandbox — no mocks, no LLM in the loop (the tools are called directly,
// exactly as the AI would call them):
//
//   seed demo business → book_appointment (web channel) → PayPal approve link
//   → you approve with a SANDBOX buyer → PayPal redirects to localhost
//   → handlers/paypal.returnPage → seat check → capture → booking confirmed
//   → cancel_booking (quote) → cancel_booking (confirm) → policy refund
//
//   node scripts/flow-e2e.js [customer-email]
//
// Needs: PayPal sandbox keys in apps/lambda/.env, AWS CLI creds for the dev account.

const http = require('http')
const { execFileSync } = require('child_process')
const { loadEnv } = require('./loadEnv')

loadEnv()
const PORT = Number(process.env.E2E_PORT || 4123)
Object.assign(process.env, {
  AWS_REGION: process.env.AWS_REGION || 'ap-south-1',
  STAGE: process.env.STAGE || 'dev',
  PAYPAL_ENV: 'sandbox',
  API_URL: `http://localhost:${PORT}`,
  DYNAMO_BUSINESSES: 'flow-businesses',
  DYNAMO_CUSTOMERS: 'flow-customers',
  DYNAMO_APPOINTMENTS: 'flow-appointments',
  DYNAMO_PROCESSED_MESSAGES: 'flow-processed-messages',
  DYNAMO_PENDING_PAYMENTS: 'flow-pending-payments'
})
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
  console.error('Set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox) in apps/lambda/.env first.')
  process.exit(1)
}

// Pull infra settings from SSM into this process only (never printed).
function ssm(name) {
  return execFileSync('aws', ['ssm', 'get-parameter', '--name', name, '--with-decryption',
    '--region', process.env.AWS_REGION, '--query', 'Parameter.Value', '--output', 'text'], { encoding: 'utf8' }).trim()
}
if (!process.env.REDIS_URL) process.env.REDIS_URL = ssm('/flow/redis/url')
if (!process.env.KMS_KEY_ID) process.env.KMS_KEY_ID = ssm('/flow/kms/keyId')

const { saveBusiness, getBusiness } = require('../src/services/dynamo/businesses')
const { saveCustomer } = require('../src/services/dynamo/customers')
const { getAppointmentsForBusiness } = require('../src/services/dynamo/appointments')
const { getAvailability } = require('../src/core/engine')
const { executeTool } = require('../src/services/tools')
const paypalHandlers = require('../src/handlers/paypal')
const paypal = require('../src/services/payments/paypal')
const redis = require('../src/services/redis')
const { formatMoney } = require('../src/utils/money')
const trace = require('../src/services/trace')

// Keep the "Under the hood" timeline in memory and print it at the end.
const traceSink = trace.memorySink()
trace.setSink(traceSink)
const TRACE_SCOPE = `e2e:${Date.now()}`
const ICON = { ai: '🤖', tool: '🛠 ', redis: '🔒', paypal: '💳', policy: '⚖️ ', db: '📅', email: '📧', webhook: '🔔', media: '🎙', session: '🧭', mcp: '🔌' }
function printTimeline() {
  console.log('\n── Under the hood ─────────────────────────────────────────')
  const mine = traceSink.events.filter(x => x.scope === TRACE_SCOPE)
  const t0 = mine[0]?.ts || 0
  for (const e of mine) {
    const d = e.detail ? ' ' + JSON.stringify(e.detail) : ''
    console.log(`+${((e.ts - t0) / 1000).toFixed(1).padStart(6)}s ${ICON[e.layer] || '•'} ${e.title}${e.ms != null ? ` (${e.ms}ms)` : ''}${d}`)
  }
}

const { BUSINESS_ID, demoBusiness: buildDemoBusiness } = require('./demoData')

const demoBusiness = buildDemoBusiness()

// Route PayPal's browser redirects into the real Lambda handlers.
function startServer(onReturn) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const event = { httpMethod: req.method, path: url.pathname, headers: req.headers, queryStringParameters: Object.fromEntries(url.searchParams) }
    let out = { statusCode: 404, body: 'not found' }
    if (url.pathname === '/pay/paypal/return') out = await paypalHandlers.returnPage(event)
    else if (url.pathname === '/pay/paypal/cancel') out = await paypalHandlers.cancelPage(event)
    else if (url.pathname === '/pay/paypal/status') out = await paypalHandlers.status(event)
    res.writeHead(out.statusCode, out.headers || {})
    res.end(out.body)
    if (url.pathname === '/pay/paypal/return') onReturn(url.searchParams.get('token'))
  })
  return new Promise(resolve => server.listen(PORT, () => resolve(server)))
}

// A slot 25–47h out, so the cancellation lands in the 50% tier (shows a partial refund).
async function pickSlot(business) {
  for (let d = 0; d < 4; d++) {
    const date = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
    const slots = await getAvailability(business, 'svc-haircut', date)
    const hit = slots.find(s => { const h = (new Date(s.start).getTime() - Date.now()) / 3_600_000; return h > 25 && h < 47 })
    if (hit) return hit.start
  }
  throw new Error('no slot 25–47h out')
}

async function main() {
  const email = process.argv[2] || null
  // Keep the demo owner login (seed-demo.js) — only refresh the demo config.
  const existing = await getBusiness(BUSINESS_ID).catch(() => null)
  await saveBusiness({ ...(existing || {}), ...demoBusiness })
  await redis.invalidateBusiness(BUSINESS_ID)
  const customer = { customerId: `flow-e2e-${Date.now()}`, businessId: BUSINESS_ID, phone: `web:${Date.now()}`, name: 'Sam Rivera', email, createdAt: new Date().toISOString() }
  await saveCustomer(customer)
  console.log(`Seeded ${demoBusiness.name} (${BUSINESS_ID}) and customer ${customer.customerId}`)

  const startIso = await pickSlot(demoBusiness)
  const ctx = { business: demoBusiness, customer, channel: 'web', traceScope: TRACE_SCOPE }

  const booked = await executeTool('book_appointment', { service_name: 'Haircut', start_time: startIso, customer_name: 'Sam Rivera' }, ctx)
  if (!booked.paymentUrl) throw new Error(`book_appointment did not return a pay link: ${JSON.stringify(booked)}`)
  console.log(`\n1) book_appointment → ${booked.message}\n   order ${booked.orderId}, slot ${startIso}`)

  let resolveReturn
  const returned = new Promise(r => { resolveReturn = r })
  const server = await startServer(resolveReturn)
  console.log(`\n2) Approve with your SANDBOX buyer account:\n   ${booked.paymentUrl}\n   (PayPal will redirect back to http://localhost:${PORT}/pay/paypal/return)`)

  const orderId = await returned
  const status = JSON.parse((await paypalHandlers.status({ queryStringParameters: { order: orderId } })).body)
  console.log(`\n3) Return handled → ${status.status}${status.amount != null ? `, paid ${formatMoney(status.amount, status.currency)}` : ''}`)
  if (status.status !== 'confirmed') throw new Error(`expected confirmed, got ${JSON.stringify(status)}`)

  const from = new Date(Date.now() - 3_600_000).toISOString()
  const to = new Date(Date.now() + 5 * 86_400_000).toISOString()
  const appt = (await getAppointmentsForBusiness(BUSINESS_ID, from, to)).find(a => a.appointmentId === status.appointmentId)
  console.log(`4) Appointment ${appt.appointmentId}: ${appt.status}/${appt.paymentStatus}, capture ${appt.paymentId}, staff ${appt.unitId}`)

  // Replay the return (simulates the webhook racing the redirect) → must not double-book.
  const replay = await paypalHandlers.returnPage({ queryStringParameters: { token: orderId } })
  const after = (await getAppointmentsForBusiness(BUSINESS_ID, from, to)).filter(a => a.paymentId === appt.paymentId)
  console.log(`   Replayed return: HTTP ${replay.statusCode}, appointments for this capture = ${after.length}`)

  const quote = await executeTool('cancel_booking', { service_name: 'Haircut' }, ctx)
  console.log(`\n5) cancel_booking (quote) → ${quote.message}`)
  const done = await executeTool('cancel_booking', { service_name: 'Haircut', confirm: true }, ctx)
  console.log(`6) cancel_booking (confirm) → ${done.message}`)

  const final = (await getAppointmentsForBusiness(BUSINESS_ID, from, to)).find(a => a.appointmentId === appt.appointmentId)
  const pp = final.refundId ? await paypal.getRefund(final.refundId) : null
  console.log(`7) Appointment now ${final.status}/${final.paymentStatus}; refund ${final.refundId} ${formatMoney(final.refundAmount, final.currency)}; PayPal says ${pp?.status} ${pp ? formatMoney(pp.amount, pp.currency) : ''}`)

  const ok = after.length === 1 && final.status === 'cancelled' && pp?.status === 'COMPLETED' && Number(final.refundAmount) === Number(quote.refundAmount)
  printTimeline()
  console.log(ok ? '\nPASS — create → approve → capture → confirm → refund' : '\nCHECK OUTPUT — something did not match')
  server.close()
  process.exit(ok ? 0 : 1)
}

main().catch(err => { console.error('\nFAIL:', err.message, err.debugId ? `(debug_id ${err.debugId})` : ''); process.exit(1) })
