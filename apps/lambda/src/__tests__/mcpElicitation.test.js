'use strict'

// MCP elicitation: Flow asks the person
// directly, through their AI app, before money moves. Step 1: learn what the app
// supports when it connects.

const { handleMessage } = require('../mcp/protocol')
const { elicitationModes } = require('../mcp/sessionServers')

test('initialize hands the client its capabilities and the agreed protocol version', async () => {
  const seen = []
  const server = { info: { name: 't', version: '1' }, onInitialize: (...a) => seen.push(a), listTools: async () => [], callTool: async () => ({}), listResources: async () => [], readResource: async () => ({}) }
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'app' }, capabilities: { elicitation: { form: {}, url: {} } } } }, server)
  expect(seen).toEqual([[{ name: 'app' }, { elicitation: { form: {}, url: {} } }, '2025-11-25']])
})

test('which elicitation modes a client declared', () => {
  expect(elicitationModes({})).toEqual([])
  expect(elicitationModes({ elicitation: {} })).toEqual(['form'])          // empty = form, per the spec
  expect(elicitationModes({ elicitation: { url: {} } })).toEqual(['url'])
  expect(elicitationModes({ elicitation: { form: {}, url: {} } })).toEqual(['form', 'url'])
})

describe('URL mode: apps that can open pages get the approval page through the protocol', () => {
  const { handleHttp } = require('../mcp/protocol')
  const base = { info: { name: 't', version: '1' }, listTools: async () => [], listResources: async () => [], readResource: async () => ({}) }
  const init = caps => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'app' }, capabilities: caps } })

  test('a session id is handed out only when the server asks for one, and sent back to callTool', async () => {
    const seen = []
    const server = { ...base, onInitialize: async (c, caps) => (caps.elicitation?.url ? { sessionId: 'abc' } : null), callTool: async (n, a, conn) => { seen.push(conn); return {} } }
    expect((await handleHttp('POST', init({ elicitation: { url: {} } }), server)).headers['Mcp-Session-Id']).toBe('abc')
    expect((await handleHttp('POST', init({}), server)).headers['Mcp-Session-Id']).toBeUndefined()
    await handleHttp('POST', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } }), server, { 'mcp-session-id': 'abc' })
    expect(seen).toEqual([{ sessionId: 'abc' }])
  })

  test('-32042 goes out with its elicitations', async () => {
    const { RpcError, ERR } = require('../mcp/protocol')
    const server = { ...base, callTool: async () => { throw new RpcError(ERR.URL_ELICITATION_REQUIRED, 'Needs approval', { elicitations: [{ mode: 'url', elicitationId: 'e1', url: 'https://x/approve?a=e1', message: 'Approve' }] }) } }
    const r = JSON.parse((await handleHttp('POST', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } }), server)).body)
    expect(r.error).toEqual({ code: -32042, message: 'Needs approval', data: { elicitations: [{ mode: 'url', elicitationId: 'e1', url: 'https://x/approve?a=e1', message: 'Approve' }] } })
  })
})
