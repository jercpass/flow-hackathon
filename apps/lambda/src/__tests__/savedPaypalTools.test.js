'use strict'

// The money rule for saved PayPal: the AI quotes the exact amount, and only a
// confirm with that amount pays. Same tools for web chat, voice and MCP.

jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn(), updateCustomer: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn().mockResolvedValue([]), createAppointment: jest.fn(), updateAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ reserveSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn().mockResolvedValue(['staff-ana', 'staff-ben']), getNextQueueToken: jest.fn(), priceForUnit: jest.fn(s => s) }))
jest.mock('../core/paymentFlow', () => ({ requestPayment: jest.fn(), requestBalancePayment: jest.fn() }))
jest.mock('../core/memberships', () => ({ coverFor: jest.fn().mockResolvedValue(null), offers: jest.fn(() => []) }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['inbox']), notifyOwner: jest.fn().mockResolvedValue(true) }))
jest.mock('../services/payments', () => ({ getPaymentProvider: () => ({ id: 'paypal', isConfigured: () => true }) }))
jest.mock('../services/payments/paypal', () => ({ deleteSaved: jest.fn().mockResolvedValue({ removed: true }), createVaultSetup: jest.fn() }))
jest.mock('../services/dynamo/processedMessages', () => ({ saveResult: jest.fn(), getResult: jest.fn() }))

const { requestPayment, requestBalancePayment } = require('../core/paymentFlow')
const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const paypal = require('../services/payments/paypal')
const { executeTool } = require('../services/tools')
const { localDate, toUtcIso } = require('../utils/time')
const { CATALOG } = require('../demo/templates')

const TZ = 'America/Chicago'
const business = { ...CATALOG[0].build(), businessId: 'biz-saved', paypalMerchantId: null }   // Willow: Haircut $40, paid up front
const saved = { vaultId: 'VAULT1', email: 'john.doe@example.com' }
const john = more => ({ customerId: 'john', name: 'John Doe', ...more })
const ctx = (customer, channel = 'web') => ({ business, customer, channel })
const day = d => localDate(new Date(Date.now() + d * 86_400_000).toISOString(), TZ)
const start = () => `${day(3)}T10:00`
const book = (customer, more = {}) => executeTool('book_appointment', { service_name: 'Haircut', start_time: start(), staff_name: 'Ana', ...more }, ctx(customer))

beforeEach(() => {
  jest.clearAllMocks()
  requestPayment.mockResolvedValue({ paymentUrl: 'https://paypal.test/pay', orderId: 'O1', amountDue: 40 })
})

test('no saved PayPal: the link, and it says paying also saves PayPal', async () => {
  const r = await book(john())
  expect(r).toMatchObject({ paymentUrl: 'https://paypal.test/pay', savesPaypal: true })
  expect(r.message).toMatch(/also saves your PayPal/)
  expect(requestPayment.mock.calls[0][0].useSaved).toBeUndefined()
})

test('saved PayPal, no confirm: a quote with the exact amount, nothing held or charged', async () => {
  const r = await book(john({ savedPaypal: saved }))
  expect(r).toMatchObject({ needsConfirm: true, booked: false, amount: 40, savedPaypal: 'j***@example.com' })
  expect(r.message).toMatch(/Pay the full amount of \$40 now with your saved PayPal/)
  expect(requestPayment).not.toHaveBeenCalled()
})

test('confirm without the amount is still only a quote', async () => {
  const r = await book(john({ savedPaypal: saved }), { confirm: true })
  expect(r.needsConfirm).toBe(true)
  expect(requestPayment).not.toHaveBeenCalled()
})

test('confirm with the quoted amount: paid in one step and booked', async () => {
  requestPayment.mockResolvedValue({ paidWithSaved: true, orderId: 'O9', amountDue: 40, result: { status: 'confirmed', amount: 40, startTime: toUtcIso(start(), TZ), when: 'Mon, 10:00 AM' } })
  const r = await book(john({ savedPaypal: saved }), { confirm: true, amount: 40 })
  expect(requestPayment.mock.calls[0][0]).toMatchObject({ useSaved: true, expectedAmount: 40, preferredUnitId: 'staff-ana' })
  expect(r).toMatchObject({ booked: true, paidWithSaved: true, amount: 40 })
  expect(r.message).toMatch(/Booked and paid: \$40 with your saved PayPal \(j\*\*\*@example\.com\)/)
})

