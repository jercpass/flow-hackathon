'use strict'

// ─── Local API server ─────────────────────────────────────────────────────────
// Runs the real Lambda handlers on http://localhost:4000 so the dashboard + demo
// can be used end to end without deploying:
//   /dashboard/*  /demo/*  /pay/paypal/*  /webhook/paypal
//
//   node scripts/local-api.js
//
// Uses the AWS dev tables for businesses/customers/bookings (your AWS CLI creds)
// and keeps the new demo stores (sessions, inbox, trace) IN MEMORY — no AWS
// tables need to exist. Secrets come from apps/lambda/.env first, then SSM, and
// are never printed. In the dashboard set NEXT_PUBLIC_API_URL=http://localhost:4000.

const http = require('http')
const { execFileSync } = require('child_process')
const { loadEnv } = require('./loadEnv')

loadEnv()
const PORT = Number(process.env.LOCAL_API_PORT || 4000)
const DASHBOARD = process.env.LOCAL_DASHBOARD_URL || 'http://localhost:3000'

Object.assign(process.env, {
  AWS_REGION: process.env.AWS_REGION || 'ap-south-1',
  STAGE: 'local',
  EDITION: process.env.EDITION || 'global',
  API_URL: `http://localhost:${PORT}`,
  DASHBOARD_URL: DASHBOARD,
  WEB_CHAT_URL: process.env.WEB_CHAT_URL || `${DASHBOARD}/demo/client`,
  // Log in with PayPal: PayPal's dashboard won't save a localhost Return URL.
  PAYPAL_LOGIN_RETURN_URL: process.env.PAYPAL_LOGIN_RETURN_URL || `http://127.0.0.1:${PORT}/pay/paypal/login/return`,
  DEMO_STORE: 'memory',
  TRACE_STORE: 'memory',
  DYNAMO_BUSINESSES: 'flow-businesses',
  DYNAMO_CUSTOMERS: 'flow-customers',
  DYNAMO_APPOINTMENTS: 'flow-appointments',
  DYNAMO_PROCESSED_MESSAGES: 'flow-processed-messages',
  DYNAMO_OAUTH_STATES: 'flow-oauth-states',
  DYNAMO_PENDING_PAYMENTS: 'flow-pending-payments',
  DYNAMO_KNOWLEDGE_CHUNKS: 'flow-knowledge-chunks',
  DYNAMO_INVOICES: 'flow-invoices',
  PAYPAL_ENV: 'sandbox'
})

