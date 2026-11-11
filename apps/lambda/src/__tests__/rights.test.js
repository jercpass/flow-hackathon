'use strict'

// Each side can do everything it's entitled to through its AI (MCP, web chat,
// voice), and nothing beyond: a customer only ever acts on their own bookings,
// an owner link only on its own business. Money still moves only after a quote.

jest.mock('../services/dynamo/appointments', () => {
  const rows = []
  return {
    __rows: rows,
    getAppointmentsForBusiness: jest.fn(async (bid, from, to) => rows.filter(a => a.businessId === bid && (!from || a.startTime >= from) && (!to || a.startTime <= to)).map(a => ({ ...a }))),
    createAppointment: jest.fn(async a => { rows.push({ ...a }); return { created: true } }),
    updateAppointment: jest.fn(async (bid, start, id, u) => { Object.assign(rows.find(a => a.appointmentId === id), u) })
  }
})
jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn(async id => ({ customerId: id, name: id === 'sam' ? 'Sam Rivera' : 'Pat Lee', demoSessionId: 's1' })), updateCustomer: jest.fn() }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn(), updateBusiness: jest.fn() }))
jest.mock('../services/redis', () => ({ reserveSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn().mockResolvedValue(['staff-ana', 'staff-ben']), getNextQueueToken: jest.fn(), priceForUnit: jest.fn(s => s), staffWorksAt: jest.fn(() => true) }))
jest.mock('../core/paymentFlow', () => ({ requestPayment: jest.fn(), requestBalancePayment: jest.fn(async ({ balance }) => ({ paymentUrl: 'https://paypal.test/balance', orderId: 'BAL1', balance })) }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['inbox']), notifyOwner: jest.fn().mockResolvedValue(true) }))
jest.mock('../services/payments', () => ({ getPaymentProvider: () => ({ id: 'paypal', isConfigured: () => true }) }))
jest.mock('../core/refunds', () => ({ ...jest.requireActual('../core/refunds'), refundAppointment: jest.fn() }))

process.env.PAYPAL_CLIENT_ID = 'test-id'; process.env.PAYPAL_CLIENT_SECRET = 'test-secret'   // so PayPal reads get as far as the booking lookup
const appts = require('../services/dynamo/appointments')
const { requestBalancePayment } = require('../core/paymentFlow')
const { refundAppointment } = require('../core/refunds')
const { executeTool, getTools } = require('../services/tools')
const { BUSINESS_TOOLS } = require('../mcp/sessionServers')
const { toUtcIso, localDate } = require('../utils/time')
const { CATALOG, PERSONA } = require('../demo/templates')

const TZ = 'America/Chicago'
const willow = { ...CATALOG[0].build(), businessId: 'w', demoSessionId: 's1', ownerInbox: true }
const eastside = { ...CATALOG[2].build(), businessId: 'e', demoSessionId: 's1', ownerInbox: true }
const day = d => localDate(new Date(Date.now() + d * 86_400_000).toISOString(), TZ)
const at = (d, hhmm) => toUtcIso(`${day(d)}T${hhmm}`, TZ)
const booking = o => ({ businessId: 'w', customerId: 'sam', customerName: 'Sam Rivera', serviceId: 'svc-haircut', serviceName: 'Haircut', unitId: 'staff-ana', status: 'confirmed', amountPaid: 40, totalAmount: 40, paymentId: 'CAP1', paymentProvider: 'paypal', currency: 'USD', ...o, endTime: o.startTime })
const sam = (business = willow) => ({ business, customer: { customerId: 'sam', name: 'Sam Rivera', demoSessionId: 's1' }, channel: 'mcp' })
const city = () => ({ catalog: [willow, eastside], customer: { customerId: 'sam', name: 'Sam Rivera', demoSessionId: 's1' }, customerLocation: { ...PERSONA.home }, channel: 'mcp' })
const ownerTool = (business, name, args) => BUSINESS_TOOLS.find(t => t.name === name).run(business, args)