test('the price changed between quote and yes: nothing charged, quoted again', async () => {
  requestPayment.mockRejectedValue(Object.assign(new Error('PRICE_CHANGED'), { code: 'PRICE_CHANGED', amount: 45 }))
  const r = await book(john({ savedPaypal: saved }), { confirm: true, amount: 40 })
  expect(r).toMatchObject({ needsConfirm: true, amount: 45 })
  expect(r.message).toMatch(/^The price changed, so nothing was charged/)
})

test('pay_with "link": the customer approves on PayPal instead', async () => {
  const r = await book(john({ savedPaypal: saved }), { pay_with: 'link' })
  expect(r).toMatchObject({ paymentUrl: 'https://paypal.test/pay' })
  expect(requestPayment.mock.calls[0][0].useSaved).toBeUndefined()
})

test('in a demo session, a link instead of the saved PayPal only comes after the customer saw the quote', async () => {
  const { setStore, memory } = require('../services/demoStore')
  setStore(memory())
  const demo = { ...ctx(john({ savedPaypal: saved }), 'telegram'), demoSid: 'S1' }
  const args = { service_name: 'Haircut', start_time: start(), staff_name: 'Ana' }
  // The AI asks for a link straight away: the customer gets the saved-PayPal quote first.
  const first = await executeTool('book_appointment', { ...args, pay_with: 'link' }, demo)
  expect(first).toMatchObject({ needsConfirm: true, savedPaypal: 'j***@example.com' })
  expect(requestPayment).not.toHaveBeenCalled()
  // After that quote, asking for a link is the customer's choice: the link is made.
  const second = await executeTool('book_appointment', { ...args, pay_with: 'link' }, demo)
  expect(second).toMatchObject({ paymentUrl: 'https://paypal.test/pay' })
  expect(requestPayment.mock.calls[0][0].useSaved).toBeUndefined()
})

