'use strict'

// MCP: protocol (JSON-RPC over Streamable HTTP, stateless), session link tokens,
// and the owner operations behind the business link (quote → confirm money moves).

jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), createAppointment: jest.fn(), updateAppointment: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn().mockResolvedValue(null) }))
jest.mock('../core/refunds', () => ({ quoteRefund: jest.fn(() => ({ pct: 50, amount: 20, refundable: 40 })), refundAppointment: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn() }))

process.env.FLOW_LINK_SECRET = 'test-secret'
process.env.API_URL = 'https://api.example.com/'
const { handleHttp, SUPPORTED_VERSIONS } = require('../mcp/protocol')
const demo = require('../core/demoSession')
const owner = require('../core/ownerOps')
const { getAppointmentsForBusiness, createAppointment, updateAppointment } = require('../services/dynamo/appointments')
const { refundAppointment } = require('../core/refunds')
const { getFreeUnitsForSlot } = require('../core/units')
const { CATALOG } = require('../demo/templates')

const server = {
  info: { name: 'test', version: '1' },
  instructions: 'be nice',
  listTools: async () => [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {}, required: [] } }],
  callTool: async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ name, args }) }] }),
  listResources: async () => [{ uri: 'x://r', name: 'r' }],
  readResource: async uri => ({ contents: [{ uri, text: 'hi' }] })
}
const post = async body => {
  const r = await handleHttp('POST', JSON.stringify(body), server)
  return { status: r.status, json: r.body ? JSON.parse(r.body) : null }
}

describe('protocol', () => {
  test('initialize negotiates the version and advertises tools + resources', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'c' }, capabilities: {} } })
    expect(r.json.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'test' }, instructions: 'be nice', capabilities: { tools: {}, resources: {} } })
    const unknown = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    expect(unknown.json.result.protocolVersion).toBe(SUPPORTED_VERSIONS[0])
  })
  test('notifications get 202 with no body', async () => {
    expect(await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ status: 202, json: null })
  })
  test('tools, resources and ping', async () => {
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json.result.tools[0].name).toBe('echo')
    expect(JSON.parse((await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })).json.result.content[0].text)).toEqual({ name: 'echo', args: { a: 1 } })
    expect((await post({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'x://r' } })).json.result.contents[0].text).toBe('hi')
    expect((await post({ jsonrpc: '2.0', id: 6, method: 'ping' })).json.result).toEqual({})
  })
  test('errors: unknown method, bad params, parse error, GET has no stream', async () => {
    expect((await post({ jsonrpc: '2.0', id: 7, method: 'nope' })).json.error.code).toBe(-32601)
    expect((await post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} })).json.error.code).toBe(-32602)
    const bad = await handleHttp('POST', '{not json', server)
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body).error.code).toBe(-32700)
    expect((await handleHttp('GET', null, server)).status).toBe(405)
  })
  test('batches answer every request and skip notifications', async () => {
    const r = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'ping' }])
    expect(r.json.map(x => x.id)).toEqual([1, 2])
  })
})

