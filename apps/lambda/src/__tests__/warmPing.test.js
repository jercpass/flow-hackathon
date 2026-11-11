'use strict'

// Speed on the hosted demo: the keep-warm ping (every 5 minutes, serverless.yml)
// is answered before any work.

process.env.DEMO_STORE = 'memory'
process.env.FLOW_LINK_SECRET = 'test-secret'

test('each browser-facing function answers the keep-warm ping without touching anything', async () => {
  for (const file of ['demo', 'mcp', 'dashboardApi']) {
    const { handler } = require(`../handlers/${file}`)
    expect(await handler({ warm: true })).toEqual({ warm: true })
  }
})