function ssm(name) {
  try {
    return execFileSync('aws', ['ssm', 'get-parameter', '--name', name, '--with-decryption', '--region', process.env.AWS_REGION,
      '--query', 'Parameter.Value', '--output', 'text'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
for (const [env, param] of [
  ['FLOW_LINK_SECRET', '/flow/linkSecret'], ['ANTHROPIC_API_KEY', '/flow/anthropic/apiKey'],
  ['GOOGLE_API_KEY', '/flow/google/apiKey'], ['KMS_KEY_ID', '/flow/kms/keyId'], ['REDIS_URL', '/flow/redis/url']
]) {
  if (!process.env[env]) process.env[env] = ssm(param)
}
if (!process.env.FLOW_LINK_SECRET) process.env.FLOW_LINK_SECRET = require('crypto').randomBytes(32).toString('hex')

const H = {
  dashboard: () => require('../src/handlers/dashboardApi').handler,
  demo: () => require('../src/handlers/demo').handler,
  paypal: () => require('../src/handlers/paypal')
}

function route(pathname) {
  const m = (prefix) => pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null
  let rest
  if ((rest = m('/dashboard/')) !== null) return { fn: H.dashboard(), proxy: rest }
  if ((rest = m('/demo/')) !== null) return { fn: H.demo(), proxy: rest }
  if ((rest = m('/mcp/')) !== null) return { fn: require('../src/handlers/mcp').handler, token: rest }
  if (pathname === '/pay/paypal/return') return { fn: H.paypal().returnPage }
  if (pathname === '/pay/paypal/cancel') return { fn: H.paypal().cancelPage }
  if (pathname === '/pay/paypal/status') return { fn: H.paypal().status }
  if (pathname === '/pay/paypal/membership/return') return { fn: H.paypal().membershipReturn }
  if (pathname === '/pay/paypal/membership/cancel') return { fn: H.paypal().membershipCancel }
  if (pathname === '/pay/paypal/vault/return') return { fn: H.paypal().vaultReturn }
  if (pathname === '/pay/paypal/vault/cancel') return { fn: H.paypal().vaultCancel }
  if (pathname === '/pay/paypal/login/return') return { fn: H.paypal().loginReturn }
  if (pathname === '/webhook/paypal') return { fn: H.paypal().webhook }
  if (pathname === '/telegram/webhook') return { fn: require('../src/handlers/telegram').webhook }
  if (pathname.startsWith('/telegram/bot/')) return { fn: require('../src/handlers/telegram').storeWebhook }
  // Alexa calls a Lambda in AWS; locally, POST a skill request here to try it (no signature check: local only).
  if (pathname === '/alexa') return { fn: require('../src/handlers/alexa').local }
  return null
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Accept,Mcp-Session-Id,MCP-Protocol-Version',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS'
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  const r = route(url.pathname)
  if (!r) { res.writeHead(404, { 'Content-Type': 'application/json', ...CORS }); return res.end('{"error":"not found"}') }

  const chunks = []
  for await (const c of req) chunks.push(c)
  const event = {
    httpMethod: req.method,
    path: url.pathname,
    headers: req.headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    pathParameters: r.proxy !== undefined ? { proxy: r.proxy } : r.token !== undefined ? { token: r.token } : {},
    body: chunks.length ? Buffer.concat(chunks).toString('utf8') : null,
    requestContext: { identity: { sourceIp: req.socket.remoteAddress } }
  }
  const t0 = Date.now()
  try {
    const out = await r.fn(event)
    res.writeHead(out.statusCode || 200, { ...CORS, ...(out.headers || {}) })
    // Binary responses (the receipt PDF) come back base64-encoded, as from API Gateway.
    res.end(out.isBase64Encoded ? Buffer.from(out.body || '', 'base64') : (out.body || ''))
    console.log(`${req.method} ${url.pathname} → ${out.statusCode} (${Date.now() - t0}ms)`)
  } catch (err) {
    console.error(`${req.method} ${url.pathname} → 500`, err.message)
    res.writeHead(500, { 'Content-Type': 'application/json', ...CORS })
    res.end('{"error":"internal"}')
  }
})

server.listen(PORT, () => {
  console.log(`Flow local API on http://localhost:${PORT}  (dashboard: ${DASHBOARD})`)
  const ai = require('../src/services/ai')
  // Telegram: Flow's demo bot answers from the deployed API (its webhook). Polling it here
  // deletes that webhook, so the bot then answers from this PC with localhost links a
  // phone can't open, until someone sets the webhook again. So it's opt-in:
  // TELEGRAM_MODE=poll in apps/lambda/.env, then `node scripts/telegram-set-webhook.js` to hand it back.
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_MODE === 'poll') {
    const bots = require('../src/core/telegramBot')
    bots.startPolling(bots.demoBot(), { onError: err => console.warn('  telegram:', err.message) })
    require('../src/services/telegram').botUsername().then(u => console.log(`  Telegram: polling as @${u || '?'} (the deployed bot is paused until telegram-set-webhook.js)`))
  } else {
    console.log(process.env.TELEGRAM_BOT_TOKEN
      ? '  Telegram: left on the deployed API (set TELEGRAM_MODE=poll to test the bot here)'
      : '  Telegram: off (set TELEGRAM_BOT_TOKEN in apps/lambda/.env)')
  }
  console.log(`  AI: ${ai.provider()} ${ai.models().main} (backup ${ai.models().backup}), key ${process.env[ai.provider() === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GOOGLE_API_KEY'] ? 'yes' : 'NO'} · PayPal sandbox keys: ${process.env.PAYPAL_CLIENT_ID ? 'yes' : 'NO (payments will fail)'} · demo stores: memory`)
})
