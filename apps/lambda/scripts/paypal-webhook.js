// Register (or update) the PayPal webhook for the deployed API, so PayPal's events
// reach Flow. Without one, PayPal sends Flow
// nothing and every webhook path (refund sync, pending captures, disputes…) is idle.
//
//   node scripts/paypal-webhook.js                 → show what's registered (changes nothing)
//   node scripts/paypal-webhook.js --apply         → create or update it for the events below
//   node scripts/paypal-webhook.js --apply --save  → …and store its id in SSM (/flowhq/paypal/webhookId),
//                                                     which serverless.yml reads on the next deploy
//
// Uses the PayPal app from SSM (/flowhq/paypal/clientId, clientSecret) and the API
// address of the deployed paypalWebhook Lambda. Prints no secrets.

const { execFileSync } = require('child_process')
require('./loadEnv').loadEnv()

const REGION = process.env.AWS_REGION_DEPLOY || 'us-east-1'
const EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'VAULT.PAYMENT-TOKEN.DELETED',
  'VAULT.PAYMENT-TOKEN.DELETION-INITIATED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED'
]

const aws = args => execFileSync('aws', [...args, '--region', REGION], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim()
const ssm = name => aws(['ssm', 'get-parameter', '--name', name, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'])

;(async () => {
  const apply = process.argv.includes('--apply')
  const save = process.argv.includes('--save')
  const api = aws(['lambda', 'get-function-configuration', '--function-name', 'flowhq-dev-paypalWebhook', '--query', 'Environment.Variables.API_URL', '--output', 'text']).replace(/\/$/, '')
  if (!/^https:\/\//.test(api)) throw new Error(`The deployed API_URL looks wrong: ${api}`)
  const url = `${api}/webhook/paypal`

  const id = ssm('/flowhq/paypal/clientId')
  const secret = ssm('/flowhq/paypal/clientSecret')
  const base = (process.env.PAYPAL_ENV || 'sandbox') === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
  const tok = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  }).then(r => r.json())
  if (!tok.access_token) throw new Error('PayPal refused the app credentials')
  const pp = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`PayPal ${r.status} on ${method} ${path}: ${JSON.stringify(data.details || data.message || data).slice(0, 300)}`)
    return data
  }

  const { webhooks = [] } = await pp('GET', '/v1/notifications/webhooks')
  const mine = webhooks.find(w => w.url === url)
  console.log(`Flow's webhook URL: ${url}`)
  console.log(mine ? `Registered: ${mine.id} with ${mine.event_types.length} events` : 'Not registered yet.')
  for (const w of webhooks.filter(w => w !== mine)) console.log(`Other webhook on this app: ${w.id} → ${w.url}`)
  if (!apply) { console.log('\nNothing changed. Run with --apply to register or update it.'); return }

  const types = EVENTS.map(name => ({ name }))
  let hook
  if (mine) {
    hook = await pp('PATCH', `/v1/notifications/webhooks/${mine.id}`, [{ op: 'replace', path: '/event_types', value: types }])
    console.log(`Updated ${hook.id}: ${hook.event_types.length} events.`)
  } else {
    hook = await pp('POST', '/v1/notifications/webhooks', { url, event_types: types })
    console.log(`Created ${hook.id}: ${hook.event_types.length} events.`)
  }
  if (save) {
    aws(['ssm', 'put-parameter', '--name', '/flowhq/paypal/webhookId', '--type', 'String', '--value', hook.id, '--overwrite'])
    console.log('Saved the id in SSM as /flowhq/paypal/webhookId. Deploy once so the Lambdas read it.')
  } else {
    console.log(`Not saved. Store it with --save, or: aws ssm put-parameter --name /flowhq/paypal/webhookId --type String --value ${hook.id} --overwrite`)
  }
})().catch(err => { console.error(err.message); process.exit(1) })
