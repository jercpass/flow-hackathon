'use strict'

// Guided demo: the salon starts unset, the AI drafts it from the description and
// documents, IDs are matched back to the template (so Sam's "usual" survives),
// the knowledge base is built from the FAQ, and nothing breaks if the AI can't help.

jest.mock('../services/dynamo/businesses', () => ({ saveBusiness: jest.fn(), deleteBusiness: jest.fn(), getBusiness: jest.fn(), updateBusiness: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ saveCustomer: jest.fn(), deleteCustomer: jest.fn(), getCustomer: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), deleteAppointment: jest.fn(), createAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ invalidateBusiness: jest.fn().mockResolvedValue() }))
jest.mock('../services/rag', () => ({ ingestDocument: jest.fn(), ask: jest.fn(), query: jest.fn(), clearBusinessKnowledge: jest.fn().mockResolvedValue(0) }))
jest.mock('../services/ai', () => ({ generate: jest.fn() }))

process.env.FLOW_LINK_SECRET = 'test-secret'
const { setStore, memory, store } = require('../services/demoStore')
const trace = require('../services/trace')
const demo = require('../core/demoSession')
const demoSetup = require('../core/demoSetup')
const concierge = require('../core/concierge')
const { normalize } = require('../services/setupAi')
const { DOCS, docFile } = require('../demo/setupDocs')
const { CATALOG, PERSONA } = require('../demo/templates')
const ai = require('../services/ai')
const rag = require('../services/rag')
const { saveBusiness, getBusiness, updateBusiness } = require('../services/dynamo/businesses')
const { getAppointmentsForBusiness, createAppointment } = require('../services/dynamo/appointments')
const { executeTool } = require('../services/tools')

