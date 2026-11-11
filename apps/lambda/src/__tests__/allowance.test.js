'use strict'

// AI spending allowance: within limits the
// customer set, their AI pays with the saved PayPal without asking; code checks
// the limits; refunds give room back; outside it, the usual quote.
// As a signed mandate (PAYPAL_GAPS.md §3): it ends on a date, covers chosen kinds
// of places, its terms are signed, and each payment under it is written down
// first and charged as started by Flow on agreed terms.

jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn(), updateCustomer: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn().mockResolvedValue([]), createAppointment: jest.fn(), updateAppointment: jest.fn().mockResolvedValue() }))
jest.mock('../services/redis', () => ({ reserveSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn().mockResolvedValue(['staff-ana', 'staff-ben']), getNextQueueToken: jest.fn(), priceForUnit: jest.fn(s => s) }))
jest.mock('../core/paymentFlow', () => ({ requestPayment: jest.fn(), requestBalancePayment: jest.fn() }))
jest.mock('../core/memberships', () => ({ coverFor: jest.fn().mockResolvedValue(null), offers: jest.fn(() => []) }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['inbox']), notifyOwner: jest.fn().mockResolvedValue(true) }))
jest.mock('../services/payments', () => ({ getPaymentProvider: () => ({ id: 'paypal', isConfigured: () => true }) }))

const { updateCustomer } = require('../services/dynamo/customers')
const { getAppointmentsForBusiness, updateAppointment } = require('../services/dynamo/appointments')
const { requestPayment } = require('../core/paymentFlow')
const { notifyCustomer } = require('../services/notify')
const allowance = require('../core/allowance')
const { executeTool } = require('../services/tools')
const { localDate, toUtcIso } = require('../utils/time')
const { CATALOG } = require('../demo/templates')

const TZ = 'America/Chicago'
const business = { ...CATALOG[0].build(), businessId: 'biz-al', paypalMerchantId: null }   // Haircut $40, paid up front
const saved = { vaultId: 'VAULT1', email: 'john.doe@example.com' }
const john = more => ({ customerId: 'john', name: 'John Doe', savedPaypal: saved, ...more })
const on = (perBooking, perMonth) => ({ aiAllowance: { on: true, perBooking, perMonth } })
const day = d => localDate(new Date(Date.now() + d * 86_400_000).toISOString(), TZ)
const thisMonth = new Date().toISOString()
const book = (customer, more = {}) => executeTool('book_appointment', { service_name: 'Haircut', start_time: `${day(3)}T10:00`, staff_name: 'Ana', ...more }, { business, customer, channel: 'mcp' })

beforeEach(() => {
  jest.clearAllMocks()
  require('../services/demoStore').setStore(require('../services/demoStore').memory())
  getAppointmentsForBusiness.mockResolvedValue([])
  requestPayment.mockResolvedValue({ paidWithSaved: true, orderId: 'O9', amountDue: 40, result: { status: 'confirmed', amount: 40, appointmentId: 'a1', startTime: toUtcIso(`${day(3)}T10:00`, TZ), when: 'Sun, 10:00 AM' } })
})

