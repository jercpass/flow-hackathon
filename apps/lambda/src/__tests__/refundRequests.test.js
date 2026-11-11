'use strict'

// Refund requests: a customer asks for money
// back without cancelling; nothing moves until the business refunds (any amount)
// or declines, from its AI or the dashboard; the customer hears either way.

jest.mock('../services/dynamo/appointments', () => {
  const rows = []
  return {
    __rows: rows,
    getAppointmentsForBusiness: jest.fn(async (bid, from, to) => rows.filter(a => a.businessId === bid && (!from || a.startTime >= from) && (!to || a.startTime <= to)).map(a => ({ ...a }))),
    updateAppointment: jest.fn(async (bid, start, id, u) => { Object.assign(rows.find(a => a.appointmentId === id), JSON.parse(JSON.stringify(u))) }),
    createAppointment: jest.fn()
  }
})
jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn().mockResolvedValue({ customerId: 'sam', name: 'Sam Rivera', demoSessionId: 's1' }) }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn(), updateBusiness: jest.fn() }))
jest.mock('../services/redis', () => ({ releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['inbox']), notifyOwner: jest.fn().mockResolvedValue(true) }))
jest.mock('../core/refunds', () => ({ ...jest.requireActual('../core/refunds'), refundAppointment: jest.fn() }))

process.env.FLOW_LINK_SECRET = 'test-secret'
const appts = require('../services/dynamo/appointments')
const { getBusiness } = require('../services/dynamo/businesses')
const { notifyCustomer, notifyOwner } = require('../services/notify')
const { refundAppointment } = require('../core/refunds')
const { executeTool } = require('../services/tools')
const { BUSINESS_TOOLS } = require('../mcp/sessionServers')
const { createToken } = require('../utils/jwt')
const { handler } = require('../handlers/dashboardApi')
const { CATALOG, PERSONA } = require('../demo/templates')

const willow = { ...CATALOG[0].build(), businessId: 'biz-rr', demoSessionId: 's1', ownerInbox: true }
const spa = { ...CATALOG[3].build(), businessId: 'biz-spa', demoSessionId: 's1', ownerInbox: true }
const daysAgo = d => new Date(Date.now() - d * 86_400_000).toISOString()
const paidCut = (o = {}) => ({ appointmentId: 'aaaa1111-2222', businessId: 'biz-rr', customerId: 'sam', customerName: 'Sam Rivera', serviceId: 'svc-haircut', serviceName: 'Haircut', unitId: 'staff-ana', status: 'completed', startTime: daysAgo(2), endTime: daysAgo(1.95), amountPaid: 40, totalAmount: 40, paymentId: 'CAP1', paymentProvider: 'paypal', currency: 'USD', ...o })
const ctx = () => ({ catalog: [willow, spa], customer: { customerId: 'sam', name: 'Sam Rivera', demoSessionId: 's1' }, customerLocation: { ...PERSONA.home }, channel: 'mcp' })
const ownerTool = (name, args) => BUSINESS_TOOLS.find(t => t.name === name).run(willow, args)
const row = () => appts.__rows[0]
const dash = async (method, proxy, body, query) => {
  const r = await handler({ httpMethod: method, pathParameters: { proxy }, queryStringParameters: query || null, headers: { Authorization: `Bearer ${createToken({ businessId: 'biz-rr' }, 3600)}` }, body: body ? JSON.stringify(body) : null })
  return JSON.parse(r.body)
}

beforeEach(() => {
  jest.clearAllMocks()
  appts.__rows.length = 0
  appts.__rows.push(paidCut())
  getBusiness.mockResolvedValue(willow)
})

test('the customer asks after the visit: saved, the business is told, no money moves', async () => {
  const r = await executeTool('request_refund', { reason: 'Waited 40 minutes past my time', amount: 10 }, ctx())
  expect(r).toMatchObject({ requested: true, business: 'Willow & Co. Salon', service: 'Haircut', amount: '$10', owner_told: true })
  expect(r.message).toMatch(/Nothing is refunded yet/)
  expect(row().refundRequest).toMatchObject({ amount: 10, reason: 'Waited 40 minutes past my time', status: 'open' })
  expect(notifyOwner.mock.calls[0][0]).toMatchObject({ subject: expect.stringMatching(/^Refund asked: \$10, Haircut/), text: expect.stringMatching(/Sam Rivera asks for \$10 back on their Haircut[\s\S]*Their reason: Waited 40 minutes past my time/) })
  expect(refundAppointment).not.toHaveBeenCalled()
  // Asking twice while one is open is refused.
  expect((await executeTool('request_refund', { reason: 'again' }, ctx())).error).toMatch(/already a request/)
})

