'use strict'

// MCP can do everything (part B):
// the owner tools for the rest of the dashboard, the customer's payments and
// history, and a coverage check so the dashboard and MCP can't drift apart.

jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), createAppointment: jest.fn(), updateAppointment: jest.fn() }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn(), updateBusiness: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn() }))
jest.mock('../services/dynamo/knowledgeChunks', () => ({ getChunksForBusiness: jest.fn() }))
jest.mock('../services/redis', () => ({ reserveSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn().mockResolvedValue() }))
jest.mock('../services/rag', () => ({ ...jest.requireActual('../services/rag'), ingestDocument: jest.fn(), clearBusinessKnowledge: jest.fn(), query: jest.fn(), ask: jest.fn(), removeDocument: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn() }))
jest.mock('../core/paymentFlow', () => ({ requestBalancePayment: jest.fn() }))
jest.mock('../services/payments', () => ({ getPaymentProvider: () => ({ id: 'paypal', isConfigured: () => true }) }))
jest.mock('../services/notify', () => ({ notifyOwner: jest.fn(), notifyCustomer: jest.fn() }))

const fs = require('fs')
const path = require('path')
const { getAppointmentsForBusiness, createAppointment, updateAppointment } = require('../services/dynamo/appointments')
const { updateBusiness } = require('../services/dynamo/businesses')
const { getCustomer } = require('../services/dynamo/customers')
const { getChunksForBusiness } = require('../services/dynamo/knowledgeChunks')
const rag = require('../services/rag')
const { getFreeUnitsForSlot } = require('../core/units')
const { requestBalancePayment } = require('../core/paymentFlow')
const manage = require('../core/ownerManage')
const { BUSINESS_TOOLS } = require('../mcp/sessionServers')
const { executeTool, getTools } = require('../services/tools')
const { CATALOG, PERSONA } = require('../demo/templates')

const willow = () => ({ ...CATALOG[0].build(), businessId: 'demo-x', demoSessionId: 'x', ownerInbox: true })
const inDays = d => new Date(Date.now() + d * 86_400_000).toISOString()
const color = { appointmentId: 'abcdef12-0000', businessId: 'demo-x', customerId: 'sam', customerName: 'Sam Rivera', serviceId: 'svc-color', serviceName: 'Color & Gloss', unitId: 'staff-ana', status: 'confirmed', startTime: inDays(3), endTime: inDays(3.1), totalAmount: 120, amountPaid: 30, currency: 'USD' }

beforeEach(() => {
  jest.clearAllMocks()
  getAppointmentsForBusiness.mockResolvedValue([color])
  getFreeUnitsForSlot.mockResolvedValue(['staff-ana', 'staff-ben'])
})

