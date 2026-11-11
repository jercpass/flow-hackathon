'use strict'

// Setting the salon up from the owner's own AI over MCP:
// guided instructions + a ready-made prompt + the documents, create_salon
// (draft first, create on confirm), then changing it by asking.

jest.mock('../services/dynamo/businesses', () => ({ saveBusiness: jest.fn(), deleteBusiness: jest.fn(), getBusiness: jest.fn(), updateBusiness: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ saveCustomer: jest.fn(), deleteCustomer: jest.fn(), getCustomer: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), deleteAppointment: jest.fn(), createAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ invalidateBusiness: jest.fn().mockResolvedValue() }))
jest.mock('../services/rag', () => ({ ingestDocument: jest.fn(), describe: jest.fn(), query: jest.fn(), clearBusinessKnowledge: jest.fn().mockResolvedValue(0) }))
jest.mock('../services/ai', () => ({ generate: jest.fn() }))

process.env.FLOW_LINK_SECRET = 'test-secret'
const { setStore, memory, store } = require('../services/demoStore')
const trace = require('../services/trace')
const demo = require('../core/demoSession')
const { handleMessage } = require('../mcp/protocol')
const { businessServer } = require('../mcp/sessionServers')
const { saveBusiness, getBusiness, updateBusiness } = require('../services/dynamo/businesses')
const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const rag = require('../services/rag')

let saved
let sink
beforeEach(() => {
  jest.clearAllMocks()
  setStore(memory())
  sink = trace.memorySink(); trace.setSink(sink)
  getAppointmentsForBusiness.mockResolvedValue([])
  saved = {}
  saveBusiness.mockImplementation(async b => { saved[b.businessId] = JSON.parse(JSON.stringify(b)) })
  getBusiness.mockImplementation(async id => (saved[id] ? JSON.parse(JSON.stringify(saved[id])) : null))
  updateBusiness.mockImplementation(async (id, u) => { saved[id] = { ...saved[id], ...JSON.parse(JSON.stringify(u)) } })
})
afterAll(() => trace.setSink(null))

let ip = 0
async function guided() {
  const { session } = await demo.createSession({ ip: `10.1.0.${++ip}`, mode: 'guided' })
  return session.sid
}
// Like handlers/mcp: every request rebuilds the server from the live session + salon.
async function server(sid) {
  const session = await store().getSession(sid)
  return businessServer({ session, business: await getBusiness(session.businessId), clientLabel: 'business' })
}
const rpc = async (sid, method, params) => (await handleMessage({ jsonrpc: '2.0', id: 1, method, params }, await server(sid))).result
const call = async (sid, name, args = {}) => (await rpc(sid, 'tools/call', { name, arguments: args })).structuredContent