describe('the check (code decides, never the AI)', () => {
  test('off, or no saved PayPal: never pays without asking', async () => {
    expect((await allowance.check({ customer: john(), amount: 10, businesses: [business] })).ok).toBe(false)
    expect((await allowance.check({ customer: { ...john(on(50, 150)), savedPaypal: null }, amount: 10, businesses: [business] })).ok).toBe(false)
  })

  test('within both limits: ok, with what is left after this payment', async () => {
    expect(await allowance.check({ customer: john(on(50, 150)), amount: 40, businesses: [business] })).toMatchObject({ ok: true, spent: 0, left: 110 })
  })

  test('over the per-booking limit: not ok, and says why', async () => {
    const r = await allowance.check({ customer: john(on(30, 150)), amount: 40, businesses: [business] })
    expect(r).toMatchObject({ ok: false, reason: 'over your $30 per-booking limit' })
  })

  test('this month so far counts; a refund gives the room back', async () => {
    getAppointmentsForBusiness.mockResolvedValue([
      { customerId: 'john', allowancePaid: 40, allowanceAt: thisMonth, refundAmount: 0 },
      { customerId: 'john', allowancePaid: 40, allowanceAt: thisMonth, refundAmount: 40 },   // refunded in full
      { customerId: 'john', allowancePaid: 40, allowanceAt: '2020-01-05T10:00:00.000Z' },     // another month
      { customerId: 'someone-else', allowancePaid: 40, allowanceAt: thisMonth }
    ])
    const c = john(on(50, 70))
    expect(await allowance.spentThisMonth(c, [business])).toBe(40)
    expect(await allowance.check({ customer: c, amount: 40, businesses: [business] })).toMatchObject({ ok: false, reason: expect.stringMatching(/over what's left of your monthly allowance \(\$30 of \$70\)/) })
    expect((await allowance.check({ customer: c, amount: 30, businesses: [business] })).ok).toBe(true)
  })

  test('setting it: needs a saved PayPal; per month at least per booking; sane maximums', async () => {
    expect(await allowance.set({ customerId: 'john' }, { on: true, perBooking: 50, perMonth: 150 })).toMatchObject({ error: expect.stringMatching(/Save PayPal first/) })
    expect((await allowance.set(john(), { on: true, perBooking: 50, perMonth: 20 })).error).toMatch(/at least the per-booking limit/)
    expect((await allowance.set(john(), { on: true, perBooking: 900, perMonth: 1000 })).error).toMatch(/between \$1 and \$500/)
    expect(await allowance.set(john(), { on: true, perBooking: 50, perMonth: 150 })).toMatchObject({ on: true, perBooking: 50, perMonth: 150, places: 'any place on Flow', signed: true })
    expect(updateCustomer).toHaveBeenLastCalledWith('john', { aiAllowance: expect.objectContaining({ on: true, perBooking: 50, perMonth: 150, setAt: expect.any(String), mandateId: expect.stringMatching(/^om_/), signature: expect.any(String) }) })
  })
})

describe('as a signed mandate', () => {
  const signed = async (terms = {}) => {
    const c = john()
    await allowance.set(c, { on: true, perBooking: 50, perMonth: 150, ...terms })
    return c
  }

  test('it lasts 7, 30 or 90 days (30 by default) and covers all places unless some are picked', async () => {
    const c = await signed()
    const days = (Date.parse(c.aiAllowance.expiresAt) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(c.aiAllowance.categories).toEqual([])
    expect((await allowance.set(john(), { on: true, perBooking: 50, perMonth: 150, days: 5 })).error).toMatch(/7, 30 or 90 days/)
    expect((await allowance.set(john(), { on: true, perBooking: 50, perMonth: 150, categories: ['casino'] })).error).toMatch(/Places can be/)
    expect((await signed({ categories: ['salon', 'barber', 'spa'] })).aiAllowance.categories).toEqual([])   // all = any
  })

  test('outside its places, after it ends, or with changed terms: nothing is paid without asking', async () => {
    const spaOnly = await signed({ categories: ['spa'] })
    expect(await allowance.check({ customer: spaOnly, amount: 40, businesses: [business], business })).toMatchObject({ ok: false, reason: expect.stringMatching(/outside your AI mandate \(it covers spas\)/) })
    const salons = await signed({ categories: ['salon'] })
    expect((await allowance.check({ customer: salons, amount: 40, businesses: [business], business })).ok).toBe(true)

    const ended = await signed()
    ended.aiAllowance.expiresAt = new Date(Date.now() - 1000).toISOString()
    ended.aiAllowance.signature = (await signed()).aiAllowance.signature   // re-signing is Flow's job; this one no longer matches
    expect((await allowance.check({ customer: ended, amount: 40, businesses: [business], business })).ok).toBe(false)

    const tampered = await signed()
    tampered.aiAllowance.perBooking = 500   // raised without Flow signing it
    expect(await allowance.check({ customer: tampered, amount: 400, businesses: [business], business })).toMatchObject({ ok: false, reason: expect.stringMatching(/don't match the signed mandate/) })
  })

  test('an old allowance with no expiry, places or signature keeps working', async () => {
    expect((await allowance.check({ customer: john(on(50, 150)), amount: 40, businesses: [business], business })).ok).toBe(true)
  })

  test('a booking under it: the payment is written down and signed first, charged as started by Flow, and listed in Profile', async () => {
    const c = await signed()
    await book(c)
    const call = requestPayment.mock.calls[0][0]
    expect(call).toMatchObject({ underAllowance: true, paymentMandate: { id: expect.stringMatching(/^pm_/), amount: 40, openMandateId: c.aiAllowance.mandateId, signature: expect.any(String) } })
    expect(updateAppointment).toHaveBeenCalledWith('biz-al', expect.any(String), 'a1', expect.objectContaining({ paymentMandateId: call.paymentMandate.id, mandateId: c.aiAllowance.mandateId }))
    expect(await allowance.payments(c)).toEqual([expect.objectContaining({ id: call.paymentMandate.id, amount: 40, status: 'paid', orderId: 'O9', business: 'Willow & Co. Salon' })])
    expect(allowance.signedTerms(c)).toMatchObject({ type: 'open_mandate', mandateId: c.aiAllowance.mandateId, perBooking: 50, valid: true })
  })
})

describe('booking through the AI', () => {
  test('within the allowance: pays at once, counts it this month, and tells the customer', async () => {
    const r = await book(john(on(50, 150)))
    expect(requestPayment.mock.calls[0][0]).toMatchObject({ useSaved: true, expectedAmount: 40, underAllowance: true })
    expect(r).toMatchObject({ booked: true, paidWithSaved: true, paidUnder: 'allowance', allowanceLeft: 110 })
    expect(r.message).toMatch(/Paid by your AI under your allowance: \$110 of \$150 left this month/)
    expect(updateAppointment).toHaveBeenCalledWith('biz-al', expect.any(String), 'a1', expect.objectContaining({ allowancePaid: 40, allowanceAt: expect.any(String), paidUnder: 'allowance' }))
    expect(notifyCustomer).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Your AI paid $40 at Willow & Co. Salon' }))
  })

  test('over the allowance: the usual quote with the reason; nothing charged', async () => {
    const r = await book(john(on(30, 150)))
    expect(r).toMatchObject({ needsConfirm: true, overAllowance: 'over your $30 per-booking limit' })
    expect(r.message).toMatch(/^This is over your \$30 per-booking limit, so it needs the customer's yes/)
    expect(requestPayment).not.toHaveBeenCalled()
  })

  test('no allowance: unchanged, a quote first', async () => {
    expect(await book(john())).toMatchObject({ needsConfirm: true })
    expect(requestPayment).not.toHaveBeenCalled()
  })

  test('the AI can see the allowance but no tool changes it', async () => {
    const r = await executeTool('my_saved_paypal', {}, { business, customer: john(on(50, 150)), channel: 'mcp' })
    expect(r.allowance).toMatchObject({ on: true, perBooking: 50, perMonth: 150, left: 150 })
    const names = require('../services/tools').getTools({}).map(t => t.name)
    expect(names.filter(n => /allowance/i.test(n))).toEqual([])
  })
})
