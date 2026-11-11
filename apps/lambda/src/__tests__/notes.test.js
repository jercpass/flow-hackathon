'use strict'

// Customer notes (allergies, care needs, what a photo/PDF/voice note said) end
// up on the booking the owner sees: at booking time (book_appointment notes)
// or later (add_booking_note), from web chat, the voice assistant or MCP.

jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), createAppointment: jest.fn(), updateAppointment: jest.fn() }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn() }))
jest.mock('../services/notify', () => ({ notifyOwner: jest.fn().mockResolvedValue(true), notifyCustomer: jest.fn() }))

const { getAppointmentsForBusiness, updateAppointment } = require('../services/dynamo/appointments')
const { notifyOwner } = require('../services/notify')
const concierge = require('../core/concierge')
const { CATALOG, PERSONA } = require('../demo/templates')
const { executeTool, getTools, hasSideEffects } = require('../services/tools')
const { customerServer } = require('../mcp/sessionServers')

const catalog = CATALOG.map((c, i) => ({ ...c.build(), businessId: i === 0 ? 'demo-x' : `demo-x-${c.slug}`, demoSessionId: 'x', ownerInbox: i === 0 }))
const customer = { customerId: 'sam', name: 'Sam Rivera' }
const ctx = (channel = 'web') => ({ catalog, customer, customerLocation: { ...PERSONA.home }, business: catalog[0], channel })
const inDays = (d, hourUtc = 20) => { const t = new Date(Date.now() + d * 86_400_000); t.setUTCHours(hourUtc, 0, 0, 0); return t.toISOString() }

const haircut = { appointmentId: 'a1', customerId: 'sam', serviceName: 'Haircut', status: 'confirmed', startTime: inDays(3), customerNotes: null }
const color = { appointmentId: 'a2', customerId: 'sam', serviceName: 'Color & Gloss', status: 'confirmed', startTime: inDays(10) }

beforeEach(() => {
  jest.clearAllMocks()
  getAppointmentsForBusiness.mockImplementation(async id => (id === 'demo-x' ? [haircut] : []))
})

test('add_booking_note saves the note on the upcoming booking and alerts the owner', async () => {
  const r = await executeTool('add_booking_note', { note: "From a doctor's note (PDF): allergic to ammonia, use ammonia-free colour" }, ctx())
  expect(r).toMatchObject({ saved: true, service: 'Haircut' })
  expect(updateAppointment).toHaveBeenCalledWith('demo-x', haircut.startTime, 'a1', { customerNotes: "From a doctor's note (PDF): allergic to ammonia, use ammonia-free colour" })
  expect(notifyOwner).toHaveBeenCalledTimes(1)
  expect(notifyOwner.mock.calls[0][0]).toMatchObject({ kind: 'booking_note', subject: expect.stringMatching(/^Note from Sam Rivera: Haircut/), text: expect.stringContaining('allergic to ammonia') })
})

test('earlier notes are kept; the new one goes on the next line', async () => {
  getAppointmentsForBusiness.mockImplementation(async id => (id === 'demo-x' ? [{ ...haircut, customerNotes: 'Prefers a quiet chair' }] : []))
  await executeTool('add_booking_note', { note: 'From a voice note: sensitive scalp' }, ctx('speaker'))
  expect(updateAppointment.mock.calls[0][3]).toEqual({ customerNotes: 'Prefers a quiet chair\nFrom a voice note: sensitive scalp' })
})

test('with no upcoming booking it says to pass the note when booking (nothing saved)', async () => {
  getAppointmentsForBusiness.mockResolvedValue([])
  const r = await executeTool('add_booking_note', { note: 'allergic to ammonia' }, ctx())
  expect(r.error).toMatch(/book_appointment/)
  expect(updateAppointment).not.toHaveBeenCalled()
})

test('with two bookings and no hint it asks which; a service name picks one', async () => {
  getAppointmentsForBusiness.mockImplementation(async id => (id === 'demo-x' ? [haircut, color] : []))
  const ask = await executeTool('add_booking_note', { note: 'allergic to ammonia' }, ctx())
  expect(ask.message).toMatch(/which one/)
  expect(updateAppointment).not.toHaveBeenCalled()
  const r = await executeTool('add_booking_note', { note: 'allergic to ammonia', service_name: 'color' }, ctx())
  expect(r).toMatchObject({ saved: true, service: 'Color & Gloss' })
  expect(updateAppointment.mock.calls[0][2]).toBe('a2')
})

test('it is a side-effect tool, offered in concierge mode and on the customer MCP link', async () => {
  expect(hasSideEffects('add_booking_note')).toBe(true)
  const tool = getTools(ctx()).find(t => t.name === 'add_booking_note')
  expect(tool.required).toEqual(['note'])
  expect(tool.parameters.business_name).toBeTruthy()      // optional: finds the right business itself

  const server = customerServer({ session: { sid: 'x' }, ctx: { ...ctx('mcp'), customer: { ...customer } }, clientLabel: 'test' })
  expect((await server.listTools()).map(t => t.name)).toContain('add_booking_note')
  expect(server.instructions).toMatch(/add_booking_note/)
  const out = await server.callTool('add_booking_note', { note: 'From a photo Sam shared: wants a curtain fringe' })
  expect(out.isError).toBeFalsy()
  expect(updateAppointment).toHaveBeenCalledTimes(1)
})

test('book_appointment takes notes from any source, and the prompt says so', () => {
  const book = getTools(ctx()).find(t => t.name === 'book_appointment')
  expect(book.parameters.notes.description).toMatch(/typed message, a voice note, a photo or a document/)
  const p = concierge.buildPrompt({ customer, location: { ...PERSONA.home }, catalog, history: {} })
  expect(p).toMatch(/typed it, said it in a voice note, or sent it as a photo or document/)
  expect(p).toMatch(/add_booking_note/)
  expect(p).toMatch(/Only say it's noted after the tool saved it/)
})
