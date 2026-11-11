'use strict'

// "+ Add a business" (phase 2): a pin within 3
// miles of John's home, set up by Flow's AI or the judge's own AI over MCP,
// then bookable by John everywhere because it joins the session's businesses.

jest.mock('../services/dynamo/businesses', () => ({ saveBusiness: jest.fn(), deleteBusiness: jest.fn(), getBusiness: jest.fn(), updateBusiness: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ saveCustomer: jest.fn(), deleteCustomer: jest.fn(), getCustomer: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), deleteAppointment: jest.fn(), createAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ invalidateBusiness: jest.fn().mockResolvedValue() }))
jest.mock('../services/ai', () => ({ generate: jest.fn() }))

process.env.FLOW_LINK_SECRET = 'test-secret'
const { setStore, memory, store } = require('../services/demoStore')
const trace = require('../services/trace')
const demo = require('../core/demoSession')
const added = require('../core/addedBusiness')
const concierge = require('../core/concierge')
const ai = require('../services/ai')
const inbox = require('../services/demoInbox')
const { saveBusiness, getBusiness, updateBusiness } = require('../services/dynamo/businesses')
const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const { PERSONA } = require('../demo/templates')

let saved
beforeEach(() => {
  jest.clearAllMocks()
  setStore(memory())
  trace.setSink(trace.memorySink())
  getAppointmentsForBusiness.mockResolvedValue([])
  saved = {}
  saveBusiness.mockImplementation(async b => { saved[b.businessId] = JSON.parse(JSON.stringify(b)) })
  getBusiness.mockImplementation(async id => (saved[id] ? JSON.parse(JSON.stringify(saved[id])) : null))
  updateBusiness.mockImplementation(async (id, u) => { saved[id] = { ...saved[id], ...JSON.parse(JSON.stringify(u)) } })
})
afterAll(() => trace.setSink(null))

let ip = 0
const fresh = async () => (await demo.createSession({ ip: `10.9.0.${++ip}` })).session
const reload = sid => store().getSession(sid)
const near = { lat: 30.2500, lng: -97.7350 }   // about half a mile from John's home
const NAILS = 'Gel manicure $35, 45 minutes. Pedicure $45, 60 minutes, $10 deposit. Mia does both, Jo does manicures. Open Tue-Sun 10am-7pm. Cancel 24 hours ahead for a full refund, later gets nothing.'