beforeEach(() => {
  jest.clearAllMocks()
  appts.__rows.length = 0
})

describe('the customer can adjust their own bookings', () => {
  test('two upcoming haircuts: moving asks which, then moves the one on that date, to Ben', async () => {
    appts.__rows.push(booking({ appointmentId: 'a1', startTime: at(3, '10:00') }), booking({ appointmentId: 'a2', startTime: at(5, '10:00') }))
    const ask = await executeTool('reschedule_booking', { new_time: `${day(6)}T11:00` }, sam())
    expect(ask).toMatchObject({ rescheduled: false, message: expect.stringMatching(/which one/) })
    expect(ask.bookings).toHaveLength(2)
    expect(appts.createAppointment).not.toHaveBeenCalled()

    const r = await executeTool('reschedule_booking', { date: day(5), new_time: `${day(6)}T11:00`, staff_name: 'Ben' }, sam())
    expect(r).toMatchObject({ rescheduled: true, staff: 'Ben', when: expect.stringMatching(/11 AM$/) })
    expect(appts.createAppointment.mock.calls[0][0]).toMatchObject({ unitId: 'staff-ben', rescheduledFrom: 'a2', paymentId: 'CAP1', movedBy: 'customer' })
    expect(appts.__rows.find(a => a.appointmentId === 'a1').status).toBe('confirmed')   // the other one is untouched
    // The old record hands its payment to the new one, so a later refund can't leave it claiming "paid".
    const newId = appts.createAppointment.mock.calls[0][0].appointmentId
    expect(appts.__rows.find(a => a.appointmentId === 'a2')).toMatchObject({ status: 'cancelled', movedTo: newId, amountPaid: 0, paymentId: null, paymentStatus: 'moved' })
  })

  test('moving to someone who does not do the service is refused', async () => {
    appts.__rows.push(booking({ appointmentId: 'c1', serviceId: 'svc-color', serviceName: 'Color & Gloss', startTime: at(3, '11:00') }))
    expect((await executeTool('reschedule_booking', { new_time: `${day(4)}T11:00`, staff_name: 'Ben' }, sam())).error).toBe("Ben doesn't do Color & Gloss. Ana can.")
    expect((await executeTool('reschedule_booking', { new_time: `${day(4)}T11:00`, staff_name: 'Zed' }, sam())).error).toBe('No staff member named "Zed".')
  })

  test('pay_balance: the rest of a deposit, as a PayPal link; nothing charged until approved', async () => {
    appts.__rows.push(booking({ appointmentId: 'd1', serviceId: 'svc-color', serviceName: 'Color & Gloss', startTime: at(3, '11:00'), amountPaid: 30, totalAmount: 120 }))
    const r = await executeTool('pay_balance', {}, sam())
    expect(r).toMatchObject({ paymentRequired: true, balance: '$90', paymentUrl: 'https://paypal.test/balance', sentToInbox: true })
    expect(r.message).toMatch(/Nothing is charged until you approve it in PayPal/)
    expect(requestBalancePayment.mock.calls[0][0]).toMatchObject({ balance: 90, appointment: { appointmentId: 'd1' }, customer: { customerId: 'sam' } })
    appts.__rows[0].amountPaid = 120
    expect((await executeTool('pay_balance', {}, sam())).error).toMatch(/Nothing is left to pay/)
  })

  test('the customer tool list has everything the app lets the customer do', () => {
    const tools = getTools({ catalog: [{}], customer: {} })
    const names = tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['search_businesses', 'business_info', 'list_services', 'list_staff', 'check_availability', 'book_appointment', 'get_my_bookings', 'reschedule_booking', 'cancel_booking', 'add_booking_note', 'pay_balance', 'request_refund', 'get_my_payments', 'get_my_history', 'get_my_invoices', 'send_my_invoice', 'list_memberships', 'join_membership', 'my_memberships', 'cancel_membership']))
    expect(Object.keys(tools.find(t => t.name === 'reschedule_booking').parameters)).toEqual(expect.arrayContaining(['business_name', 'date', 'staff_name', 'new_time']))
  })
})

