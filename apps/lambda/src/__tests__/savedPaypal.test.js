'use strict'

// Saved PayPal: the first payment saves it, a
// later payment uses it in one step only for the amount the customer agreed to,
// and the customer can change or remove it.

jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn(), updateCustomer: jest.fn() }))
jest.mock('../services/dynamo/processedMessages', () => ({ saveResult: jest.fn(), getResult: jest.fn() }))
jest.mock('../services/dynamo/pendingPayments', () => ({ savePendingPayment: jest.fn() }))
jest.mock('../services/redis', () => ({ holdSlotForPayment: jest.fn().mockResolvedValue({ held: true }), releaseSlot: jest.fn().mockResolvedValue() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn().mockResolvedValue(['u1']), priceForUnit: jest.fn(s => s) }))
jest.mock('../core/engine', () => ({ getService: jest.fn((b, id) => b.config.services.find(s => s.serviceId === id)) }))
jest.mock('../core/paymentConfirm', () => ({ finalizeOrder: jest.fn() }))
jest.mock('../services/payments/paypal', () => ({
  id: 'paypal', isConfigured: () => true,
  createCheckout: jest.fn(), chargeSaved: jest.fn(), deleteSaved: jest.fn().mockResolvedValue({ removed: true }),
  createVaultSetup: jest.fn(), finishVaultSetup: jest.fn()
}))
jest.mock('../services/payments', () => ({ getPaymentProvider: () => require('../services/payments/paypal') }))

const { getCustomer, updateCustomer } = require('../services/dynamo/customers')
const { saveResult, getResult } = require('../services/dynamo/processedMessages')
const { savePendingPayment } = require('../services/dynamo/pendingPayments')
const redis = require('../services/redis')
const { finalizeOrder } = require('../core/paymentConfirm')
const paypal = require('../services/payments/paypal')
const savedPaypal = require('../core/savedPaypal')
const { requestPayment, requestBalancePayment } = require('../core/paymentFlow')

const business = {
  businessId: 'b1', name: 'Willow & Co.', paymentProvider: 'paypal', paypalMerchantId: null,
  config: { currency: 'USD', services: [{ serviceId: 's1', name: 'Haircut', duration: 60, unitType: 'person', price: 30, paymentMode: 'full_prepaid' }] }
}
const saved = { vaultId: 'VAULT1', email: 'john.doe@example.com', savedAt: '2026-10-22T10:00:00Z' }
const john = (more = {}) => ({ customerId: 'c1', name: 'John Doe', ...more })
const START = '2026-11-02T16:00:00.000Z'
const pay = (customer, more = {}) => requestPayment({ business, serviceId: 's1', startIso: START, customer, channel: 'web', ...more })

beforeEach(() => {
  jest.clearAllMocks()
  process.env.API_URL = 'https://api.test'
  paypal.createCheckout.mockResolvedValue({ providerOrderId: 'O1', approveUrl: 'https://pp/approve' })
  redis.holdSlotForPayment.mockResolvedValue({ held: true })
})

describe('first payment', () => {
  test('a customer with nothing saved gets the normal link, with saving switched on', async () => {
    const r = await pay(john())
    expect(paypal.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ amount: 30, saveForLater: true }))
    expect(r).toMatchObject({ orderId: 'O1', paymentUrl: 'https://pp/approve' })
    expect(paypal.chargeSaved).not.toHaveBeenCalled()
  })

  test('a business paid into its own PayPal account never saves (the saved PayPal would belong to Flow)', async () => {
    await requestPayment({ business: { ...business, paypalMerchantId: 'MERCH1' }, serviceId: 's1', startIso: START, customer: john(), channel: 'web' })
    expect(paypal.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ saveForLater: false }))
  })

  test('already saved, but no useSaved (they asked for the link): normal link, no second save', async () => {
    await pay(john({ savedPaypal: saved }))
    expect(paypal.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ saveForLater: false }))
    expect(paypal.chargeSaved).not.toHaveBeenCalled()
  })
})