test('what can\'t be asked for', async () => {
  expect((await executeTool('request_refund', {}, ctx())).error).toMatch(/Pass reason/)
  expect((await executeTool('request_refund', { reason: 'x', amount: 99 }, ctx())).error).toBe("Ask for between $0.01 and $40 (what's left of the payment).")
  appts.__rows[0] = paidCut({ paymentId: null, paymentProvider: null })   // paid in person
  expect((await executeTool('request_refund', { reason: 'x' }, ctx())).error).toMatch(/No PayPal payment from the last 60 days/)
  appts.__rows[0] = paidCut({ seeded: true, paymentId: 'hist-1' })       // the demo's made-up history: never charged
  expect((await executeTool('request_refund', { reason: 'x' }, ctx())).error).toMatch(/No PayPal payment/)
  appts.__rows[0] = paidCut({ startTime: daysAgo(90) })                  // too long ago
  expect((await executeTool('request_refund', { reason: 'x' }, ctx())).error).toMatch(/No PayPal payment/)
})

test('the owner declines: the customer is told, with the reason, and sees it', async () => {
  await executeTool('request_refund', { reason: 'Did not like the cut' }, ctx())
  const list = await ownerTool('list_refund_requests', {})
  expect(list.requests[0]).toMatchObject({ booking_id: 'aaaa1111', asked: '$40', reason: 'Did not like the cut', refundable: '$40', asked_amount: 40 })
  const d = await ownerTool('decline_refund_request', { booking_id: 'aaaa1111', reason: 'The cut matched the photo you brought' })
  expect(d).toMatchObject({ declined: true, customer_notified: true })
  expect(notifyCustomer.mock.calls[0][0].text).toMatch(/won't refund it\. Their reason: The cut matched the photo you brought/)
  expect(refundAppointment).not.toHaveBeenCalled()
  const pays = await executeTool('get_my_payments', {}, ctx())
  expect(pays.payments[0].refund_request).toBe('asked for $40 back; the business said no: The cut matched the photo you brought')
  expect((await ownerTool('list_refund_requests', {})).message).toBe('No refund requests waiting.')
})

test('the owner refunds part of it from the dashboard: PayPal refunds, the request is answered', async () => {
  await executeTool('request_refund', { reason: 'Waited 40 minutes', amount: 20 }, ctx())
  expect((await dash('GET', 'bookings/refund-requests')).requests).toHaveLength(1)
  refundAppointment.mockResolvedValue({ refunded: true, amount: 10, status: 'COMPLETED', refundId: 'R9' })
  const r = await dash('POST', 'bookings/refund', { appointmentId: 'aaaa1111', amount: 10, reason: 'Sorry about the wait', confirm: true })
  expect(r).toMatchObject({ refunded: true, amount: '$10', refund_id: 'R9' })
  expect(refundAppointment.mock.calls[0][0]).toMatchObject({ amount: 10, initiatedBy: 'owner', reason: 'Sorry about the wait' })
  expect(row().refundRequest).toMatchObject({ status: 'refunded', refunded: 10 })
  expect((await dash('GET', 'bookings/refund-requests')).requests).toHaveLength(0)
  // Without confirm it's only a quote.
  refundAppointment.mockClear()
  expect(await dash('POST', 'bookings/refund', { appointmentId: 'aaaa1111', amount: 5 })).toMatchObject({ needs_confirmation: true, refund: '$5' })
  expect(refundAppointment).not.toHaveBeenCalled()
})

test('the dashboard declines too, and the bookings list carries the request', async () => {
  await executeTool('request_refund', { reason: 'Too short' }, ctx())
  const list = await dash('GET', 'bookings', null, { from: daysAgo(7), to: daysAgo(-7) })
  expect(list.bookings[0]).toMatchObject({ paidWithPayPal: true, refundRequest: { status: 'open', amount: 40 } })
  expect(await dash('POST', 'bookings/refund-request/decline', { appointmentId: 'aaaa1111' })).toMatchObject({ declined: true })
  expect(row().refundRequest.status).toBe('declined')
})

test('several paid bookings: the AI is asked which one', async () => {
  appts.__rows.push(paidCut({ appointmentId: 'bbbb2222', startTime: daysAgo(10), endTime: daysAgo(9.95) }))
  const r = await executeTool('request_refund', { reason: 'x' }, ctx())
  expect(r.message).toMatch(/which one/)
  expect(r.bookings).toHaveLength(2)
})

test("settings: Flow's demo PayPal account counts as connected (no false 'Connect PayPal' step)", async () => {
  expect((await dash('GET', 'settings')).paypalConnected).toBe(true)
  getBusiness.mockResolvedValue({ ...willow, paypalDemo: false, paypalMerchantId: null })
  expect((await dash('GET', 'settings')).paypalConnected).toBe(false)
})
