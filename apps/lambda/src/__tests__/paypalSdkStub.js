'use strict'

// A stand-in for PayPal behind the PayPal Server SDK, using the SDK's own test
// seam (APIMatic Context Plugin, typescript-testing): a stub axios adapter
// passed through unstable_httpClientOptions. No network and no global mocks, so
// tests see the exact JSON the SDK puts on the wire and answer with PayPal's
// own JSON, which the SDK then parses.
//
//   const pp = stubPayPal()
//   pp.on('POST', '/v2/checkout/orders', { body: {...} })      // every time
//   pp.once('GET', /\/v2\/checkout\/orders\/\w+$/, { status: 422, body: {...} })
//   pp.requests → [{ method, path, headers (lower-case), body (parsed JSON) }]
//
// The SDK's OAuth token request is answered here and counted, not recorded.

const sdk = require('../services/payments/paypalSdk')

const TOKEN_PATH = '/v1/oauth2/token'

function headersOf(config) {
  const h = config.headers && typeof config.headers.toJSON === 'function' ? config.headers.toJSON() : { ...(config.headers || {}) }
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
}

function parse(data) {
  if (data == null || data === '') return undefined
  if (typeof data !== 'string') return data
  try { return JSON.parse(data) } catch { return data }
}

function reply(config, status, body) {
  return {
    // The SDK turns off axios's response transforms: hand back the raw wire string.
    data: body === undefined || body === '' ? '' : JSON.stringify(body),
    status, statusText: '', headers: { 'content-type': 'application/json' }, config
  }
}

function stubPayPal() {
  const routes = []
  const requests = []
  let tokenCalls = 0

  const adapter = async config => {
    const url = new URL(config.url)
    const method = String(config.method || 'get').toUpperCase()
    if (url.pathname === TOKEN_PATH) {
      tokenCalls++
      return reply(config, 200, { access_token: 'sdk-token', token_type: 'Bearer', expires_in: 32400 })
    }
    const req = { method, path: url.pathname, url: config.url, headers: headersOf(config), body: parse(config.data) }
    requests.push(req)
    const route = routes.find(r => r.left !== 0 && r.method === method && (typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname)))
    if (!route) return reply(config, 404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'NO_STUB_FOR_THIS_CALL' }], debug_id: 'stub' })
    if (route.left > 0) route.left--
    const out = typeof route.answer === 'function' ? route.answer(req) : route.answer
    return reply(config, out.status || 200, out.body)
  }
  sdk._useAdapter(adapter)

  const api = {
    requests,
    /** The adapter itself: set it as axios.defaults.adapter to route Flow's direct REST calls here too. */
    adapter,
    tokenCalls: () => tokenCalls,
    /** Answer every matching call. */
    on(method, path, answer) { routes.push({ method, path, answer, left: -1 }); return api },
    /** Answer the next matching call only (checked before later routes). */
    once(method, path, answer) { routes.unshift({ method, path, answer, left: 1 }); return api },
    /** The last recorded call to this method + path. */
    last(method, path) { return [...requests].reverse().find(r => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))) }
  }
  return api
}

/** PayPal's error body for a failed call. */
const paypalError = (status, issue, debugId = 'dbg1') => ({ status, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue }], debug_id: debugId } })

module.exports = { stubPayPal, paypalError }
