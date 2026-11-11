'use strict'

// Demo sessions: create → tokens → inbox routing → limits → end/wipe → expiry.

jest.mock('../services/dynamo/businesses', () => ({ saveBusiness: jest.fn(), deleteBusiness: jest.fn(), getBusiness: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ saveCustomer: jest.fn(), deleteCustomer: jest.fn(), getCustomer: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), deleteAppointment: jest.fn(), createAppointment: jest.fn() }))

process.env.FLOW_LINK_SECRET = 'test-secret'
const { setStore, memory } = require('../services/demoStore')
const trace = require('../services/trace')
const demo = require('../core/demoSession')
const inbox = require('../services/demoInbox')
const { saveBusiness, deleteBusiness } = require('../services/dynamo/businesses')
const { saveCustomer, deleteCustomer } = require('../services/dynamo/customers')
const { getAppointmentsForBusiness, deleteAppointment, createAppointment } = require('../services/dynamo/appointments')
const { verifyToken } = require('../utils/jwt')

let sink
beforeEach(() => {
  jest.clearAllMocks()
  setStore(memory())
  sink = trace.memorySink(); trace.setSink(sink)
  getAppointmentsForBusiness.mockResolvedValue([])
})
afterAll(() => trace.setSink(null))

test('creating a session seeds a private salon copy, persona, two web inboxes and two scoped tokens', async () => {
  const { session, sessionToken, ownerToken } = await demo.createSession({ ip: '1.2.3.4' })
  expect(session.sid).toMatch(/^[a-f0-9]{20}$/)
  expect(session.businessId).toBe(`demo-${session.sid}`)
  // No email addresses anywhere: the inboxes belong to the session.
  expect(JSON.stringify(session)).not.toMatch(/@|email/i)
  expect(session.expiresAt - session.createdAt).toBe(24 * 3600 * 1000)

  // A private copy of the whole demo city. Willow is the judge's own; the judge can run the others too.
  expect(saveBusiness).toHaveBeenCalledTimes(4)
  const biz = saveBusiness.mock.calls[0][0]
  expect(biz).toMatchObject({ businessId: session.businessId, name: 'Willow & Co. Salon', ownerInbox: true, demoSessionId: session.sid, paymentProvider: 'paypal' })
  expect(biz.ownerEmail).toBeUndefined()
  const others = saveBusiness.mock.calls.slice(1).map(c => c[0])
  expect(others.map(b => b.businessId)).toEqual(['bluebonnet', 'eastside', 'bartonsprings'].map(s => `${session.businessId}-${s}`))
  expect(others.every(b => b.ownerInbox === true && b.paypalDemo === true && b.paypalMerchantId === null && b.demoSessionId === session.sid)).toBe(true)
  expect(session.businessIds).toHaveLength(4)
  expect(session.location).toMatchObject({ source: 'persona', label: 'Home · Travis Heights' })
  // John's history: three past, paid Willow visits with Ana
  const visits = createAppointment.mock.calls.map(c => c[0]).filter(v => !v.seededOther)   // other customers (demo/seedBookings) aside
  expect(visits).toHaveLength(3)
  expect(visits.every(v => v.businessId === session.businessId && v.unitId === 'staff-ana' && v.status === 'completed' && v.seeded)).toBe(true)
  expect(visits.every(v => new Date(v.startTime).getTime() < Date.now())).toBe(true)
  expect(saveCustomer.mock.calls[0][0]).toMatchObject({ customerId: `demo-${session.sid}-c`, demoSessionId: session.sid, name: 'John Doe' })
  expect(saveCustomer.mock.calls[0][0].email).toBeUndefined()

  expect(demo.sidFromToken(sessionToken)).toBe(session.sid)
  expect(verifyToken(ownerToken)).toMatchObject({ businessId: session.businessId, demoSid: session.sid })
  expect(demo.sidFromToken(ownerToken)).toBeNull()          // owner token can't drive the customer API
  expect(demo.sidFromToken('garbage')).toBeNull()

  const welcome = await inbox.list(session.sid)
  expect(welcome.map(m => m.role).sort()).toEqual(['customer', 'owner'])
  expect(sink.events.find(e => e.scope === `sess:${session.sid}`)?.title).toBe('Demo session started')
})