describe('session links', () => {
  const session = { sid: 'abcdef0123456789abcd', expiresAt: Date.now() + 3600_000 }
  test('two role-scoped links on the API base URL that decode back to the session', () => {
    const links = demo.mcpLinks(session)
    expect(links.customer).toMatch(/^https:\/\/api\.example\.com\/mcp\/[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(demo.mcpClaims(links.customer.split('/mcp/')[1])).toEqual({ sid: session.sid, role: 'customer' })
    expect(demo.mcpClaims(links.business.split('/mcp/')[1])).toEqual({ sid: session.sid, role: 'business' })
  })
  test('other tokens and garbage are rejected', () => {
    const { sessionToken } = demo.tokensFor(session)
    expect(demo.mcpClaims(sessionToken)).toBeNull()
    expect(demo.mcpClaims('nope')).toBeNull()
  })
})

describe('owner operations', () => {
  const biz = { ...CATALOG[0].build(), businessId: 'demo-x' }
  const future = new Date(Date.now() + 3 * 86400000).toISOString()
  const appt = { appointmentId: 'abcdef12-3456-7890-abcd-ef1234567890', businessId: 'demo-x', customerId: 'sam', customerName: 'Sam Rivera', serviceId: 'svc-haircut', serviceName: 'Haircut', unitId: 'staff-ana', startTime: future, endTime: new Date(Date.parse(future) + 3600000).toISOString(), status: 'confirmed', amountPaid: 40, paymentId: 'CAP1', currency: 'USD' }

  beforeEach(() => { jest.clearAllMocks(); getAppointmentsForBusiness.mockResolvedValue([appt]) })

  test('refund quotes first and only moves money with confirm=true', async () => {
    const q = await owner.refundBooking(biz, { booking_id: 'abcdef12' })
    expect(q).toMatchObject({ needs_confirmation: true, refund: '$40' })
    expect(refundAppointment).not.toHaveBeenCalled()
    refundAppointment.mockResolvedValue({ refunded: true, amount: 15, status: 'COMPLETED', refundId: 'R1' })
    const r = await owner.refundBooking(biz, { booking_id: 'abcdef12', amount: 15, confirm: true })
    expect(r).toMatchObject({ refunded: true, amount: '$15' })
    expect(refundAppointment.mock.calls[0][0]).toMatchObject({ amount: 15, initiatedBy: 'owner', requestSuffix: '-o0' })
  })

  test('refunds above what is left are refused', async () => {
    expect(await owner.refundBooking(biz, { booking_id: 'abcdef12', amount: 999 })).toMatchObject({ error: expect.stringContaining('between') })
  })

  test('paid in person: no PayPal refund is offered or attempted', async () => {
    getAppointmentsForBusiness.mockResolvedValue([{ ...appt, paymentId: null, createdVia: 'mcp_owner' }])
    for (const confirm of [false, true]) {
      expect((await owner.refundBooking(biz, { booking_id: 'abcdef12', amount: 10, confirm })).error).toBe("This was paid in person, not with PayPal, so Flow can't refund it. Refund the customer directly.")
    }
    expect(refundAppointment).not.toHaveBeenCalled()
    // The demo's made-up history was never charged either.
    getAppointmentsForBusiness.mockResolvedValue([{ ...appt, paymentId: 'hist-1', paymentProvider: 'paypal', seeded: true }])
    expect((await owner.refundBooking(biz, { booking_id: 'abcdef12', confirm: true })).error).toMatch(/made-up history/)
    expect(refundAppointment).not.toHaveBeenCalled()
  })

  test('cancel quotes per policy, then cancels and refunds', async () => {
    const q = await owner.cancelBooking(biz, { booking_id: 'abcdef12' })
    expect(q).toMatchObject({ needs_confirmation: true, refund: '$20', refund_rule: '50% under the cancellation policy' })
    expect(updateAppointment).not.toHaveBeenCalled()
    refundAppointment.mockResolvedValue({ refunded: true, amount: 20 })
    const r = await owner.cancelBooking(biz, { booking_id: 'abcdef12', confirm: true })
    expect(r).toMatchObject({ cancelled: true, refunded: true, refund: '$20' })
    expect(updateAppointment.mock.calls[0][3]).toMatchObject({ status: 'cancelled', cancelledBy: 'owner' })
  })

  test('block_time uses business-local times for every staff member', async () => {
    const r = await owner.blockTime(biz, { date: '2026-10-20', start_time: '12:00', end_time: '13:00', reason: 'Lunch' })
    expect(r).toMatchObject({ blocked: true, staff: 'all staff' })
    expect(createAppointment).toHaveBeenCalledTimes(2)
    expect(createAppointment.mock.calls[0][0]).toMatchObject({ status: 'blocked', startTime: '2026-10-20T17:00:00.000Z', serviceName: 'Lunch' })   // 12:00 CDT
    expect(await owner.blockTime(biz, { date: '20/10', start_time: '12', end_time: '1' })).toMatchObject({ error: expect.any(String) })
  })

  test('reschedule moves the booking, keeps the payment and frees the old slot', async () => {
    getFreeUnitsForSlot.mockResolvedValue(['staff-ana'])
    const r = await owner.rescheduleBooking(biz, { booking_id: 'abcdef12', new_time: '2027-10-21T15:00' })
    expect(r).toMatchObject({ rescheduled: true, staff: 'Ana' })
    expect(createAppointment.mock.calls[0][0]).toMatchObject({ startTime: '2027-10-21T20:00:00.000Z', paymentId: 'CAP1', amountPaid: 40, rescheduledFrom: appt.appointmentId })
    expect(updateAppointment.mock.calls[0][3]).toMatchObject({ status: 'cancelled', cancelledBy: 'owner_reschedule' })
    // The payment moved with it: the old record no longer claims it (else PayPal and the books disagree after a refund).
    const newId = createAppointment.mock.calls[0][0].appointmentId
    expect(updateAppointment.mock.calls[0][3]).toMatchObject({ movedTo: newId, paymentStatus: 'moved', amountPaid: 0, paymentId: null, invoiceId: null, invoiceNumber: null })
  })

  test('revenue and customers summarise paid bookings', async () => {
    expect(await owner.getRevenue(biz, { days: 7 })).toMatchObject({ bookings_paid: 1, collected: '$40', net: '$40' })
    expect((await owner.listCustomers(biz)).customers[0]).toMatchObject({ name: 'Sam Rivera', visits: 1, spent: '$40' })
  })
})

describe('calendar (Bryntum feed + drag-to-move)', () => {
  const biz = { ...CATALOG[0].build(), businessId: 'demo-x' }
  const future = '2027-10-21T15:00:00.000Z'   // 10:00 CDT
  const appt = { appointmentId: 'aaaaaaaa-1111-2222-3333-444444444444', businessId: 'demo-x', customerName: 'Jordan Lee', serviceId: 'svc-haircut', serviceName: 'Haircut', unitId: 'staff-ana', startTime: future, endTime: '2027-10-21T16:00:00.000Z', status: 'confirmed', amountPaid: 40, totalAmount: 40, createdVia: 'web' }
  const block = { appointmentId: 'bbbbbbbb-1111', businessId: 'demo-x', serviceName: 'Lunch', unitId: 'staff-ben', startTime: '2027-10-21T17:00:00.000Z', endTime: '2027-10-21T18:00:00.000Z', status: 'blocked' }

  beforeEach(() => { jest.clearAllMocks(); getAppointmentsForBusiness.mockResolvedValue([appt, block]) })

  test('feed: staff as resources, wall-clock local times, colours, blocks not draggable', async () => {
    const c = await owner.calendar(biz, { from_date: '2027-10-21', to_date: '2027-10-21' })
    expect(c.timezone).toBe('America/Chicago')
    expect(c.resources.map(r => r.name)).toEqual(['Ana', 'Ben'])
    const ev = c.events.find(e => e.id === appt.appointmentId)
    expect(ev).toMatchObject({ resourceId: 'staff-ana', startDate: '2027-10-21T10:00:00', endDate: '2027-10-21T11:00:00', customer: 'Jordan Lee', eventColor: 'blue', draggable: true, paid: '$40' })
    expect(c.events.find(e => e.id === block.appointmentId)).toMatchObject({ status: 'blocked', eventColor: 'gray', draggable: false, startDate: '2027-10-21T12:00:00' })
  })

  test('drop onto a stylist who does not offer the service is refused', async () => {
    const bluebonnetStyleBiz = { ...biz, config: { ...biz.config, staff: [...biz.config.staff, { staffId: 'staff-kim', name: 'Kim', services: ['svc-color'] }] } }
    getFreeUnitsForSlot.mockResolvedValue(['staff-ana', 'staff-kim'])
    expect(await owner.rescheduleBooking(bluebonnetStyleBiz, { booking_id: 'aaaaaaaa', new_time: '2027-10-21T11:00', unit_id: 'staff-kim' })).toEqual({ error: "Kim doesn't do Haircut." })
    expect(createAppointment).not.toHaveBeenCalled()
  })

  test('drop onto a busy stylist is refused; onto a free one it moves', async () => {
    getFreeUnitsForSlot.mockResolvedValue(['staff-ana'])
    expect(await owner.rescheduleBooking(biz, { booking_id: 'aaaaaaaa', new_time: '2027-10-21T13:00', unit_id: 'staff-ben' })).toMatchObject({ error: expect.stringContaining("Ben isn't free") })
    getFreeUnitsForSlot.mockResolvedValue(['staff-ana', 'staff-ben'])
    const ok = await owner.rescheduleBooking(biz, { booking_id: 'aaaaaaaa', new_time: '2027-10-21T11:00', unit_id: 'staff-ben' })
    expect(ok).toMatchObject({ rescheduled: true, staff: 'Ben', when: 'Thu, Oct 21, 11 AM' })
    expect(createAppointment.mock.calls[0][0]).toMatchObject({ unitId: 'staff-ben', startTime: '2027-10-21T16:00:00.000Z' })
  })

  test('a booking can slide later on the same stylist even though it overlaps its own old slot', async () => {
    getFreeUnitsForSlot.mockResolvedValue([])   // Ana looks busy — only because of this booking itself
    const r = await owner.rescheduleBooking(biz, { booking_id: 'aaaaaaaa', new_time: '2027-10-21T10:30', unit_id: 'staff-ana' })
    expect(r).toMatchObject({ rescheduled: true, staff: 'Ana' })
  })
})