// What a client AI would send after reading the sample documents.
const FROM_DOCS = {
  services: [
    { name: 'Haircut', minutes: 60, price: 40, payment: 'full' },
    { name: 'Color & Gloss', minutes: 120, price: 120, payment: 'deposit', deposit_percent: 25 }
  ],
  staff: [{ name: 'Ana', services: ['Haircut', 'Color & Gloss'] }, { name: 'Ben', services: ['Haircut'] }],
  hours: { open: '09:00', close: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
  refund_rules: [{ hours_before: 48, refund_percent: 100 }, { hours_before: 24, refund_percent: 50 }],
  cancellation_text: '48h+ full refund, 24–48h half, under 24h none.'
}

test('an unset salon: guiding instructions, a ready-made prompt with every document, setup resources', async () => {
  const sid = await guided()
  const init = await rpc(sid, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } })
  expect(init.capabilities.prompts).toBeTruthy()
  expect(init.instructions).toMatch(/NOT set up yet/)
  expect(init.instructions).toMatch(/create_salon WITHOUT confirm/)

  const tools = (await rpc(sid, 'tools/list')).tools.map(t => t.name)
  expect(tools).toEqual(expect.arrayContaining(['create_salon', 'use_ready_made_salon', 'learn_documents', 'update_service', 'add_service', 'remove_service', 'update_staff', 'set_hours', 'set_refund_policy', 'get_schedule']))

  const prompts = (await rpc(sid, 'prompts/list')).prompts
  expect(prompts).toEqual([expect.objectContaining({ name: 'set_up_my_salon', title: 'Set up my salon' })])
  const prompt = (await rpc(sid, 'prompts/get', { name: 'set_up_my_salon' })).messages[0].content.text
  expect(prompt).toMatch(/South Congress/)                 // description
  expect(prompt).toMatch(/Haircut: 60 minutes, \$40/)       // price list
  expect(prompt).toMatch(/Ana: senior stylist/)            // team
  expect(prompt).toMatch(/Cancel 48 hours or more/)        // policy
  expect(prompt).toMatch(/Mary Street/)                    // FAQ
  expect(prompt).toMatch(/I want to see the draft before you create anything/)

  const resources = (await rpc(sid, 'resources/list')).resources.map(r => r.uri)
  expect(resources).toEqual(expect.arrayContaining(['flow://setup/status', 'flow://setup/description', 'flow://setup/documents/faq']))
  const status = JSON.parse((await rpc(sid, 'resources/read', { uri: 'flow://setup/status' })).contents[0].text)
  expect(status).toMatchObject({ set_up: false, next: expect.stringMatching(/create_salon/) })
  expect((await rpc(sid, 'resources/read', { uri: 'flow://setup/documents/team' })).contents[0].text).toMatch(/Ben: stylist/)
})