describe('...and only their own', () => {
  // Pat's booking at Willow, and nothing of Sam's.
  beforeEach(() => appts.__rows.push(booking({ appointmentId: 'pat-1', customerId: 'pat', customerName: 'Pat Lee', startTime: at(3, '10:00'), amountPaid: 30, totalAmount: 120, serviceId: 'svc-color', serviceName: 'Color & Gloss' })))

  test.each([
    ['cancel_booking', { confirm: true }],
    ['reschedule_booking', { new_time: `${day(4)}T11:00` }],
    ['add_booking_note', { note: 'x' }],
    ['pay_balance', {}],
    ['request_refund', { reason: 'x' }]
  ])('%s never reaches another customer\'s booking', async (name, args) => {
    await executeTool(name, { business_name: 'Willow & Co. Salon', ...args }, city())
    expect(appts.updateAppointment).not.toHaveBeenCalled()
    expect(appts.createAppointment).not.toHaveBeenCalled()
    expect(requestBalancePayment).not.toHaveBeenCalled()
    expect(refundAppointment).not.toHaveBeenCalled()
    expect(appts.__rows[0].status).toBe('confirmed')
    expect(appts.__rows[0].customerNotes).toBeUndefined()
  })

  test('their bookings, payments and invoices show only their own', async () => {
    expect((await executeTool('get_my_bookings', {}, city())).bookings).toEqual([])
    expect((await executeTool('get_my_payments', {}, city())).payments).toEqual([])
    expect((await executeTool('get_my_invoices', {}, city())).invoices).toEqual([])
  })
})

describe("an owner link only reaches its own business", () => {
  test.each([
    ['refund_booking', { confirm: true }],
    ['cancel_booking', { confirm: true }],
    ['reschedule_booking', { new_time: `${day(4)}T11:00` }],
    ['update_booking_status', { status: 'no_show' }],
    ['request_balance', { confirm: true }],
    ['paypal_payment', {}],
    ['decline_refund_request', {}]
  ])("Eastside's %s can't touch a Willow booking", async (name, args) => {
    appts.__rows.push(booking({ appointmentId: 'willow-1234', startTime: at(3, '10:00') }))
    const r = await ownerTool(eastside, name, { booking_id: 'willow-1234', ...args })
    expect(JSON.stringify(r)).toMatch(/No (paid )?booking with that id|No open refund request|not found/i)
    expect(appts.updateAppointment).not.toHaveBeenCalled()
    expect(refundAppointment).not.toHaveBeenCalled()
  })

  test('its schedule and customers are its own', async () => {
    appts.__rows.push(booking({ appointmentId: 'willow-1234', startTime: at(3, '10:00') }))
    expect((await ownerTool(eastside, 'get_schedule', {})).bookings).toEqual([])
    expect((await ownerTool(eastside, 'list_customers', {})).customers).toEqual([])
  })
})

test("payments: a moved booking appears once (where it is now), and money paid at the business says who refunds it", async () => {
  appts.__rows.push(
    booking({ appointmentId: 'old-1', startTime: at(3, '10:00'), status: 'cancelled' }),                                        // moved away
    booking({ appointmentId: 'new-1', startTime: at(3, '13:00'), rescheduledFrom: 'old-1', movedBy: 'owner' }),                 // where it is now
    booking({ appointmentId: 'shop-1', startTime: at(4, '10:00'), status: 'cancelled', paymentId: null, paymentProvider: null })  // paid in person, cancelled
  )
  const r = await executeTool('get_my_payments', {}, city())
  expect(r.payments).toHaveLength(2)
  expect(r.payments.find(p => p.status === 'confirmed')).toMatchObject({ paid_with: 'PayPal' })
  expect(r.payments.find(p => p.status === 'cancelled')).toMatchObject({ paid_with: 'at the business', refund: 'paid at the business, so the business refunds it directly' })
  expect(r.total_paid).toBe('$80')
})
