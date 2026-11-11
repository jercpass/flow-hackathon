'use strict'

// Approve in Flow: over MCP, a saved-PayPal
// payment above the AI allowance waits for the customer's own click in Flow.
// The AI can't confirm it; approving runs the tool once with the approved amount.

jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn(), updateCustomer: jest.fn() }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn().mockResolvedValue([]), createAppointment: jest.fn(), updateAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ reserveSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn().mockResolvedValue(['staff-ana', 'staff-ben']), getNextQueueToken: jest.fn(), priceForUnit: jest.fn(s => s) }))
jest.mock('../core/paymentFlow', () => ({ requestPayment: jest.fn(), requestBalancePayment: jest.fn() }))
jest.mock('../core/memberships', () => ({ coverFor: jest.fn().mockResolvedValue(null), offers: jest.fn(() => []) }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['inbox']), notifyOwner: jest.fn().mockResolvedValue(true) }))
jest.mock('../services/payments', () => ({ getPaymentProvider: () => ({ id: 'paypal', isConfigured: () => true }) }))
jest.mock('../services/dynamo/processedMessages', () => ({ saveResult: jest.fn(), getResult: jest.fn() }))
jest.mock('../core/concierge', () => ({ ...jest.requireActual('../core/concierge'), sessionContext: jest.fn() }))

process.env.DASHBOARD_URL = 'https://flow.example'

const { requestPayment, requestBalancePayment } = require('../core/paymentFlow')
const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const { getBusiness } = require('../services/dynamo/businesses')
const { getCustomer } = require('../services/dynamo/customers')
const { notifyCustomer } = require('../services/notify')
const concierge = require('../core/concierge')
const { setStore, memory } = require('../services/demoStore')
const { executeTool, getTools } = require('../services/tools')
const approvals = require('../core/approvals')
const { localDate, toUtcIso } = require('../utils/time')
const { CATALOG } = require('../demo/templates')

const TZ = 'America/Chicago'
const business = { ...CATALOG[0].build(), businessId: 'biz-appr', paypalMerchantId: null }   // Willow: Haircut $40
const saved = { vaultId: 'VAULT1', email: 'john.doe@example.com' }
const john = more => ({ customerId: 'john', name: 'John Doe', savedPaypal: saved, ...more })
const session = { sid: 's1', businessId: business.businessId, customerId: 'john', customerName: 'John Doe', expiresAt: Date.now() + 3600_000 }
const mcp = (customer, more = {}) => ({ business, customer, channel: 'mcp', demoSid: 's1', ...more })
const day = d => localDate(new Date(Date.now() + d * 86_400_000).toISOString(), TZ)
const start = () => `${day(3)}T10:00`
const BOOK = () => ({ service_name: 'Haircut', start_time: start(), staff_name: 'Ana' })
const PAID = () => ({ paidWithSaved: true, orderId: 'O9', amountDue: 40, result: { status: 'confirmed', amount: 40, startTime: toUtcIso(start(), TZ), when: 'Mon, 10 AM' } })

beforeEach(() => {
  jest.clearAllMocks()
  setStore(memory())
  getAppointmentsForBusiness.mockResolvedValue([])
  requestPayment.mockResolvedValue({ paymentUrl: 'https://paypal.test/pay', orderId: 'O1', amountDue: 40 })
})

describe('over MCP, above the allowance', () => {
  test('nothing is charged: an approval with a link, and a message in the Flow inbox with an Approve button', async () => {
    const r = await executeTool('book_appointment', BOOK(), mcp(john()))
    expect(r).toMatchObject({ needsApproval: true, booked: false, amount: 40, approvalUrl: expect.stringMatching(/^https:\/\/flow.example\/approve\?a=[0-9a-f]{18}$/) })
    expect(r.message).toMatch(/You can't approve it yourself/)
    expect(requestPayment).not.toHaveBeenCalled()
    expect(notifyCustomer).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'approval', subject: expect.stringMatching(/^Approve \$40 for Haircut, .+ 10 AM\?$/),
      action: { label: 'Review and approve $40', url: r.approvalUrl }
    }))
  })

  test('the AI sending confirm=true itself still only gets the approval', async () => {
    const r = await executeTool('book_appointment', { ...BOOK(), confirm: true, amount: 40 }, mcp(john()))
    expect(r.needsApproval).toBe(true)
    expect(requestPayment).not.toHaveBeenCalled()
  })

  test('asking again reuses the pending approval (one inbox message)', async () => {
    const a = await executeTool('book_appointment', BOOK(), mcp(john()))
    const b = await executeTool('book_appointment', BOOK(), mcp(john()))
    expect(b.approvalId).toBe(a.approvalId)
    expect(notifyCustomer).toHaveBeenCalledTimes(1)
  })

  test('pay_balance waits for approval too', async () => {
    const appt = { appointmentId: 'a1', customerId: 'john', status: 'confirmed', serviceName: 'Color & Gloss', startTime: new Date(Date.now() + 3 * 86_400_000).toISOString(), totalAmount: 120, amountPaid: 30, currency: 'USD' }
    getAppointmentsForBusiness.mockResolvedValue([appt])
    const r = await executeTool('pay_balance', { confirm: true, amount: 90 }, mcp(john()))
    expect(r).toMatchObject({ needsApproval: true, amount: 90 })
    expect(requestBalancePayment).not.toHaveBeenCalled()
  })
})