test('messages reach the session\'s inboxes by session and role; each business\'s owner messages carry its name', async () => {
  const { session } = await demo.createSession({ ip: '5.6.7.8' })
  const notify = require('../services/notify')
  const [own, other] = saveBusiness.mock.calls.slice(-4).map(c => c[0])
  const sam = saveCustomer.mock.calls.slice(-1)[0][0]
  expect(await notify.notifyOwner({ business: own, subject: 'New booking: Haircut', text: 'John booked', kind: 'new_booking' })).toBe(true)
  expect(await notify.notifyOwner({ business: other, subject: "New booking: Men's Cut", text: 'x' })).toBe(true)
  expect(await notify.notifyCustomer({ business: own, customer: sam, channel: 'web', subject: 'Confirmed: Haircut', text: 'See you then' })).toEqual(['inbox'])
  expect(await notify.notifyCustomer({ business: own, customer: { name: 'Walk-in' }, subject: 'x', text: 'x' })).toEqual([])
  const owner = await inbox.list(session.sid, { role: 'owner' })
  expect(owner.map(m => m.subject)).toContain('New booking: Haircut')
  expect(owner.find(m => m.kind === 'new_booking')).toMatchObject({ read: false, to: 'Willow & Co. Salon (owner)' })
  expect(owner.find(m => m.subject === "New booking: Men's Cut")).toMatchObject({ to: 'Bluebonnet Hair Studio (owner)', businessId: other.businessId })
  expect(owner.find(m => m.kind === 'new_booking')).toMatchObject({ businessId: own.businessId })
  expect((await inbox.list(session.sid, { role: 'customer' })).find(m => m.subject === 'Confirmed: Haircut')).toMatchObject({ to: 'John Doe', from: 'Willow & Co. Salon' })
  expect(JSON.stringify(await inbox.list(session.sid))).not.toMatch(/@/)
})

test('the Business side can switch to any business in the session, and only those', async () => {
  const { session } = await demo.createSession({ ip: '3.3.3.3' })
  const eastside = `${session.businessId}-eastside`
  expect(verifyToken(demo.ownerTokenFor(session, eastside))).toMatchObject({ businessId: eastside, demoSid: session.sid })
  expect(demo.ownerTokenFor(session, 'demo-someone-else')).toBeNull()
  expect(demo.ownerTokenFor(session, undefined)).toBeNull()
  // The owner AI link names the business; the customer link stays John's whole city.
  const tokenOf = url => url.split('/mcp/')[1]
  const links = demo.mcpLinks(session, eastside)
  expect(demo.mcpClaims(tokenOf(links.business))).toEqual({ sid: session.sid, role: 'business', bid: eastside })
  expect(demo.mcpClaims(tokenOf(links.customer))).toEqual({ sid: session.sid, role: 'customer' })
  // Willow, or a business from another session, gives the plain link: Willow.
  expect(demo.mcpClaims(tokenOf(demo.mcpLinks(session).business))).toEqual({ sid: session.sid, role: 'business' })
  expect(demo.mcpClaims(tokenOf(demo.mcpLinks(session, 'demo-other-x').business))).toEqual({ sid: session.sid, role: 'business' })
})

test('per-IP session limit (3/minute, so End then Start works)', async () => {
  for (let i = 0; i < 3; i++) await demo.createSession({ ip: '9.9.9.9' })
  await expect(demo.createSession({ ip: '9.9.9.9' })).rejects.toMatchObject({ code: 'DEMO_LIMIT' })
  await expect(demo.createSession({ ip: '8.8.8.8' })).resolves.toBeTruthy()
})

test('chat limit per session per hour', async () => {
  const { session } = await demo.createSession({ ip: '7.7.7.7' })
  for (let i = 0; i < demo.LIMITS.chatPerSessionPerHour; i++) await demo.checkChatLimits(session.sid)
  await expect(demo.checkChatLimits(session.sid)).rejects.toMatchObject({ code: 'DEMO_LIMIT' })
})

test('ending a session wipes bookings, customer, business, inbox and timeline', async () => {
  const { session } = await demo.createSession({ ip: '6.6.6.6' })
  getAppointmentsForBusiness.mockResolvedValue([{ appointmentId: 'a1', startTime: '2026-10-20T15:00:00Z' }, { appointmentId: 'a2', startTime: '2026-10-21T15:00:00Z' }])
  const r = await demo.endSession(session.sid, 'user')
  // the mocked query returns the same 2 bookings for each of the 4 businesses
  expect(r).toMatchObject({ ended: true, bookingsDeleted: 8 })
  expect(deleteAppointment).toHaveBeenCalledTimes(8)
  expect(deleteCustomer).toHaveBeenCalledWith(session.customerId)
  expect(deleteBusiness).toHaveBeenCalledTimes(4)
  expect(deleteBusiness).toHaveBeenCalledWith(session.businessId)
  expect(await demo.getActiveSession(session.sid)).toBeNull()
  expect(await inbox.list(session.sid)).toEqual([])
  expect(sink.events.filter(e => e.scope === `sess:${session.sid}`)).toEqual([])
})

test('a session past its 24h limit is treated as ended and wiped', async () => {
  const { session } = await demo.createSession({ ip: '4.4.4.4' })
  const realNow = Date.now
  Date.now = () => realNow() + 24 * 3600 * 1000 + 1
  try {
    expect(await demo.getActiveSession(session.sid)).toBeNull()
  } finally {
    Date.now = realNow
  }
  expect(deleteBusiness).toHaveBeenCalledWith(session.businessId)
})

