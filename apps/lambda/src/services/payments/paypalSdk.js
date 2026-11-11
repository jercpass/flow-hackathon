// @ts-check
'use strict'

// ─── PayPal Server SDK client (docs/APIMATIC.md) ────────────────────
// Orders, Payments (refunds), Vault (saved PayPal) and Subscriptions
// (memberships) go through PayPal's
// official server SDK, @paypal/paypal-server-sdk, which APIMatic generates from
// PayPal's API specs. It was wired in with the APIMatic Context Plugin for
// PayPal (the typescript-* skills), and follows them:
//   • one Client per Lambda container: it caches its OAuth token, so it's built
//     once and reused; controllers are cheap wrappers made per call;
//   • an explicit timeout: the SDK's default is 0, which axios reads as "wait
//     forever", and a hung PayPal call mustn't eat the Lambda's 29 seconds;
//   • retries only for GET/PUT (the SDK's methods to retry); POSTs carry a
//     PayPal-Request-Id instead, so a retried capture or refund can't run twice;
//   • errors: ApiError → the same Error the REST calls throw (.code is PayPal's
//     first issue, e.g. ORDER_ALREADY_CAPTURED), so callers didn't change.
// Invoicing, Disputes, Catalog Products, Log in with PayPal, partner checks and
// webhook verification aren't in the SDK; services/payments/paypal.js calls those
// endpoints directly.
//
// Required lazily, so a cold start that never touches PayPal doesn't load it.

const log = require('../../utils/logger')

/** @type {any} */
let sdk = null
/** @type {any} */
let client = null
/** @type {any} */
let testAdapter = null

/** The SDK module: Client, controllers, enums, ApiError. */
function lib() {
  if (!sdk) sdk = require('@paypal/paypal-server-sdk')
  return sdk
}

function getClient() {
  if (client) return client
  const { Client, Environment } = lib()
  const id = process.env.PAYPAL_CLIENT_ID
  const secret = process.env.PAYPAL_CLIENT_SECRET
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set')
  client = new Client({
    clientCredentialsAuthCredentials: { oAuthClientId: id, oAuthClientSecret: secret, oAuthClockSkew: 60 },
    environment: process.env.PAYPAL_ENV === 'live' ? Environment.Production : Environment.Sandbox,
    timeout: 15000,
    httpClientOptions: {
      timeout: 15000,
      // Both fields gate retrying (a 0 wait budget means none at all). Off under
      // a test stub, so a stubbed 5xx fails at once instead of waiting out backoff.
      retryConfig: testAdapter ? { maxNumberOfRetries: 0 } : { maxNumberOfRetries: 2, maximumRetryWaitTime: 5 }
    },
    // Tests only: a stub axios adapter, the SDK's documented test seam.
    ...(testAdapter ? { unstable_httpClientOptions: { adapter: testAdapter } } : {})
  })
  return client
}

const orders = () => new (lib().OrdersController)(getClient())
const payments = () => new (lib().PaymentsController)(getClient())
const vault = () => new (lib().VaultController)(getClient())
const subscriptions = () => new (lib().SubscriptionsController)(getClient())

/**
 * An SDK error → Flow's PayPal error. PayPal's error body keeps its wire names
 * ({ name, details: [{ issue }], debug_id }); a typed ApiError subclass has it
 * parsed on .result, a bare ApiError only as the raw .body.
 */
function toError(err, op) {
  const { ApiError } = lib()
  if (!(err instanceof ApiError)) return err       // network, timeout, abort: unchanged
  /** @type {any} */
  let data = err.result
  if (!data && typeof err.body === 'string') { try { data = JSON.parse(err.body) } catch { data = null } }
  const issue = data?.details?.[0]?.issue || data?.name || data?.error || 'PAYPAL_ERROR'
  const e = new Error(`PayPal ${err.statusCode} ${issue} on ${op}`)
  Object.assign(e, { code: issue, status: err.statusCode, debugId: data?.debug_id })
  log.warn('paypal_api_error', { path: op, status: err.statusCode, issue, debugId: data?.debug_id, via: 'sdk' })
  return e
}

/** Run one SDK operation; returns its deserialized result. */
async function run(op, fn) {
  try {
    return (await fn()).result
  } catch (err) {
    throw toError(err, op)
  }
}

/** Tests: route the SDK's HTTP through a stub adapter (null = the real network). */
function _useAdapter(adapter) { testAdapter = adapter; client = null }
/** Tests: rebuild the client (new credentials, a fresh token). */
function _reset() { client = null }

module.exports = { lib, orders, payments, vault, subscriptions, run, toError, VIA: 'PayPal Server SDK (APIMatic)', _useAdapter, _reset }
