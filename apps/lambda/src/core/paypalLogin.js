// @ts-check
'use strict'

// ─── The demo customer logs in with PayPal ──
// The customer is whoever signs in: the demo's sandbox buyer or the judge's own
// sandbox account. Flow keeps the name, email and payer id PayPal shares, and
// renames the customer everywhere the demo shows them. The token isn't kept.

const crypto = require('crypto')
const { saveResult, getResult } = require('../services/dynamo/processedMessages')
const { updateCustomer } = require('../services/dynamo/customers')
const trace = require('../services/trace')
const log = require('../utils/logger')

const paypal = () => require('../services/payments/paypal')
const store = () => require('../services/demoStore').store()
const stateKey = state => `pplogin:${state}`
const STATE = /^[a-f0-9]{32}$/

// Must match the app's Return URL in PayPal character for character. PayPal's form
// refuses "localhost", so locally it's 127.0.0.1 (scripts/local-api.js).
function redirectUri() {
  return process.env.PAYPAL_LOGIN_RETURN_URL || `${process.env.API_URL}/pay/paypal/login/return`
}

/** PayPal's login page for this session. The state ties the return to this session only. */
async function start(session) {
  const state = crypto.randomBytes(16).toString('hex')
  await saveResult(stateKey(state), { sid: session.sid }, 15 * 60)
  trace.event('paypal', 'Log in with PayPal: sent to PayPal', {})
  return { url: paypal().loginUrl({ redirectUri: redirectUri(), state }) }
}

/**
 * Back from PayPal. Unknown or used states change nothing.
 * @returns {Promise<{ status: 'ok' | 'not_found' | 'no_name', name?: string }>}
 */
async function finish({ code, state }) {
  if (!code || !STATE.test(String(state || ''))) return { status: 'not_found' }
  const pending = await getResult(stateKey(state))
  if (!pending?.sid || pending.used) return { status: 'not_found' }
  await saveResult(stateKey(state), { ...pending, used: true }, 15 * 60)
  const session = await store().getSession(pending.sid)
  if (!session || session.status !== 'active') return { status: 'not_found' }

  return trace.run(`sess:${session.sid}`, async () => {
    const user = await paypal().loginUser(code)
    if (!user.name) return { status: 'no_name' }
    // The new name joins the session's vault before anything records it (services/pii).
    await require('../services/pii').remember(session, user.name).catch(() => {})
    await rename(session, user)
    trace.event('session', `The customer is now ${user.name} (logged in with PayPal)`, { email: masked(user.email) })
    return { status: 'ok', name: user.name, next: await saveNext(session, user) }
  })
}

// Logging in can't authorise payments; saving PayPal (Vault) can. So straight
// after login PayPal asks once to save it (nothing is charged), and the first
// booking already pays in one click. Null when this account is saved already,
// or saving isn't possible. Logging in with another account saves that one.
async function saveNext(session, user) {
  try {
    const { getBusiness } = require('../services/dynamo/businesses')
    const { getCustomer } = require('../services/dynamo/customers')
    const savedPaypal = require('./savedPaypal')
    const [business, customer] = await Promise.all([getBusiness(session.businessId), getCustomer(session.customerId)])
    if (!business || !customer || !savedPaypal.canSave(business)) return null
    const saved = savedPaypal.usable(business, customer)
    const sameAccount = saved && (!saved.email || !user?.email || saved.email.toLowerCase() === user.email.toLowerCase())
    if (sameAccount) return null
    const { approveUrl } = await savedPaypal.startChange({ customer, returnTo: 'login' })
    trace.event('paypal', 'Asked PayPal to save the account for one-click payments (nothing is charged)', {})
    return approveUrl
  } catch (err) {
    log.warn('login_save_paypal_failed', { err: err.message })
    return null    // logged in all the same; the first payment offers to save
  }
}

// The session, the customer record and its bookings all carry the name, so the
// owner's calendar and inbox show the same person the customer side does.
async function rename(session, user) {
  const paypalLogin = { name: user.name, email: user.email, payerId: user.payerId, at: new Date().toISOString() }
  await store().updateSession(session.sid, { customerName: user.name, paypalLogin: { name: user.name, email: masked(user.email) } })
  await updateCustomer(session.customerId, { name: user.name, paypalLogin })
  const { getAppointmentsForBusiness, updateAppointment } = require('../services/dynamo/appointments')
  for (const businessId of session.businessIds || [session.businessId]) {
    const appts = await getAppointmentsForBusiness(businessId, '2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z').catch(() => [])
    for (const a of appts.filter(x => x.customerId === session.customerId && x.customerName !== user.name)) {
      await updateAppointment(businessId, a.startTime, a.appointmentId, { customerName: user.name })
        .catch(err => log.warn('login_rename_booking_failed', { err: err.message }))
    }
  }
}

function masked(email) {
  return require('./savedPaypal').masked(email)
}

module.exports = { start, finish, redirectUri }