// What the AI might plausibly return for the sample documents: its own names
// and casing, staff skills by name, the refund tiers out of order.
const AI_DRAFT = {
  services: [
    { name: 'Color and Gloss', price: 120, duration: 120, unitType: 'person', paymentMode: 'deposit_percent', depositPercent: 25 },
    { name: 'Haircut', price: 40, duration: 60, unitType: 'person', paymentMode: 'full_prepaid' }
  ],
  staff: [{ name: 'Ben', services: ['Haircut'] }, { name: 'Ana', services: ['Haircut', 'Color & Gloss'] }],
  availability: { open: '9:00', close: '18:00', workingDays: ['Mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
  policies: { cancellation: '48h+ full refund, 24-48h half, under 24h none.', reschedule: 'Once, free, up to 2h before.', refundTiers: [{ hoursBefore: 24, refundPct: 50 }, { hoursBefore: 48, refundPct: 100 }] },
  ai_config: { tone: 'warm' }
}

let sink
let saved
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

async function guided() {
  const { session } = await demo.createSession({ ip: `10.0.0.${Math.floor(Math.random() * 250)}`, mode: 'guided' })
  return store().getSession(session.sid)
}

test('a guided session starts with the salon unset, but Sam still has three visits with Ana', async () => {
  const s = await guided()
  expect(s).toMatchObject({ mode: 'guided', setupDone: false })
  const willow = saved[s.businessId]
  expect(willow.config.services).toEqual([])
  expect(willow.config.staff).toEqual([])
  expect(willow.setupDone).toBe(false)
  // The other businesses are prebuilt as usual.
  expect(saved[`${s.businessId}-eastside`].config.services.length).toBeGreaterThan(0)
  // History comes from the template, not the (empty) live config.
  const visits = createAppointment.mock.calls.map(c => c[0]).filter(v => !v.seededOther)   // other customers (demo/seedBookings) aside
  expect(visits).toHaveLength(3)
  expect(visits.every(v => v.unitId === 'staff-ana' && ['svc-haircut', 'svc-color'].includes(v.serviceId) && v.totalAmount > 0)).toBe(true)
})

test('explore sessions are prebuilt (as before)', async () => {
  const { session } = await demo.createSession({ ip: '10.9.9.9' })
  expect(session).toMatchObject({ mode: 'explore', setupDone: true })
  expect(saved[session.businessId].config.services).toHaveLength(2)
})

test('the unset salon is not offered to customers until it has services', async () => {
  const s = await guided()
  const catalog = await concierge.loadCatalog(s.businessIds)
  expect(catalog.map(b => b.name)).not.toContain('Willow & Co. Salon')
  expect(catalog).toHaveLength(3)
})

describe('setupAi.normalize', () => {
  test('USD prices, deposits, staff skills by name, hours, refund tiers sorted with a 0% tail', () => {
    const c = normalize(AI_DRAFT)
    const color = c.services.find(s => s.name === 'Color and Gloss')
    const cut = c.services.find(s => s.name === 'Haircut')
    expect(color).toMatchObject({ price: 120, duration: 120, paymentMode: 'deposit_percent', depositPercent: 25, durationMode: 'fixed', active: true })
    expect(cut).toMatchObject({ price: 40, paymentMode: 'full_prepaid' })
    expect(cut.depositPercent).toBeUndefined()
    // "Color & Gloss" in the staff list matches the "Color and Gloss" service.
    expect(c.staff.find(p => p.name === 'Ana').services.sort()).toEqual([cut.serviceId, color.serviceId].sort())
    expect(c.staff.find(p => p.name === 'Ben').services).toEqual([cut.serviceId])
    expect(c.availability).toMatchObject({ open: '09:00', close: '18:00' })
    expect(c.availability.workingDays).toHaveLength(7)
    expect(c.policies.refundTiers).toEqual([{ hoursBefore: 48, refundPct: 100 }, { hoursBefore: 24, refundPct: 50 }, { hoursBefore: 0, refundPct: 0 }])
  })

  test('older drafts (staff as plain names, no policies) still work', () => {
    const c = normalize({ services: [{ name: 'Cut', price: 10, duration: 30 }], staff: ['Kim'] })
    expect(c.staff[0]).toMatchObject({ name: 'Kim', services: [c.services[0].serviceId] })
    expect(c.policies).toBeNull()
    expect(c.availability.workingDays).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'])
  })
})

test('generate → apply: the AI draft gets the template IDs back and becomes the salon', async () => {
  const s = await guided()
  ai.generate.mockResolvedValue({ text: JSON.stringify(AI_DRAFT) })

  const { draft } = await demoSetup.generate(s, { docIds: ['price-list', 'team', 'policy', 'faq'] })
  // The setup AI gets the description and the three setup documents, not the FAQ.
  const prompt = ai.generate.mock.calls[0][0].parts.map(p => p.text || '').join('\n')
  expect(prompt).toMatch(/South Congress/)
  expect(prompt).toMatch(/Haircut: 60 minutes, \$40/)
  expect(prompt).toMatch(/Cancel 48 hours or more/)
  expect(prompt).not.toMatch(/Mary Street/)
  expect(draft.services.map(s => s.name)).toEqual(['Color and Gloss', 'Haircut'])
  expect(draft.staff.find(p => p.name === 'Ana').services.sort()).toEqual(['Color and Gloss', 'Haircut'])
  expect(draft.refundTiers).toHaveLength(3)

  const out = await demoSetup.apply(s, { source: 'ai' })
  expect(out).toMatchObject({ applied: true, source: 'ai', notes: [] })
  const willow = saved[s.businessId]
  expect(willow.setupDone).toBe(true)
  expect(willow.config.services.map(x => x.serviceId).sort()).toEqual(['svc-color', 'svc-haircut'])
  expect(willow.config.staff.find(p => p.name === 'Ana')).toMatchObject({ staffId: 'staff-ana' })
  expect(willow.config.staff.find(p => p.name === 'Ana').services.sort()).toEqual(['svc-color', 'svc-haircut'])
  expect(willow.config.staff.find(p => p.name === 'Ben')).toMatchObject({ staffId: 'staff-ben', services: ['svc-haircut'] })
  expect(willow.config.currency).toBe('USD')
  expect((await store().getSession(s.sid))).toMatchObject({ setupDone: true, setupSource: 'ai' })

  // Now the salon is bookable and Sam's usual resolves to Ana.
  const catalog = await concierge.loadCatalog(s.businessIds)
  expect(catalog.map(b => b.name)).toContain('Willow & Co. Salon')
  getAppointmentsForBusiness.mockImplementation(async id => id === s.businessId ? createAppointment.mock.calls.map(c => c[0]) : [])
  const history = await concierge.visitHistory(catalog, s.customerId)
  expect(history[s.businessId]).toMatchObject({ visits: 3, usualStaff: 'Ana' })
  expect(sink.events.filter(e => e.layer === 'setup').map(e => e.title)).toEqual(expect.arrayContaining([expect.stringMatching(/Draft ready: 2 services, 2 staff, 3 refund rules/), expect.stringMatching(/created from the AI draft/)]))
})

test('if the AI fails, generate says so and the ready-made salon still works', async () => {
  const s = await guided()
  ai.generate.mockRejectedValue(Object.assign(new Error('503 overloaded'), { status: 503 }))
  await expect(demoSetup.generate(s, {})).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' })
  await expect(demoSetup.apply(s, { source: 'ai' })).rejects.toMatchObject({ code: 'NO_DRAFT' })
  const out = await demoSetup.apply(s, { source: 'template' })
  expect(out.source).toBe('template')
  const tpl = CATALOG[0].build().config
  expect(saved[s.businessId].config.services).toEqual(tpl.services)
  expect(saved[s.businessId].config.policies.refundTiers).toEqual(tpl.policies.refundTiers)
})

test('a draft without refund rules gets the standard ones, and says so', async () => {
  const s = await guided()
  ai.generate.mockResolvedValue({ text: JSON.stringify({ ...AI_DRAFT, policies: { cancellation: '', refundTiers: [] } }) })
  await demoSetup.generate(s, { docIds: ['price-list', 'team'] })
  const out = await demoSetup.apply(s, {})
  expect(out.notes[0]).toMatch(/standard ones/)
  expect(saved[s.businessId].config.policies.refundTiers).toHaveLength(3)
})

test('a draft with no services is refused (offer the ready-made salon)', async () => {
  const s = await guided()
  ai.generate.mockResolvedValue({ text: '{"services": []}' })
  await expect(demoSetup.generate(s, {})).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' })
})

test('learn: the FAQ (a real PDF) and policy go into the knowledge base', async () => {
  const s = await guided()
  rag.ingestDocument.mockImplementation(async (id, buf, filename) => ({ added: true, skipped: false, ...(filename.endsWith('.pdf') ? { pages: 2 } : {}) }))
  const k = await demoSetup.learn(s, { docIds: ['faq', 'policy', 'price-list'] })
  expect(rag.ingestDocument).toHaveBeenCalledTimes(2)      // the price list is setup-only
  const [bid, buf, filename, type] = rag.ingestDocument.mock.calls.find(c => c[2].endsWith('.pdf'))
  expect(bid).toBe(s.businessId)
  expect(type).toBe('application/pdf')
  expect(buf.slice(0, 5).toString()).toBe('%PDF-')
  expect(filename).toBe('Willow FAQ.pdf')
  expect(k).toMatchObject({ documents: 2, fallback: false })
  expect(k.docs.find(d => d.id === 'faq')).toMatchObject({ stored: true, pages: 2 })
  expect((await store().getSession(s.sid)).knowledge.documents).toBe(2)
})

test('learn falls back to a plain FAQ when Claude\'s Files API is unavailable', async () => {
  const s = await guided()
  rag.ingestDocument.mockRejectedValue(new Error('429 quota'))
  const k = await demoSetup.learn(s, { docIds: ['faq'] })
  expect(k).toMatchObject({ fallback: true, documents: 0 })
  expect(saved[s.businessId].config.faq).toMatch(/Mary Street/)
})

test('the sample FAQ PDF has real, extractable text', async () => {
  const pdf = require('pdf-parse')
  const file = await docFile('faq')
  const { text } = await pdf(file.buffer)
  expect(text).toMatch(/Mary Street/)
  expect(text).toMatch(/patch test/)
  expect(DOCS.map(d => d.id)).toEqual(['price-list', 'team', 'policy', 'faq'])
})

test('business_info with a question gets the answer Claude reads from the salon documents, with sources', async () => {
  const catalog = CATALOG.map((c, i) => ({ ...c.build(), businessId: i === 0 ? 'demo-x' : `demo-x-${c.slug}` }))
  const ctx = { catalog, customer: { customerId: 'sam', name: 'Sam Rivera' }, customerLocation: { ...PERSONA.home }, business: catalog[0] }
  rag.ask.mockResolvedValue({ answer: 'Yes, free parking behind the building, off Mary Street.', sources: [{ file: 'Willow FAQ.pdf', quote: 'Free parking behind the building, off Mary Street.', page: 1 }], documents: 2, model: 'claude-haiku-5-5', usage: { input_tokens: 30, cache_read_input_tokens: 4000 } })
  const info = await executeTool('business_info', { business_name: 'Willow & Co. Salon', question: 'is there parking?' }, ctx)
  expect(rag.ask).toHaveBeenCalledWith('demo-x', 'is there parking?', { businessName: 'Willow & Co. Salon' })
  expect(info.fromDocuments).toEqual({ answer: 'Yes, free parking behind the building, off Mary Street.', sources: [{ from: 'Willow FAQ.pdf', quote: 'Free parking behind the building, off Mary Street.', page: 1 }] })
  // Documents that don't cover it: no fromDocuments, the FAQ fields answer.
  rag.ask.mockResolvedValue({ answer: null, sources: [], documents: 2, model: 'claude-haiku-5-5' })
  expect((await executeTool('business_info', { business_name: 'Willow & Co. Salon', question: 'gift cards?' }, ctx)).fromDocuments).toBeUndefined()
  // A failing read doesn't break the answer.
  rag.ask.mockRejectedValue(new Error('Claude down'))
  const again = await executeTool('business_info', { business_name: 'Willow & Co. Salon', question: 'parking?' }, ctx)
  expect(again.fromDocuments).toBeUndefined()
  expect(again.name).toBe('Willow & Co. Salon')
})

test('ending the session wipes the knowledge base too', async () => {
  const s = await guided()
  await demo.endSession(s.sid)
  expect(rag.clearBusinessKnowledge).toHaveBeenCalledWith(s.businessId)
})