describe('paying with the saved PayPal', () => {
  test('agreed amount → charged with the vault id, then the normal exactly-once finalize', async () => {
    const captured = { captureId: 'CAP1', captureStatus: 'COMPLETED', amount: 30 }
    paypal.chargeSaved.mockResolvedValue({ providerOrderId: 'O9', captured, approveUrl: null })
    finalizeOrder.mockResolvedValue({ status: 'confirmed', when: 'Mon, Nov 2, 10:00 AM' })
    const r = await pay(john({ savedPaypal: saved }), { useSaved: true, expectedAmount: 30 })
    expect(paypal.chargeSaved).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'VAULT1', amount: 30, currency: 'USD' }))
    expect(savePendingPayment).toHaveBeenCalledWith('O9', expect.objectContaining({ customerId: 'c1', startIso: START, preferredUnitId: 'u1', amountDue: 30 }))
    expect(finalizeOrder).toHaveBeenCalledWith('O9', { source: 'saved', captured })
    expect(r).toMatchObject({ paidWithSaved: true, result: { status: 'confirmed' } })
    expect(paypal.createCheckout).not.toHaveBeenCalled()
  })

  test('a different amount than agreed → nothing charged, the seat is let go, PRICE_CHANGED', async () => {
    await expect(pay(john({ savedPaypal: saved }), { useSaved: true, expectedAmount: 25 })).rejects.toMatchObject({ code: 'PRICE_CHANGED', amount: 30 })
    expect(paypal.chargeSaved).not.toHaveBeenCalled()
    expect(redis.releaseSlot).toHaveBeenCalledWith('b1', START, 'u1', 'c1')
  })

  test('PayPal refuses the saved account → the normal PayPal link instead, nothing charged', async () => {
    paypal.chargeSaved.mockRejectedValue(Object.assign(new Error('x'), { code: 'PAYEE_ACCOUNT_RESTRICTED' }))
    const r = await pay(john({ savedPaypal: saved }), { useSaved: true, expectedAmount: 30 })
    expect(r).toMatchObject({ paymentUrl: 'https://pp/approve' })
    expect(finalizeOrder).not.toHaveBeenCalled()
  })

  test('PayPal wants the buyer again → their approve link, kept as a pending payment', async () => {
    paypal.chargeSaved.mockResolvedValue({ providerOrderId: 'O7', captured: null, approveUrl: 'https://pp/again' })
    const r = await pay(john({ savedPaypal: saved }), { useSaved: true, expectedAmount: 30 })
    expect(r).toMatchObject({ orderId: 'O7', paymentUrl: 'https://pp/again', savedNeedsApproval: true })
    expect(savePendingPayment).toHaveBeenCalledWith('O7', expect.any(Object))
    expect(finalizeOrder).not.toHaveBeenCalled()
  })

  test('the rest of a deposit: paid with the saved PayPal, no link sent', async () => {
    paypal.chargeSaved.mockResolvedValue({ providerOrderId: 'OB', captured: { captureStatus: 'COMPLETED' }, approveUrl: null })
    finalizeOrder.mockResolvedValue({ status: 'paid' })
    const appointment = { appointmentId: 'a1', startTime: START, totalAmount: 60, amountPaid: 20, currency: 'USD' }
    const r = await requestBalancePayment({ business, appointment, customer: john({ savedPaypal: saved }), serviceName: 'Color', balance: 40, useSaved: true })
    expect(paypal.chargeSaved).toHaveBeenCalledWith(expect.objectContaining({ amount: 40, vaultId: 'VAULT1' }))
    expect(savePendingPayment).toHaveBeenCalledWith('OB', expect.objectContaining({ kind: 'balance', appointmentId: 'a1' }))
    expect(r).toMatchObject({ paidWithSaved: true, result: { status: 'paid' } })
    expect(paypal.createCheckout).not.toHaveBeenCalled()
  })
})