test('a reference photo this session sent goes on the booking (via the payment hold); another session\'s is dropped', async () => {
  const { setStore, memory, store } = require('../services/demoStore')
  setStore(memory())
  await store().putSession({ sid: 'S1', status: 'active', expiresAt: Date.now() + 3600_000 })
  await store().putSession({ sid: 'S2', status: 'active', expiresAt: Date.now() + 3600_000 })
  const photos = require('../services/photos')
  const mine = await photos.save(await store().getSession('S1'), { buffer: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg' })
  const theirs = await photos.save(await store().getSession('S2'), { buffer: Buffer.from('other'), mimeType: 'image/jpeg' })
  // A demo customer pays from their saved PayPal (link once, pay everywhere): confirmed at $40.
  const demo = { ...ctx(john({ savedPaypal: saved }), 'telegram'), demoSid: 'S1' }
  const r = await executeTool('book_appointment', { service_name: 'Haircut', start_time: start(), staff_name: 'Ana', photo_ids: [mine, theirs, 'ph_madeup000'], confirm: true, amount: 40 }, demo)
  expect(requestPayment.mock.calls[0][0].photos).toEqual([mine])
  expect(r).toMatchObject({ paymentUrl: 'https://paypal.test/pay', photosAttached: 1 })
  expect(r.message).toMatch(/The reference photo is on the booking once it is paid/)
})

test('the booking failed after paying: says it was refunded, not booked', async () => {
  requestPayment.mockResolvedValue({ paidWithSaved: true, orderId: 'O9', amountDue: 40, result: { status: 'refunded', amount: 40 } })
  const r = await book(john({ savedPaypal: saved }), { confirm: true, amount: 40 })
  expect(r).toMatchObject({ booked: false, refunded: true })
  expect(r.error).toMatch(/refunded in full/)
})

test('pay_balance: quote first; pays with the saved PayPal only for the exact balance', async () => {
  const appt = { appointmentId: 'a1', customerId: 'john', status: 'confirmed', serviceName: 'Color & Gloss', startTime: new Date(Date.now() + 3 * 86_400_000).toISOString(), totalAmount: 120, amountPaid: 30, currency: 'USD' }
  getAppointmentsForBusiness.mockResolvedValue([appt])
  const c = ctx(john({ savedPaypal: saved }))
  const q = await executeTool('pay_balance', {}, c)
  expect(q).toMatchObject({ needsConfirm: true, amount: 90 })
  expect(requestBalancePayment).not.toHaveBeenCalled()

  const wrong = await executeTool('pay_balance', { confirm: true, amount: 80 }, c)
  expect(wrong.needsConfirm).toBe(true)
  expect(requestBalancePayment).not.toHaveBeenCalled()

  requestBalancePayment.mockResolvedValue({ paidWithSaved: true, result: { status: 'paid' } })
  const r = await executeTool('pay_balance', { confirm: true, amount: 90 }, c)
  expect(requestBalancePayment.mock.calls[0][0]).toMatchObject({ balance: 90, useSaved: true })
  expect(r).toMatchObject({ paid: true, paidWithSaved: true })
})

test('my_saved_paypal: show, and remove only after confirm', async () => {
  const c = ctx(john({ savedPaypal: saved }), 'mcp')
  expect(await executeTool('my_saved_paypal', {}, c)).toMatchObject({ saved: true, account: 'j***@example.com' })
  const q = await executeTool('my_saved_paypal', { action: 'remove' }, c)
  expect(q).toMatchObject({ removed: false, needsConfirm: true })
  expect(paypal.deleteSaved).not.toHaveBeenCalled()
  const r = await executeTool('my_saved_paypal', { action: 'remove', confirm: true }, c)
  expect(r.removed).toBe(true)
  expect(paypal.deleteSaved).toHaveBeenCalledWith('VAULT1')
})

test('my_saved_paypal change: a PayPal link, nothing charged', async () => {
  paypal.createVaultSetup.mockResolvedValue({ setupTokenId: 'SETUP1', approveUrl: 'https://pp/setup' })
  const r = await executeTool('my_saved_paypal', { action: 'change' }, ctx(john({ savedPaypal: saved })))
  expect(r).toMatchObject({ changeUrl: 'https://pp/setup' })
  expect(r.message).toMatch(/nothing is charged/)
})

describe('asking again for a booking that already went through', () => {
  const existing = (more = {}) => ({ appointmentId: 'A1', customerId: 'john', serviceId: business.config.services.find(s => s.name === 'Haircut').serviceId, startTime: toUtcIso(start(), TZ), status: 'confirmed', amountPaid: 40, currency: 'USD', ...more })

  test('saved PayPal and a yes: reports the booking, books and charges nothing', async () => {
    getAppointmentsForBusiness.mockResolvedValueOnce([existing()]).mockResolvedValueOnce([existing()])
    const r = await book(john({ savedPaypal: saved }), { confirm: true, amount: 40 })
    expect(r).toMatchObject({ booked: true, alreadyBooked: true, amountPaid: 40 })
    expect(r.message).toMatch(/^Already booked: Haircut on .+, paid \$40\. Nothing new was booked or charged\.$/)
    expect(requestPayment).not.toHaveBeenCalled()
  })

  test('no PayPal link either', async () => {
    getAppointmentsForBusiness.mockResolvedValue([existing()])
    const r = await book(john())
    expect(r.alreadyBooked).toBe(true)
    expect(r.paymentUrl).toBeUndefined()
    expect(requestPayment).not.toHaveBeenCalled()
    getAppointmentsForBusiness.mockResolvedValue([])
  })

  test('a cancelled booking, another customer, or another service at that time is not a repeat', async () => {
    for (const other of [existing({ status: 'cancelled' }), existing({ customerId: 'pat' }), existing({ serviceId: 'svc-other' })]) {
      getAppointmentsForBusiness.mockResolvedValue([other])
      const r = await book(john())
      expect(r.alreadyBooked).toBeUndefined()
      expect(r.paymentUrl).toBe('https://paypal.test/pay')
    }
    getAppointmentsForBusiness.mockResolvedValue([])
  })
})