test('create_salon: draft first (shown on the setup page), created only on confirm, IDs matched to the template', async () => {
  const sid = await guided()
  const draft = await call(sid, 'create_salon', FROM_DOCS)
  expect(draft).toMatchObject({ needs_confirmation: true })
  expect(draft.draft.services.map(s => s.name)).toEqual(['Haircut', 'Color & Gloss'])
  expect(draft.draft.refundTiers).toEqual([{ hoursBefore: 48, refundPct: 100 }, { hoursBefore: 24, refundPct: 50 }, { hoursBefore: 0, refundPct: 0 }])
  const session = await store().getSession(sid)
  expect(session.setupDone).toBe(false)
  expect(saved[session.businessId].config.services).toEqual([])
  const page = await require('../core/demoSetup').state(session)
  expect(page.draft).toMatchObject({ from: 'mcp' })

  const done = await call(sid, 'create_salon', { confirm: true })
  expect(done).toMatchObject({ created: true, next: expect.stringMatching(/learn_documents/) })
  const biz = saved[session.businessId]
  expect(biz.config.services.map(s => s.serviceId).sort()).toEqual(['svc-color', 'svc-haircut'])
  expect(biz.config.staff.find(p => p.name === 'Ana').staffId).toBe('staff-ana')
  expect(await store().getSession(sid)).toMatchObject({ setupDone: true, setupSource: 'mcp' })
  expect(sink.events.map(e => e.title)).toEqual(expect.arrayContaining([expect.stringMatching(/created by the owner's own AI \(MCP\)/)]))

  // Once set up, the instructions switch to running the business, and create_salon refuses.
  expect((await rpc(sid, 'initialize', { protocolVersion: '2025-06-18' })).instructions).toMatch(/To change the setup use update_service/)
  expect((await call(sid, 'create_salon', FROM_DOCS)).error).toMatch(/already set up/)
})

test('learn_documents shows what Claude will store first, saves on confirm; the ready-made fallback works over MCP too', async () => {
  const sid = await guided()
  rag.ingestDocument.mockResolvedValue({ added: true, skipped: false })
  rag.describe.mockImplementation(async (buf, filename) => (filename.endsWith('.pdf')
    ? { file: filename, from: 'PDF, 1 page', storedAs: 'text', pages: 1, tokens: 470, pdfTokens: 2010, text: '[Page 1]\nWillow & Co. Salon: frequently asked questions' }
    : { file: filename, from: 'Text', storedAs: 'text', tokens: 90, text: 'Cancel 48 hours ahead for a full refund.' }))
  expect((await call(sid, 'use_ready_made_salon')).created).toBe(true)
  const q = await call(sid, 'learn_documents')
  expect(q.needs_confirmation).toBe(true)
  expect(q.will_store).toEqual(expect.arrayContaining([
    expect.objectContaining({ document: 'Salon FAQ', from: 'PDF, 1 page', saved_as: 'text', reads_per_question: 'about 470 tokens', as_a_pdf_it_would_be: 'about 2010 tokens' })
  ]))
  expect(rag.ingestDocument).not.toHaveBeenCalled()
  const k = await call(sid, 'learn_documents', { confirm: true })
  expect(k.docs.map(d => d.id).sort()).toEqual(['faq', 'policy'])
  expect(rag.ingestDocument).toHaveBeenCalledTimes(2)
})

describe('changing the setup by asking', () => {
  async function ready() {
    const sid = await guided()
    await call(sid, 'use_ready_made_salon')
    return sid
  }
  const svc = (sid, name) => saved[`demo-${sid}`].config.services.find(s => s.name === name)

  test('a price change is quoted, then applied on confirm', async () => {
    const sid = await ready()
    const q = await call(sid, 'update_service', { service_name: 'color and gloss', price: 130 })
    expect(q).toMatchObject({ needs_confirmation: true, changes: ['price: $120 → $130'] })
    expect(svc(sid, 'Color & Gloss').price).toBe(120)
    const r = await call(sid, 'update_service', { service_name: 'color and gloss', price: 130, confirm: true })
    expect(r.updated).toBe(true)
    expect(svc(sid, 'Color & Gloss').price).toBe(130)
    expect(r.setup.services.find(s => s.name === 'Color & Gloss')).toMatchObject({ price: '$130', payment: '25% deposit when booking' })
    // Length only: no money involved, applied straight away.
    expect((await call(sid, 'update_service', { service_name: 'Haircut', minutes: 45 })).updated).toBe(true)
    expect(svc(sid, 'Haircut').duration).toBe(45)
    // Switching to a fixed deposit drops the percent.
    await call(sid, 'update_service', { service_name: 'Color & Gloss', payment: 'deposit', deposit_amount: 30, confirm: true })
    expect(svc(sid, 'Color & Gloss')).toMatchObject({ paymentMode: 'deposit_fixed', depositAmount: 30 })
    expect(svc(sid, 'Color & Gloss').depositPercent).toBeUndefined()
  })

  test('add, then remove a service (quoted; removed services stay for past bookings)', async () => {
    const sid = await ready()
    expect((await call(sid, 'add_service', { name: 'Blowout', minutes: 45, price: 45 })).needs_confirmation).toBe(true)
    const r = await call(sid, 'add_service', { name: 'Blowout', minutes: 45, price: 45, staff_names: ['Ana'], confirm: true })
    expect(r.setup.services.map(s => s.name)).toContain('Blowout')
    expect(r.setup.staff.find(p => p.name === 'Ana').does).toContain('Blowout')
    expect(r.setup.staff.find(p => p.name === 'Ben').does).not.toContain('Blowout')
    expect((await call(sid, 'add_service', { name: 'Blowout', minutes: 30, price: 1 })).error).toMatch(/already a service/)
    const gone = await call(sid, 'remove_service', { service_name: 'Blowout', confirm: true })
    expect(svc(sid, 'Blowout').active).toBe(false)
    // Nobody is listed as doing a service that's no longer offered.
    expect(gone.setup.staff.find(p => p.name === 'Ana').does).not.toContain('Blowout')
  })

  test('staff: give Ben colour, add Mia (does everything by default)', async () => {
    const sid = await ready()
    const r = await call(sid, 'update_staff', { staff_name: 'Ben', add_services: ['Color & Gloss'] })
    expect(r.person.does.sort()).toEqual(['Color & Gloss', 'Haircut'])
    const m = await call(sid, 'update_staff', { staff_name: 'Mia' })
    expect(m).toMatchObject({ created: true, person: { name: 'Mia', does: ['Haircut', 'Color & Gloss'] } })
    expect((await call(sid, 'update_staff', { staff_name: 'Ben', add_services: ['Massage'] })).error).toMatch(/No service called "Massage"/)
  })

  test('hours and refund rules', async () => {
    const sid = await ready()
    const h = await call(sid, 'set_hours', { close: '19:00', days: ['tue', 'wed', 'thu', 'fri', 'sat'] })
    expect(h.setup.hours).toBe('09:00–19:00, Tue, Wed, Thu, Fri, Sat')
    expect((await call(sid, 'set_hours', { open: '20:00' })).error).toMatch(/before closing/)
    const q = await call(sid, 'set_refund_policy', { rules: [{ hours_before: 24, refund_percent: 100 }] })
    expect(q.needs_confirmation).toBe(true)
    const r = await call(sid, 'set_refund_policy', { rules: [{ hours_before: 24, refund_percent: 100 }], confirm: true })
    expect(saved[`demo-${sid}`].config.policies.refundTiers).toEqual([{ hoursBefore: 24, refundPct: 100 }, { hoursBefore: 0, refundPct: 0 }])
    expect(r.setup.refunds).toEqual(['24+ hours before: full refund', 'under 24 hours: no refund'])
  })
})

test('an owner link for another business in the session runs that business, without the setup tools', async () => {
  const sid = await guided()
  const session = await store().getSession(sid)
  const { handler } = require('../handlers/mcp')
  const post = async (link, method, params) => {
    const r = await handler({ httpMethod: 'POST', pathParameters: { token: link.split('/mcp/')[1] }, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return JSON.parse(r.body).result
  }
  const eastside = demo.mcpLinks(session, `${session.businessId}-eastside`).business
  expect((await post(eastside, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).serverInfo.title).toBe('Flow — Eastside Barber Co. (owner)')
  const names = (await post(eastside, 'tools/list', {})).tools.map(t => t.name)
  expect(names).toContain('get_schedule')
  expect(names).not.toContain('create_salon')
  // The session's own (guided, not set up) salon still has them.
  expect((await post(demo.mcpLinks(session).business, 'tools/list', {})).tools.map(t => t.name)).toContain('create_salon')
})

test('hide customer names from my own AI: off, real names; on, tokens out and decoded coming back', async () => {
  const sid = await guided()
  await call(sid, 'use_ready_made_salon')
  const session = await store().getSession(sid)
  const start = new Date(Date.now() + 86_400_000).toISOString()
  getAppointmentsForBusiness.mockResolvedValue([{ appointmentId: 'a1', businessId: session.businessId, customerId: 'c9', customerName: 'Maya Patel', serviceName: 'Haircut', serviceId: 'svc-haircut', status: 'confirmed', startTime: start, endTime: start }])

  expect(JSON.stringify(await call(sid, 'get_schedule'))).toMatch(/Maya Patel/)

  saved[session.businessId].config.ai_config = { ...saved[session.businessId].config.ai_config, hideCustomerNamesFromOwnerAi: true }
  const hidden = JSON.stringify(await call(sid, 'get_schedule'))
  expect(hidden).not.toMatch(/Maya/)
  expect(hidden).toMatch(/⟦pii:[A-Z2-7]{8}⟧/)
  // A token the owner's AI never got is refused.
  expect((await call(sid, 'get_schedule', { customer: '⟦pii:AAAAAAAA⟧' })).error).toMatch(/isn't one Flow gave you/)
})