describe('the saved account itself', () => {
  test('masked email: enough to recognise, nothing more', () => {
    expect(savedPaypal.masked('john.doe@example.com')).toBe('j***@example.com')
    expect(savedPaypal.view(john({ savedPaypal: saved }))).toEqual({ saved: true, account: 'j***@example.com', savedAt: saved.savedAt })
    expect(savedPaypal.view(john())).toEqual({ saved: false })
  })

  test('remember stores only vault id, email and date; a new account deletes the old one at PayPal', async () => {
    getCustomer.mockResolvedValue(john({ savedPaypal: saved }))
    await savedPaypal.remember('c1', { vaultId: 'VAULT2', email: 'other@example.com' })
    expect(updateCustomer).toHaveBeenCalledWith('c1', { savedPaypal: { vaultId: 'VAULT2', email: 'other@example.com', savedAt: expect.any(String) } })
    expect(paypal.deleteSaved).toHaveBeenCalledWith('VAULT1')
  })

  test('remember the same account twice: nothing changes', async () => {
    getCustomer.mockResolvedValue(john({ savedPaypal: saved }))
    await savedPaypal.remember('c1', { vaultId: 'VAULT1', email: 'john.doe@example.com' })
    expect(updateCustomer).not.toHaveBeenCalled()
    expect(paypal.deleteSaved).not.toHaveBeenCalled()
  })

  test('remove: says what happens first; deletes at PayPal and on the customer only on confirm', async () => {
    const c = john({ savedPaypal: saved })
    const q = await savedPaypal.remove({ customer: c, confirm: false })
    expect(q).toMatchObject({ removed: false, needsConfirm: true, account: 'j***@example.com' })
    expect(paypal.deleteSaved).not.toHaveBeenCalled()
    const r = await savedPaypal.remove({ customer: c, confirm: true })
    expect(r.removed).toBe(true)
    expect(paypal.deleteSaved).toHaveBeenCalledWith('VAULT1')
    expect(updateCustomer).toHaveBeenCalledWith('c1', { savedPaypal: null })
  })

  test('change account: the setup token is tied to the customer here, so the return URL cannot pick whose account it is', async () => {
    paypal.createVaultSetup.mockResolvedValue({ setupTokenId: 'SETUP1', approveUrl: 'https://pp/setup' })
    const s = await savedPaypal.startChange({ customer: john({ savedPaypal: saved }), returnTo: 'profile' })
    expect(s.approveUrl).toBe('https://pp/setup')
    expect(paypal.createVaultSetup).toHaveBeenCalledWith(expect.objectContaining({ returnUrl: 'https://api.test/pay/paypal/vault/return' }))
    expect(saveResult).toHaveBeenCalledWith('vaultsetup:SETUP1', { customerId: 'c1', returnTo: 'profile', traceScope: null }, 3600)

    getResult.mockResolvedValue({ customerId: 'c1', returnTo: 'profile' })
    getCustomer.mockResolvedValue(john({ savedPaypal: saved }))
    paypal.finishVaultSetup.mockResolvedValue({ vaultId: 'VAULT2', email: 'other@example.com' })
    const done = await savedPaypal.finishChange('SETUP1')
    expect(done).toMatchObject({ status: 'saved', account: 'o***@example.com', returnTo: 'profile' })
    expect(updateCustomer).toHaveBeenCalledWith('c1', { savedPaypal: expect.objectContaining({ vaultId: 'VAULT2' }) })
    expect(paypal.deleteSaved).toHaveBeenCalledWith('VAULT1')
  })

  test('change account, but PayPal hands back the same saved account: "same", nothing deleted', async () => {
    getResult.mockResolvedValue({ customerId: 'c1', returnTo: 'profile' })
    getCustomer.mockResolvedValue(john({ savedPaypal: saved }))
    paypal.finishVaultSetup.mockResolvedValue({ vaultId: 'VAULT1', email: 'john.doe@example.com' })
    const done = await savedPaypal.finishChange('SETUP2')
    expect(done).toMatchObject({ status: 'same', account: 'j***@example.com' })
    expect(updateCustomer).not.toHaveBeenCalled()
    expect(paypal.deleteSaved).not.toHaveBeenCalled()
  })

  test('an unknown setup token changes nothing', async () => {
    getResult.mockResolvedValue(null)
    expect(await savedPaypal.finishChange('NOPE1234')).toEqual({ status: 'not_found' })
    expect(paypal.finishVaultSetup).not.toHaveBeenCalled()
  })

  test('ending the demo session deletes the saved PayPal at PayPal', async () => {
    getCustomer.mockResolvedValue(john({ savedPaypal: saved }))
    await savedPaypal.forget('c1')
    expect(paypal.deleteSaved).toHaveBeenCalledWith('VAULT1')
  })
})
