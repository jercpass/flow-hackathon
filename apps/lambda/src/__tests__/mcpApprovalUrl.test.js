'use strict'

// The customer MCP link: a payment that needs approval becomes the standard URL
// elicitation (-32042) for an app that declared URL mode, and a plain result
// with the link for any other app (like one that declared no elicitation).

jest.mock('../services/tools', () => ({
  getTools: () => [{ name: 'book_appointment', description: 'Book', parameters: {}, required: [] }],
  executeTool: jest.fn(async () => ({ booked: false, needsApproval: true, approvalId: 'a1b2c3d4e5f6a7b8c9', approvalUrl: 'https://flow.example/approve?a=a1b2c3d4e5f6a7b8c9', amount: 40, currency: 'USD', message: 'Not charged yet' }))
}))
jest.mock('../core/concierge', () => ({ visitHistory: jest.fn().mockResolvedValue({}) }))

const { setStore, memory } = require('../services/demoStore')
const { customerServer } = require('../mcp/sessionServers')

const session = { sid: 's1', expiresAt: Date.now() + 3600_000 }
const ctx = { customer: { customerId: 'john', name: 'John Doe' }, catalog: [], customerLocation: { label: 'Travis Heights' }, channel: 'mcp' }
beforeEach(() => setStore(memory()))

test('an app that opens pages gets -32042 with the approval page', async () => {
  const server = customerServer({ session, ctx, clientLabel: 'customer' })
  const init = await server.onInitialize({ name: 'app' }, { elicitation: { url: {} } }, '2025-11-25')
  expect(init.sessionId).toMatch(/^[0-9a-f]{32}$/)
  await expect(server.callTool('book_appointment', {}, { sessionId: init.sessionId })).rejects.toMatchObject({
    rpcCode: -32042,
    rpcData: { elicitations: [{ mode: 'url', elicitationId: 'a1b2c3d4e5f6a7b8c9', url: 'https://flow.example/approve?a=a1b2c3d4e5f6a7b8c9', message: expect.stringMatching(/^Approve \$40 with your saved PayPal in Flow/) }] }
  })
})

test('an app without elicitation gets no session id and the plain result with the link', async () => {
  const server = customerServer({ session, ctx, clientLabel: 'customer' })
  expect(await server.onInitialize({ name: 'Anthropic/ClaudeAI' }, {}, '2025-11-25')).toBeNull()
  const r = await server.callTool('book_appointment', {}, { sessionId: null })
  expect(r.structuredContent).toMatchObject({ needsApproval: true, approvalUrl: 'https://flow.example/approve?a=a1b2c3d4e5f6a7b8c9' })
})