describe('what stays the same', () => {
  test('within the allowance, MCP pays at once', async () => {
    requestPayment.mockResolvedValue(PAID())
    const r = await executeTool('book_appointment', BOOK(), mcp(john({ aiAllowance: { on: true, perBooking: 50, perMonth: 150 } })))
    expect(r).toMatchObject({ booked: true, paidWithSaved: true, paidUnder: 'allowance' })
  })

  test('web chat keeps quote, then yes: the person presses the button there', async () => {
    const r = await executeTool('book_appointment', BOOK(), { business, customer: john(), channel: 'web', demoSid: 's1' })
    expect(r).toMatchObject({ needsConfirm: true })
    expect(r.needsApproval).toBeUndefined()
  })

  test('check_approval is offered over MCP only', () => {
    expect(getTools({ channel: 'mcp' }).some(t => t.name === 'check_approval')).toBe(true)
    expect(getTools({ channel: 'web' }).some(t => t.name === 'check_approval')).toBe(false)
  })
})

describe('the customer decides in Flow', () => {
  beforeEach(() => {
    getBusiness.mockResolvedValue(business)
    getCustomer.mockResolvedValue(john())
    concierge.sessionContext.mockImplementation(async () => mcp(john()))
  })

  test('approve: charged once with the approved amount, booked; a second click changes nothing', async () => {
    const asked = await executeTool('book_appointment', BOOK(), mcp(john()))
    requestPayment.mockResolvedValue(PAID())
    const out = await approvals.decide(session, asked.approvalId, 'approve')
    expect(out.approval).toMatchObject({ status: 'approved', money: '$40' })
    expect(out.approval.message).toMatch(/^Booked and paid: \$40/)
    expect(requestPayment).toHaveBeenCalledTimes(1)
    expect(requestPayment.mock.calls[0][0]).toMatchObject({ useSaved: true, expectedAmount: 40 })

    const again = await approvals.decide(session, asked.approvalId, 'approve')
    expect(again.approval.status).toBe('approved')
    expect(requestPayment).toHaveBeenCalledTimes(1)

    const seen = await executeTool('check_approval', { approval_id: asked.approvalId }, { ...mcp(john()), catalog: [business] })
    expect(seen).toMatchObject({ status: 'approved' })
    expect(seen.message).toMatch(/^Booked and paid/)
  })

  test('decline: nothing charged, and the AI is told so', async () => {
    const asked = await executeTool('book_appointment', BOOK(), mcp(john()))
    const out = await approvals.decide(session, asked.approvalId, 'decline')
    expect(out.approval.status).toBe('declined')
    expect(requestPayment).not.toHaveBeenCalled()
    expect((await approvals.statusFor(mcp(john()), asked.approvalId)).message).toMatch(/declined .* Nothing was charged/)
  })

  test("another session can't see or decide it", async () => {
    const asked = await executeTool('book_appointment', BOOK(), mcp(john()))
    expect(await approvals.decide({ ...session, sid: 'other' }, asked.approvalId, 'approve')).toEqual({ error: 'not_found' })
    expect(requestPayment).not.toHaveBeenCalled()
  })

  test('after 15 minutes it has expired and nothing can be charged', async () => {
    const asked = await executeTool('book_appointment', BOOK(), mcp(john()))
    const later = Date.now() + approvals.TTL_MS + 1000
    const spy = jest.spyOn(Date, 'now').mockReturnValue(later)
    try {
      const out = await approvals.decide(session, asked.approvalId, 'approve')
      expect(out.approval.status).toBe('expired')
      expect(requestPayment).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})

test("the saved PayPal is refused after Approve: the person is offered PayPal instead, nothing charged", async () => {
  getBusiness.mockResolvedValue(business)
  getCustomer.mockResolvedValue(john())
  concierge.sessionContext.mockImplementation(async () => mcp(john()))
  const asked = await executeTool('book_appointment', BOOK(), mcp(john()))
  requestPayment.mockResolvedValue({ paymentUrl: 'https://paypal.test/checkout', orderId: 'O2', amountDue: 40, savedFailed: true })
  const out = await approvals.decide(session, asked.approvalId, 'approve')
  expect(out.approval).toMatchObject({ status: 'failed', paymentUrl: 'https://paypal.test/checkout', message: "Your saved PayPal didn't go through, so nothing was charged. You can pay with PayPal instead." })
  expect((await approvals.statusFor(mcp(john()), asked.approvalId)).message).toMatch(/pay \$40 with PayPal instead: https:\/\/paypal\.test\/checkout/)
})
