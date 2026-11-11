// @ts-check
'use strict'

// ─── /mcp/{token} — session MCP endpoint ──────────────────────────────────────
// Remote MCP server (Streamable HTTP, stateless). The token in the path picks the
// demo session and the role (customer | business); it expires with the session
// and is re-checked against the live session on every request, so a link stops
// working the moment the session ends.

const { handleHttp } = require('../mcp/protocol')
const { customerServer, businessServer } = require('../mcp/sessionServers')
const demo = require('../core/demoSession')
const log = require('../utils/logger')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
}

function rpcError(status, message) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }) }
}

exports.handler = async (event) => {
  if (event?.warm) return { warm: true }   // keep-warm ping (serverless.yml custom.warm)
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' }
  const token = event.pathParameters?.token || (String(event.path || '').match(/\/mcp\/([^/?]+)/) || [])[1]
  const claims = demo.mcpClaims(token)
  if (!claims) return rpcError(404, 'Unknown or expired Flow MCP link.')
  const session = await demo.getActiveSession(claims.sid)
  if (!session) return rpcError(404, 'This Flow demo session has ended — start a new one to get fresh MCP links.')

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '')
  try {
    if (/"tools\/call"/.test(raw)) await demo.checkMcpLimit(session.sid)
  } catch (err) {
    if (err.code === 'DEMO_LIMIT') return rpcError(429, err.message)
    throw err
  }

  try {
    const { getBusiness } = require('../services/dynamo/businesses')
    // An owner link can name another business in the session (the switcher); a customer link is always John in the whole city.
    const businessId = claims.role === 'business' && claims.bid && demo.ownsBusiness(session, claims.bid) ? claims.bid : session.businessId
    const business = await getBusiness(businessId)
    if (!business) return rpcError(410, 'Session data missing — start a new session.')
    let server
    if (claims.role === 'business') {
      server = businessServer({ session, business, clientLabel: 'business' })
    } else {
      const { getCustomer } = require('../services/dynamo/customers')
      const customer = await getCustomer(session.customerId)
      if (!customer) return rpcError(410, 'Session data missing — start a new session.')
      const ctx = await require('../core/concierge').sessionContext(session, business, customer, 'mcp')
      server = customerServer({ session, ctx, clientLabel: 'customer' })
    }
    const out = await handleHttp(event.httpMethod, raw, server, event.headers || {})
    return { statusCode: out.status, headers: { ...CORS, ...out.headers }, body: out.body }
  } catch (err) {
    log.error('mcp_handler_error', err, { role: claims.role })
    return rpcError(500, 'Internal error')
  }
}