describe('owner tools', () => {
  test('add_booking: a walk-in for Ben, paid in person', async () => {
    const r = await manage.addBooking(willow(), { service_name: 'haircut', start_time: '2026-10-21T10:00', staff_name: 'ben', customer_name: 'Jo', paid: true })
    expect(r).toMatchObject({ booked: true, service: 'Haircut', staff: 'Ben', customer: 'Jo', payment: 'paid in person' })
    expect(createAppointment.mock.calls[0][0]).toMatchObject({ unitId: 'staff-ben', amountPaid: 40, paymentStatus: 'paid', createdVia: 'mcp_owner', customerName: 'Jo' })
    expect((await manage.addBooking(willow(), { service_name: 'Color & Gloss', start_time: '2026-10-21T10:00', staff_name: 'Ben' })).error).toMatch(/Ben doesn't do Color & Gloss/)
    getFreeUnitsForSlot.mockResolvedValue([])
    expect((await manage.addBooking(willow(), { service_name: 'Haircut', start_time: '2026-10-21T10:00' })).error).toMatch(/Nothing is free/)
  })

  test('add_booking for someone who has booked before: it is theirs, and they are told', async () => {
    const { notifyCustomer } = require('../services/notify')
    getCustomer.mockResolvedValue({ customerId: 'sam', name: 'Sam Rivera', demoSessionId: 'x' })
    notifyCustomer.mockResolvedValue(['inbox'])
    const r = await manage.addBooking(willow(), { service_name: 'Haircut', start_time: '2026-10-27T11:00', customer_name: 'sam rivera' })
    expect(r).toMatchObject({ booked: true, customer: 'Sam Rivera', customer_notified: true })
    expect(r.warning).toBeUndefined()
    expect(createAppointment.mock.calls[0][0]).toMatchObject({ customerId: 'sam', customerName: 'Sam Rivera' })
    expect(notifyCustomer.mock.calls[0][0]).toMatchObject({ channel: 'inbox', subject: 'Booked: Haircut, Tue, Oct 27, 11 AM', text: 'Willow & Co. Salon booked your Haircut for Tue, Oct 27, 11 AM. $40 to pay at the salon.' })
    // A new name stays a walk-in: nobody is told.
    const jo = await manage.addBooking(willow(), { service_name: 'Haircut', start_time: '2026-10-27T12:00', customer_name: 'Jo' })
    expect(jo).toMatchObject({ customer: 'Jo', customer_notified: false })
    expect(createAppointment.mock.calls[1][0].customerId).toBeNull()
  })

  test("add_booking at a business Sam hasn't been to yet: still Sam's, because Sam is the session's customer", async () => {
    const demoSession = require('../core/demoSession')
    const spy = jest.spyOn(demoSession, 'getActiveSession').mockResolvedValue({ sid: 'x', customerId: 'sam' })
    getAppointmentsForBusiness.mockResolvedValue([])   // no visits here
    getCustomer.mockResolvedValue({ customerId: 'sam', name: 'Sam Rivera', demoSessionId: 'x' })
    const eastside = { ...CATALOG[2].build(), businessId: 'demo-x-eastside', demoSessionId: 'x', ownerInbox: true }
    const r = await manage.addBooking(eastside, { service_name: 'Beard Trim', start_time: '2026-10-27T15:00', customer_name: 'Sam Rivera' })
    expect(r).toMatchObject({ booked: true, customer: 'Sam Rivera' })
    expect(createAppointment.mock.calls[0][0].customerId).toBe('sam')
    expect(spy).toHaveBeenCalledWith('x')
    spy.mockRestore()
  })

  test('the owner can book or move after hours, and is warned', async () => {
    const late = await manage.addBooking(willow(), { service_name: 'Haircut', start_time: '2026-10-27T23:00', customer_name: 'Jo' })
    expect(late).toMatchObject({ booked: true, warning: "Outside your opening hours (you're open 09:00–18:00). It's booked anyway; tell the owner." })
    const owner = require('../core/ownerOps')
    const spy = jest.spyOn(owner, 'rescheduleBooking').mockResolvedValue({ rescheduled: true })
    expect((await manage.moveBooking(willow(), { booking_id: 'abcdef12', new_time: '2026-10-27T21:00' })).warning).toMatch(/^Outside your opening hours/)
    expect((await manage.moveBooking(willow(), { booking_id: 'abcdef12', new_time: '2026-10-27T10:00' })).warning).toBeUndefined()
    spy.mockRestore()
  })

  test('reschedule_booking can move a booking to another stylist at the same time', async () => {
    const owner = require('../core/ownerOps')
    const spy = jest.spyOn(owner, 'rescheduleBooking').mockResolvedValue({ rescheduled: true })
    await manage.moveBooking(willow(), { booking_id: 'abcdef12', staff_name: 'Ben' })
    expect(spy.mock.calls[0][1]).toMatchObject({ booking_id: 'abcdef12', unit_id: 'staff-ben', new_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) })
    spy.mockRestore()
  })

  test('update_booking_status: completed / no-show', async () => {
    const r = await manage.updateBookingStatus(willow(), { booking_id: 'abcdef12', status: 'no-show' })
    expect(r).toMatchObject({ updated: true, status: 'no_show' })
    expect(updateAppointment).toHaveBeenCalledWith('demo-x', color.startTime, color.appointmentId, { status: 'no_show' })
    expect((await manage.updateBookingStatus(willow(), { booking_id: 'abcdef12', status: 'lost' })).error).toMatch(/came \(completed\), no_show, or confirmed/)
  })

  test('request_balance: quoted, then a PayPal link for the rest goes to their inbox', async () => {
    getCustomer.mockResolvedValue({ customerId: 'sam', name: 'Sam Rivera', demoSessionId: 'x' })
    requestBalancePayment.mockResolvedValue({ paymentUrl: 'https://paypal.test/pay' })
    const q = await manage.requestBalance(willow(), { booking_id: 'abcdef12' })
    expect(q.needs_confirmation).toBe(true)
    expect(q.changes[0]).toMatch(/\$90/)
    expect(requestBalancePayment).not.toHaveBeenCalled()
    const r = await manage.requestBalance(willow(), { booking_id: 'abcdef12', confirm: true })
    expect(r).toMatchObject({ sent: true, balance: '$90', payment_link: 'https://paypal.test/pay' })
  })

  test('remove_staff warns about upcoming bookings and needs confirm', async () => {
    const q = await manage.removeStaff(willow(), { staff_name: 'Ana' })
    expect(q.changes[1]).toBe('1 upcoming booking with Ana stays booked; move it first with reschedule_booking')
    expect(updateBusiness).not.toHaveBeenCalled()
    const r = await manage.removeStaff(willow(), { staff_name: 'Ana', confirm: true })
    expect(r.setup.staff.map(p => p.name)).toEqual(['Ben'])
  })

  test('update_business_info: name and tone; there is no email to change', async () => {
    const r = await manage.updateBusinessInfo(willow(), { name: 'Willow & Co.', assistant_tone: 'playful' })
    expect(r.changes).toEqual(['name: Willow & Co.', 'assistant tone: playful'])
    expect(updateBusiness.mock.calls[0][1]).toMatchObject({ name: 'Willow & Co.', config: expect.objectContaining({ ai_config: expect.objectContaining({ tone: 'playful' }) }) })
    expect((await manage.updateBusinessInfo(willow(), { email: 'me@example.com' })).error).toMatch(/Nothing to change/)
    expect(JSON.stringify(updateBusiness.mock.calls)).not.toMatch(/ownerEmail|@/)
  })

  test('knowledge base: add, list, ask (answer and quotes), remove and clear (quoted)', async () => {
    rag.ingestDocument.mockResolvedValue({ added: true, skipped: false })
    const a = await manage.addKnowledge(willow(), { title: 'Aftercare', text: 'Wait 48 hours before washing coloured hair.' })
    expect(a).toMatchObject({ added: true, file: 'Aftercare.txt' })
    getChunksForBusiness.mockResolvedValue([
      { fileId: 'file_a', sourceFile: 'Aftercare.txt', sourceHash: 'h1', kind: 'text', preview: 'Wait 48 hours', createdAt: '2026-10-30T10:00:00Z' },
      { fileId: 'file_b', sourceFile: 'Willow FAQ.pdf', sourceHash: 'h2', kind: 'pdf', pages: 2, preview: 'Parking', createdAt: '2026-10-30T09:00:00Z' },
      { chunkId: 'old', sourceFile: 'from before.pdf', sourceHash: 'h0', text: 'an old embedded section' }
    ])
    const list = (await manage.listKnowledge(willow())).documents
    expect(list.map(d => ({ file: d.file, kind: d.kind, pages: d.pages }))).toEqual([{ file: 'Aftercare.txt', kind: 'Text', pages: undefined }, { file: 'Willow FAQ.pdf', kind: 'PDF', pages: 2 }])
    expect(JSON.stringify(list)).not.toMatch(/file_[ab]/)

    rag.ask.mockResolvedValue({ answer: 'Yes, behind the building.', sources: [{ file: 'Willow FAQ.pdf', quote: 'Free parking behind the building', page: 1 }], documents: 2, model: 'claude-haiku-5-5' })
    expect(await manage.askKnowledge(willow(), { question: 'Is there parking?' })).toMatchObject({ answer: 'Yes, behind the building.', sources: [{ from: 'Willow FAQ.pdf', quote: 'Free parking behind the building', page: 1 }] })
    rag.ask.mockResolvedValue({ answer: null, sources: [], documents: 2 })
    expect((await manage.askKnowledge(willow(), { question: 'Gift cards?' })).message).toMatch(/don't cover this/)

    expect((await manage.removeKnowledge(willow(), { file: 'faq' })).needs_confirmation).toBe(true)
    expect(rag.removeDocument).not.toHaveBeenCalled()
    expect(await manage.removeKnowledge(willow(), { file: 'Willow FAQ.pdf', confirm: true })).toMatchObject({ removed: true, file: 'Willow FAQ.pdf' })
    expect(rag.removeDocument).toHaveBeenCalledWith(willow().businessId, 'h2')

    expect((await manage.clearKnowledge(willow(), {})).needs_confirmation).toBe(true)
    rag.clearBusinessKnowledge.mockResolvedValue(2)
    expect(await manage.clearKnowledge(willow(), { confirm: true })).toMatchObject({ cleared: true, documents_deleted: 2 })
  })

  test('paypal_connect: the demo sandbox account (Flow\'s own) in one step', async () => {
    process.env.PAYPAL_CLIENT_ID = 'id'; process.env.PAYPAL_CLIENT_SECRET = 'secret'
    process.env.PAYPAL_PLATFORM_EMAIL = 'sb-platform@business.example.com'
    const r = await manage.paypalConnect(willow(), { use_demo_account: true })
    expect(r).toMatchObject({ connected: true, sandbox: true, account: 'sb-platform@business.example.com' })
    // No payee: the money, refunds, invoices and memberships live in the account that owns the app.
    expect(updateBusiness.mock.calls[0][1]).toMatchObject({ paypalMerchantId: null, paypalDemo: true })
    delete process.env.PAYPAL_PLATFORM_EMAIL
  })

  test('paypal_connect: when PayPal refuses (no partner access), say so and point to the demo account', async () => {
    process.env.PAYPAL_CLIENT_ID = 'id'; process.env.PAYPAL_CLIENT_SECRET = 'secret'
    const paypal = require('../services/payments/paypal')
    const spy = jest.spyOn(paypal, 'createOnboardingLink').mockRejectedValue(Object.assign(new Error('PayPal 403 NOT_AUTHORIZED'), { status: 403, code: 'NOT_AUTHORIZED' }))
    const r = await manage.paypalConnect(willow(), {})
    expect(r).toMatchObject({ error: expect.stringMatching(/partner access/), use_demo_account: true })
    spy.mockRestore()
  })
})

describe('customer tools', () => {
  const catalog = CATALOG.map((c, i) => ({ ...c.build(), businessId: i === 0 ? 'demo-x' : `demo-x-${c.slug}` }))
  const ctx = { catalog, customer: { customerId: 'sam', name: 'Sam Rivera' }, customerLocation: { ...PERSONA.home }, business: catalog[0] }
  const seeded = { ...color, appointmentId: 'h1', startTime: inDays(-35), status: 'completed', amountPaid: 40, seeded: true, serviceName: 'Haircut' }
  const refunded = { ...color, appointmentId: 'r1', startTime: inDays(-2), status: 'cancelled', amountPaid: 40, refundAmount: 40, refundStatus: 'COMPLETED', paymentProvider: 'paypal', paymentId: 'CAP-R1', serviceName: 'Haircut' }

  test('get_my_payments: real payments and refunds, not the seeded history', async () => {
    getAppointmentsForBusiness.mockImplementation(async id => (id === 'demo-x' ? [color, seeded, refunded] : []))
    const r = await executeTool('get_my_payments', {}, ctx)
    expect(r.payments).toHaveLength(2)
    expect(r.payments.find(p => p.refunded)).toMatchObject({ refunded: '$40', refund_status: 'COMPLETED', paid_with: 'PayPal' })
    expect(r).toMatchObject({ total_paid: '$70', total_refunded: '$40' })
  })

  test('get_my_history: past visits with the stylist', async () => {
    getAppointmentsForBusiness.mockImplementation(async id => (id === 'demo-x' ? [color, seeded, refunded] : []))
    const r = await executeTool('get_my_history', {}, ctx)
    expect(r.visits).toEqual([expect.objectContaining({ business: 'Willow & Co. Salon', service: 'Haircut', staff: 'Ana' })])
  })
})

// Every owner action in the dashboard API has an MCP tool. Add the mapping here
// when the dashboard gains an action (or list it as dashboard-only with a reason).
test('coverage: every dashboard action has an owner MCP tool', () => {
  const src = fs.readFileSync(path.join(__dirname, '../handlers/dashboardApi.js'), 'utf8')
  const routes = [...src.matchAll(/path === '([^']+)' && method === '([A-Z]+)'/g)].map(m => `${m[2]} ${m[1]}`)
  const MCP = {
    'GET stats': 'get_revenue', 'GET bookings': 'get_schedule', 'PATCH bookings': 'update_booking_status', 'POST bookings/request-balance': 'request_balance',
    'POST calendar/booking': 'add_booking', 'POST calendar/block': 'block_time', 'GET calendar/events': 'get_schedule', 'POST calendar/move': 'reschedule_booking',
    'GET services': 'get_schedule', 'POST services': 'add_service', 'PATCH services': 'update_service', 'DELETE services': 'remove_service',
    'GET staff': 'update_staff', 'POST staff': 'update_staff', 'PATCH staff': 'update_staff', 'DELETE staff': 'remove_staff',
    'GET settings': 'update_business_info', 'PATCH settings': 'update_business_info',
    'GET payments': 'paypal_account', 'POST payments/paypal/connect': 'paypal_connect', 'POST payments/paypal/demo': 'paypal_connect',
    // An upload's preview: the owner's AI sends text to add_knowledge, so it already sees what's stored.
    'POST knowledge/text': 'add_knowledge', 'POST knowledge': 'add_knowledge', 'POST knowledge/preview': 'add_knowledge', 'DELETE knowledge': 'clear_knowledge', 'GET knowledge': 'list_knowledge', 'POST knowledge/ask': 'ask_knowledge', 'POST knowledge/remove': 'remove_knowledge',
    'POST setup/suggest': 'set_up (create_salon)', 'POST setup/apply': 'set_up (create_salon)',
    'POST bookings/cancel': 'cancel_booking', 'POST bookings/refund': 'refund_booking', 'GET bookings/refund-requests': 'list_refund_requests', 'POST bookings/refund-request/decline': 'decline_refund_request', 'GET memberships': 'list_memberships', 'POST memberships': 'create_membership_plan', 'PATCH memberships': 'update_membership_plan', 'POST memberships/cancel-member': 'cancel_member',
    'GET disputes': 'list_disputes', 'POST disputes/draft': 'draft_dispute_response', 'POST disputes/send': 'send_dispute_response', 'POST disputes/accept': 'accept_dispute',
    'POST disputes/practice': 'open_practice_dispute', 'POST disputes/sandbox': 'decide_dispute_for_testing'
  }
  const DASHBOARD_ONLY = new Set([
    'GET config', 'GET trace',                                            // page plumbing
    'POST payments/paypal/complete', 'POST payments/paypal/disconnect',   // PayPal's own redirect / a deliberate click
    'GET resources', 'POST resources', 'DELETE resources',               // rooms/stations: not used by salons
    'GET setup/suggestions', 'POST setup/recommendation', 'GET recommendations', 'POST test-chat'
  ])
  const names = new Set([...BUSINESS_TOOLS.map(t => t.name), 'set_up (create_salon)'])
  const missing = routes.filter(r => !DASHBOARD_ONLY.has(r) && !(MCP[r] && names.has(MCP[r])))
  expect(missing).toEqual([])
  // And the customer link has the customer pages: bookings, payments, history.
  const customerTools = getTools({ catalog: [{}], customer: {} }).map(t => t.name)
  expect(customerTools).toEqual(expect.arrayContaining(['get_my_bookings', 'get_my_payments', 'get_my_history', 'book_appointment', 'cancel_booking', 'reschedule_booking', 'add_booking_note', 'business_info', 'search_businesses', 'list_memberships', 'join_membership', 'my_memberships', 'cancel_membership']))
})
