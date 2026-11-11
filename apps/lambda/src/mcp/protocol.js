// @ts-check
'use strict'

// ─── Minimal MCP server (Streamable HTTP, stateless) ──────────────────────────
// Implements the parts of the Model Context Protocol a remote tool server needs:
// initialize, ping, tools/list, tools/call, resources/list, resources/read,
// prompts/list, prompts/get, and notifications (acknowledged with 202). Every POST is answered with plain JSON
// (no SSE stream and no server-held session), which is valid for a stateless
// Streamable-HTTP server and fits AWS Lambda. Auth is the per-session token in
// the URL path, so any MCP client that takes a URL can connect.

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

// URL_ELICITATION_REQUIRED (MCP 2025-11-25): the request needs the person to open a page first.
const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, URL_ELICITATION_REQUIRED: -32042 }

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.rpcCode = code; this.rpcData = data }
}

/**
 * @typedef {object} McpServer
 * @property {{ name: string, version: string, title?: string }} info
 * @property {string} [instructions]
 * @property {() => Promise<object[]>} listTools
 * @property {(name: string, args: object, conn?: { sessionId?: string|null }) => Promise<object>} callTool  returns a tools/call result
 * @property {() => Promise<object[]>} listResources
 * @property {(uri: string) => Promise<object>} readResource            returns a resources/read result
 * @property {() => Promise<object[]>} [listPrompts]                    ready-made prompts (optional)
 * @property {(name: string, args: object) => Promise<object>} [getPrompt]  returns a prompts/get result
 * @property {(clientInfo: object, capabilities: object, protocolVersion: string) => any} [onInitialize]  may return { sessionId } to give the client an Mcp-Session-Id
 */

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications/responses (which get HTTP 202 and no body).
 * @param {any} msg
 * @param {McpServer} server
 * @param {{ sessionId?: string|null, newSessionId?: string|null }} [conn]  the Mcp-Session-Id sent, and one to hand out
 */
async function handleMessage(msg, server, conn = {}) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.jsonrpc === '2.0' && ('result' in msg || 'error' in msg)) return null   // a client response — nothing to do
    return error(msg?.id ?? null, ERR.INVALID_REQUEST, 'Invalid JSON-RPC request')
  }
  const isNotification = msg.id === undefined || msg.id === null
  if (isNotification) return null

  try {
    const p = msg.params || {}
    switch (msg.method) {
      case 'initialize': {
        const requested = p.protocolVersion
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0]
        const init = server.onInitialize ? await server.onInitialize(p.clientInfo || {}, p.capabilities || {}, protocolVersion) : null
        if (init?.sessionId) conn.newSessionId = init.sessionId
        return result(msg.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, ...(server.listPrompts ? { prompts: { listChanged: false } } : {}) },
          serverInfo: server.info,
          ...(server.instructions ? { instructions: server.instructions } : {})
        })
      }
      case 'ping':
        return result(msg.id, {})
      case 'tools/list':
        return result(msg.id, { tools: await server.listTools() })
      case 'tools/call': {
        if (typeof p.name !== 'string') throw new RpcError(ERR.INVALID_PARAMS, 'tools/call needs a tool name')
        return result(msg.id, await server.callTool(p.name, p.arguments || {}, { sessionId: conn.sessionId || null }))
      }
      case 'resources/list':
        return result(msg.id, { resources: await server.listResources() })
      case 'resources/templates/list':
        return result(msg.id, { resourceTemplates: [] })
      case 'resources/read': {
        if (typeof p.uri !== 'string') throw new RpcError(ERR.INVALID_PARAMS, 'resources/read needs a uri')
        return result(msg.id, await server.readResource(p.uri))
      }
      case 'prompts/list':
        return result(msg.id, { prompts: server.listPrompts ? await server.listPrompts() : [] })
      case 'prompts/get': {
        if (typeof p.name !== 'string' || !server.getPrompt) throw new RpcError(ERR.INVALID_PARAMS, 'Unknown prompt')
        return result(msg.id, await server.getPrompt(p.name, p.arguments || {}))
      }
      default:
        return error(msg.id, ERR.METHOD_NOT_FOUND, `Method not found: ${msg.method}`)
    }
  } catch (err) {
    if (err instanceof RpcError) return error(msg.id, err.rpcCode, err.message, err.rpcData)
    return error(msg.id, ERR.INTERNAL, 'Internal error')
  }
}

/**
 * HTTP layer: body text in → { status, headers, body } out.
 * @param {string} method HTTP method
 * @param {string|null} rawBody
 * @param {McpServer} server
 * @param {Record<string, string>} [reqHeaders]
 */
async function handleHttp(method, rawBody, server, reqHeaders = {}) {
  const json = { 'Content-Type': 'application/json' }
  if (method === 'GET') return { status: 405, headers: { Allow: 'POST, DELETE', ...json }, body: JSON.stringify(error(null, ERR.INVALID_REQUEST, 'This server does not offer an SSE stream; use POST.')) }
  if (method === 'DELETE') return { status: 200, headers: json, body: '' }   // stateless: nothing to tear down
  if (method !== 'POST') return { status: 405, headers: { Allow: 'POST, DELETE', ...json }, body: '' }

  let parsed
  try { parsed = JSON.parse(rawBody || '') } catch {
    return { status: 400, headers: json, body: JSON.stringify(error(null, ERR.PARSE, 'Parse error')) }
  }
  if (Array.isArray(parsed)) {
    // JSON-RPC batch (older protocol versions).
    const out = (await Promise.all(parsed.map(m => handleMessage(m, server)))).filter(Boolean)
    return out.length ? { status: 200, headers: json, body: JSON.stringify(out) } : { status: 202, headers: {}, body: '' }
  }
  // Stateless, except that a client which can open pages for us (URL elicitation)
  // gets an Mcp-Session-Id at initialize, so later calls say which client it is.
  const sent = Object.entries(reqHeaders || {}).find(([k]) => k.toLowerCase() === 'mcp-session-id')?.[1] || null
  const conn = { sessionId: sent, newSessionId: null }
  const out = await handleMessage(parsed, server, conn)
  const session = conn.newSessionId ? { 'Mcp-Session-Id': conn.newSessionId } : {}
  return out ? { status: 200, headers: { ...json, ...session }, body: JSON.stringify(out) } : { status: 202, headers: session, body: '' }
}

function result(id, value) { return { jsonrpc: '2.0', id, result: value } }
function error(id, code, message, data) { return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } } }

// Text result helper for tools/call (structured copy for clients that read it).
function toolResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return {
    content: [{ type: 'text', text }],
    ...(value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value } : {}),
    ...(isError ? { isError: true } : {})
  }
}

module.exports = { handleHttp, handleMessage, toolResult, RpcError, ERR, SUPPORTED_VERSIONS }
