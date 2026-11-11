'use strict'

// The tester's own AI may know where its user really lives (it once asked
// "Austin or Jharkhand?"). The customer link says plainly that this is a test
// customer in Austin and that the tester's real location doesn't apply.

jest.mock('../core/concierge', () => ({ visitHistory: jest.fn().mockResolvedValue({}) }))

const { customerServer } = require('../mcp/sessionServers')

const ctx = {
  customer: { customerId: 'john', name: 'John Doe' },
  catalog: [],
  customerLocation: { label: 'Travis Heights, Austin, TX', lat: 30.25, lng: -97.74 },
  channel: 'mcp'
}
const server = customerServer({ session: { sid: 's1' }, ctx, clientLabel: 'customer' })

test('the instructions call John a test customer and keep the AI off its user\'s real location', () => {
  expect(server.instructions).toMatch(/John Doe is a test customer for this demo/)
  expect(server.instructions).toMatch(/Don't use, mention or compare your own user's real location/)
  expect(server.instructions).toMatch(/say plainly that this is a test account for a demo customer in Austin/)
})

test('the profile is marked as a test account, with the Austin home', async () => {
  const r = await server.readResource('flow://customer/profile')
  const profile = JSON.parse(r.contents[0].text)
  expect(profile).toMatchObject({ name: 'John Doe', test_account: true, location: { label: 'Travis Heights, Austin, TX' } })
  expect(profile.note).toMatch(/test customer for the Flow demo/)
  expect(profile.note).toMatch(/your own user's real location doesn't apply/)
})