test('a business can only go inside the 3-mile circle around John\'s home', async () => {
  const s = await fresh()
  expect(added.options(s)).toMatchObject({ home: { lat: PERSONA.home.lat, lng: PERSONA.home.lng }, radiusMiles: 3, max: 2, added: 0 })
  expect((await added.create(s, { name: 'Far Away Nails', kind: 'nails', lat: 30.3108, lng: -97.7255 })).error).toMatch(/4\.6 miles from the customer's home\. Pick a spot inside the 3-mile circle/)
  expect((await added.create(s, { name: 'Nails', kind: 'rockets', ...near })).error).toMatch(/Pick what kind of business/)
  expect((await added.create(s, { name: '', kind: 'nails', ...near })).error).toBe('Give the business a name.')
  // "Pick a spot for me" always lands inside.
  for (let i = 0; i < 50; i++) expect(added.randomSpot().miles).toBeLessThanOrEqual(3)
})

test('creating one: saved for the session, not set up yet, the owner gets a welcome; at most two', async () => {
  const s = await fresh()
  const r = await added.create(s, { name: 'Polished Nail Bar', kind: 'nails', ...near })
  expect(r).toMatchObject({ created: true, name: 'Polished Nail Bar', kind: 'nails', miles: expect.any(Number), location: { neighborhood: expect.any(String), address: expect.stringMatching(/^Near .*, Austin, TX$/) } })
  const biz = saved[r.businessId]
  expect(biz).toMatchObject({ addedByJudge: true, setupDone: false, category: 'nails', ownerInbox: true, paypalDemo: true, demoSessionId: s.sid })
  expect(biz.config.services).toEqual([])
  const after = await reload(s.sid)
  expect(after.businessIds).toContain(r.businessId)
  expect(after.addedBusinessIds).toEqual([r.businessId])
  expect(demo.ownerTokenFor(after, r.businessId)).toBeTruthy()
  expect((await inbox.list(s.sid, { role: 'owner' })).map(m => m.subject)).toContain('You added Polished Nail Bar')
  // Not bookable until it has services.
  expect((await concierge.loadCatalog(after.businessIds)).map(b => b.name)).not.toContain('Polished Nail Bar')
  await added.create(after, { name: 'Second', kind: 'fitness', ...near })
  expect((await added.create(await reload(s.sid), { name: 'Third', kind: 'spa', ...near })).error).toMatch(/2 added businesses per session/)
})

test("Flow's AI drafts it; gaps are filled so it can be booked; approving makes it bookable by John", async () => {
  const s = await fresh()
  const { businessId } = await added.create(s, { name: 'Polished Nail Bar', kind: 'nails', ...near })
  // The AI names services but no staff and no refund rules.
  ai.generate.mockResolvedValue({ text: JSON.stringify({ services: [{ name: 'Gel manicure', price: 35, duration: 45, unitType: 'person', paymentMode: 'full_prepaid' }, { name: 'Pedicure', price: 45, duration: 60, unitType: 'resource', paymentMode: 'deposit_fixed', depositAmount: 10 }], staff: [], availability: { open: '10:00', close: '19:00', workingDays: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } }) })
  const s2 = await reload(s.sid)
  expect((await added.draft(s2, businessId, { description: 'too short' })).error).toMatch(/Describe the business/)
  const d = await added.draft(s2, businessId, { description: NAILS })
  expect(ai.generate.mock.calls[0][0].parts.at(-1).text).toMatch(/Business type: Nail studio[\s\S]*Polished Nail Bar\. Gel manicure/)
  expect(d.draft.services.map(x => x.name)).toEqual(['Gel manicure', 'Pedicure'])
  expect(d.draft.staff).toEqual([{ name: 'Owner', services: ['Gel manicure', 'Pedicure'] }])
  expect(d.draft.notes.join(' ')).toMatch(/"Owner" does every service[\s\S]*standard ones are used/)
  expect((await added.state(s2, businessId)).draft).toMatchObject({ from: 'ai' })

  const a = await added.apply(s2, businessId)
  expect(a).toMatchObject({ applied: true, source: 'ai' })
  expect(saved[businessId]).toMatchObject({ setupDone: true })
  expect(saved[businessId].config.services.every(x => x.unitType === 'person')).toBe(true)
  expect(saved[businessId].config.policies.refundTiers.length).toBeGreaterThan(0)
  // John's city now has it: search finds it by kind, nearest first.
  const catalog = await concierge.loadCatalog(s2.businessIds)
  const found = concierge.search(catalog, PERSONA.home, {}, { query: 'nails' })
  expect(found[0]).toMatchObject({ name: 'Polished Nail Bar', category: 'nails', distanceMi: expect.any(Number) })
  expect(concierge.search(catalog, PERSONA.home, {}, { category: 'nails' }).map(x => x.name)).toEqual(['Polished Nail Bar'])
  expect((await added.apply(s2, businessId)).error).toMatch(/already set up/)
})

test("the judge's own AI sets it up over MCP: instructions and a prompt without Willow's documents, create_business quoted then confirmed", async () => {
  const s = await fresh()
  const { businessId } = await added.create(s, { name: 'Iron Hour Gym', kind: 'fitness', ...near })
  const session = await reload(s.sid)
  const { handler } = require('../handlers/mcp')
  const link = demo.mcpLinks(session, businessId).business
  const post = async (method, params) => JSON.parse((await handler({ httpMethod: 'POST', pathParameters: { token: link.split('/mcp/')[1] }, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).body).result
  const init = await post('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  expect(init.serverInfo.title).toBe('Flow — Iron Hour Gym (owner)')
  expect(init.instructions).toMatch(/Iron Hour Gym is a fitness studio the owner just added[\s\S]*Ask what they offer/)
  expect(init.instructions).not.toMatch(/Willow|documents \(the set_up_my_salon/)
  const names = (await post('tools/list', {})).tools.map(t => t.name)
  expect(names).toContain('create_business')
  expect(names).not.toContain('create_salon')
  expect((await post('prompts/list', {})).prompts.map(p => p.name)).toEqual(['set_up_my_business'])
  expect((await post('prompts/get', { name: 'set_up_my_business' })).messages[0].content.text).toMatch(/Call create_business WITHOUT confirm/)

  const input = { services: [{ name: 'Personal training', minutes: 60, price: 70, payment: 'full' }, { name: 'Group class', minutes: 45, price: 20, payment: 'none' }], staff: [{ name: 'Dee', services: ['Personal training', 'Group class'] }], hours: { open: '06:00', close: '21:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }, refund_rules: [{ hours_before: 12, refund_percent: 100 }] }
  const call = async args => (await post('tools/call', { name: 'create_business', arguments: args })).structuredContent
  const q = await call(input)
  expect(q).toMatchObject({ needs_confirmation: true, draft: { services: [{ name: 'Personal training' }, { name: 'Group class' }], staff: [{ name: 'Dee' }] } })
  expect(saved[businessId].setupDone).toBe(false)
  expect((await added.state(session, businessId)).draft).toMatchObject({ from: 'mcp' })
  expect(await call({ confirm: true })).toMatchObject({ created: true })
  expect(saved[businessId]).toMatchObject({ setupDone: true })
  expect(saved[businessId].config.availability).toMatchObject({ open: '06:00', close: '21:00' })
  // Set up: the tool and the prompt are gone; the normal owner instructions apply.
  expect((await post('tools/list', {})).tools.map(t => t.name)).not.toContain('create_business')
})

test('the demo API: list with the add options, create returns a token for the new business, setup routes are this session\'s only', async () => {
  const s = await fresh()
  const tokens = demo.tokensFor(s)
  const { handler } = require('../handlers/demo')
  const api = async (method, proxy, body, query) => {
    const r = await handler({ httpMethod: method, pathParameters: { proxy }, queryStringParameters: query || null, headers: { Authorization: `Bearer ${tokens.sessionToken}` }, body: body ? JSON.stringify(body) : null })
    return { status: r.statusCode, body: JSON.parse(r.body) }
  }
  const list = await api('GET', 'businesses')
  expect(list.body.add).toMatchObject({ radiusMiles: 3, max: 2, kinds: expect.arrayContaining([{ id: 'nails', label: 'Nail studio' }]) })
  const spot = await api('GET', 'businesses/spot')
  expect(spot.body.miles).toBeLessThanOrEqual(3)
  const made = await api('POST', 'businesses', { name: 'Polished Nail Bar', kind: 'nails', lat: spot.body.lat, lng: spot.body.lng })
  expect(made.status).toBe(200)
  expect(require('../utils/jwt').verifyToken(made.body.ownerToken)).toMatchObject({ businessId: made.body.businessId, demoSid: s.sid })
  expect((await api('GET', 'businesses')).body.businesses.find(b => b.businessId === made.body.businessId)).toMatchObject({ added: true, setupDone: false })
  expect((await api('GET', 'businesses/setup', null, { business: made.body.businessId })).body).toMatchObject({ setupDone: false, business: { kindLabel: 'Nail studio' } })
  expect((await api('GET', 'businesses/setup', null, { business: s.businessId })).status).toBe(400)   // Willow isn't an added business
  expect((await api('POST', 'businesses', { name: 'X', kind: 'nails', lat: 30.4, lng: -97.7 })).status).toBe(400)
})
