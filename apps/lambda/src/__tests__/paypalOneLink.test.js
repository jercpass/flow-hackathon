'use strict'

// Link PayPal once, pay everywhere: in the demo,
// with no saved PayPal a payment is never a checkout link but "connect your PayPal"
// (one link, which saves it); with it, memberships and packs are paid from the saved
// PayPal after a yes, and a monthly one renews from it. PayPal is mocked.

jest.mock('../services/dynamo/customers', () => {
  const db = new Map()
  return {
    __db: db,
    getCustomer: jest.fn(async id => (db.has(id) ? JSON.parse(JSON.stringify(db.get(id))) : null)),
    updateCustomer: jest.fn(async (id, u) => { db.set(id, { ...db.get(id), ...JSON.parse(JSON.stringify(u)) }) })
  }
})
jest.mock('../services/dynamo/businesses', () => {
  const db = new Map()
  return {
    __db: db,
    getBusiness: jest.fn(async id => (db.has(id) ? JSON.parse(JSON.stringify(db.get(id))) : null)),
    updateBusiness: jest.fn(async (id, u) => { db.set(id, { ...db.get(id), ...JSON.parse(JSON.stringify(u)) }) })
  }
})
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn().mockResolvedValue([]), createAppointment: jest.fn(async () => ({ created: true })), updateAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ reserveSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn().mockResolvedValue(['staff-ana']), getNextQueueToken: jest.fn(), priceForUnit: jest.fn(s => s) }))
jest.mock('../core/paymentFlow', () => ({ requestPayment: jest.fn(), requestBalancePayment: jest.fn() }))
jest.mock('../services/notify', () => ({ notifyOwner: jest.fn().mockResolvedValue(true), notifyCustomer: jest.fn().mockResolvedValue(['inbox']) }))
jest.mock('../core/invoices', () => ({ issueForPack: jest.fn().mockResolvedValue({}), receiptForPack: jest.fn().mockResolvedValue(null), invoiceLine: jest.fn(() => '') }))
jest.mock('../core/paypalLogin', () => ({ start: jest.fn(async () => ({ url: 'https://paypal.test/connect' })) }))
jest.mock('../core/demoSession', () => ({ getActiveSession: jest.fn(async sid => ({ sid })), checkCheckoutLimit: jest.fn().mockResolvedValue(false) }))
jest.mock('../services/payments', () => ({ getPaymentProvider: () => ({ id: 'paypal', isConfigured: () => true }) }))
jest.mock('../services/payments/paypal', () => ({ isConfigured: () => true, chargeSaved: jest.fn(), createSubscription: jest.fn(), createCheckout: jest.fn() }))

process.env.API_URL = 'http://api.test'
const customers = require('../services/dynamo/customers')
const businesses = require('../services/dynamo/businesses')
const { requestPayment } = require('../core/paymentFlow')
const { notifyCustomer } = require('../services/notify')
const paypal = require('../services/payments/paypal')
const memberships = require('../core/memberships')
const { executeTool } = require('../services/tools')
const { localDate } = require('../utils/time')
const { CATALOG } = require('../demo/templates')

const business = { ...CATALOG[0].build(), businessId: 'biz-1', paypalMerchantId: null }   // Willow: Haircut $40; Willow Monthly $35; 5-Cut Pack $180
const saved = { vaultId: 'VAULT1', email: 'john.doe@example.com' }
const day = d => localDate(new Date(Date.now() + d * 86_400_000).toISOString(), 'America/Chicago')
const charged = (amount = 35) => ({ providerOrderId: 'ORD1', status: 'COMPLETED', captured: { captureId: 'CAP1', captureStatus: 'COMPLETED', amount, currency: 'USD' } })

let john
beforeEach(() => {
  jest.clearAllMocks()
  customers.__db.clear(); businesses.__db.clear()
  businesses.__db.set('biz-1', business)
  john = { customerId: 'john', name: 'John Doe', demoSessionId: 'S1' }
  customers.__db.set('john', john)
})
const ctx = (channel = 'web', more = {}) => ({ business, customer: { ...john, ...more }, channel, demoSid: 'S1' })
const conciergeCtx = (channel = 'web', more = {}) => ({ catalog: [business], customer: { ...john, ...more }, customerLocation: { label: 'home' }, channel, demoSid: 'S1' })

describe('not connected yet: "connect your PayPal", never a checkout link', () => {
  test('a paid booking asks to connect, with the one link; nothing is held or charged', async () => {
    const r = await executeTool('book_appointment', { service_name: 'Haircut', start_time: `${day(3)}T10:00`, staff_name: 'Ana' }, ctx())
    expect(r).toMatchObject({ booked: false, needsConnect: true, connectUrl: 'https://paypal.test/connect' })
    expect(r.paymentUrl).toBeUndefined()
    expect(r.message).toMatch(/connect their PayPal once/)
    expect(requestPayment).not.toHaveBeenCalled()
  })

  test('by voice, the connect link goes to the Flow inbox', async () => {
    const r = await executeTool('book_appointment', { service_name: 'Haircut', start_time: `${day(3)}T10:00`, staff_name: 'Ana' }, ctx('speaker'))
    expect(r.needsConnect).toBe(true)
    expect(r.message).toMatch(/link is in their Flow inbox/)
    expect(notifyCustomer).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Connect your PayPal', text: expect.stringContaining('https://paypal.test/connect') }))
  })

  test('joining a membership asks to connect too', async () => {
    const r = await executeTool('join_membership', { business_name: business.name, plan_name: 'Willow Monthly' }, conciergeCtx())
    expect(r).toMatchObject({ needsConnect: true, membership: true })
    expect(paypal.createSubscription).not.toHaveBeenCalled()
    expect(paypal.chargeSaved).not.toHaveBeenCalled()
  })
})

describe('connected: memberships and packs from the saved PayPal', () => {
  test('first the price to read back, then a yes pays it and the membership is active (no PayPal page)', async () => {
    const quote = await executeTool('join_membership', { business_name: business.name, plan_name: 'Willow Monthly' }, conciergeCtx('web', { savedPaypal: saved }))
    expect(quote).toMatchObject({ needsConfirm: true, amount: 35, savedPaypal: 'j***@example.com' })
    expect(quote.message).toMatch(/renews monthly from the same PayPal/)
    expect(paypal.chargeSaved).not.toHaveBeenCalled()

    customers.__db.set('john', { ...john, savedPaypal: saved })
    paypal.chargeSaved.mockResolvedValue(charged(35))
    const r = await executeTool('join_membership', { business_name: business.name, plan_name: 'Willow Monthly', confirm: true, amount: 35 }, conciergeCtx('web', { savedPaypal: saved }))
    expect(r).toMatchObject({ paid: true, paidWithSaved: true, joined: true, amount: 35 })
    expect(paypal.chargeSaved).toHaveBeenCalledWith(expect.objectContaining({ amount: 35, vaultId: 'VAULT1', clientMetadataId: expect.stringMatching(/^[0-9a-f]{32}$/) }))
    // The customer said yes in the web chat: their charge, with risk data.
    expect(paypal.chargeSaved.mock.calls[0][0].initiator).toBeUndefined()
    expect(paypal.createSubscription).not.toHaveBeenCalled()
    const m = customers.__db.get('john').memberships[0]
    expect(m).toMatchObject({ status: 'active', billing: 'saved_paypal', kind: 'monthly', captureId: 'CAP1', uses: { 'svc-haircut': 1 } })
  })

  test('a yes with a different amount charges nothing', async () => {
    customers.__db.set('john', { ...john, savedPaypal: saved })
    const r = await executeTool('join_membership', { business_name: business.name, plan_name: 'Willow Monthly', confirm: true, amount: 20 }, conciergeCtx('web', { savedPaypal: saved }))
    expect(r.needsConfirm).toBe(true)
    expect(paypal.chargeSaved).not.toHaveBeenCalled()
  })

  test('a pack is paid the same way', async () => {
    customers.__db.set('john', { ...john, savedPaypal: saved })
    paypal.chargeSaved.mockResolvedValue(charged(180))
    const r = await executeTool('join_membership', { business_name: business.name, plan_name: '5-Cut Pack', confirm: true, amount: 180 }, conciergeCtx('web', { savedPaypal: saved }))
    expect(r).toMatchObject({ paid: true, kind: 'pack' })
    expect(customers.__db.get('john').memberships[0]).toMatchObject({ status: 'active', kind: 'pack', uses: { 'svc-haircut': 5 } })
  })
})

describe('monthly renewal from the saved PayPal', () => {
  const lapsed = () => ({ membershipId: 'M1', businessId: 'biz-1', planId: business.config.memberships[0].planId, planName: 'Willow Monthly', kind: 'monthly', billing: 'saved_paypal', price: 35, currency: 'USD', covers: [{ serviceId: 'svc-haircut', uses: 1 }], uses: { 'svc-haircut': 0 }, status: 'active', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z' })

  test('past its month it covers nothing until paid (no free month)', () => {
    const c = { ...john, memberships: [lapsed()] }
    const { live } = memberships.inForce(c, 'biz-1')
    expect(live).toHaveLength(0)
    expect(c.memberships[0].status).toBe('renewal_due')
  })

  test('the next use charges the next month from the saved PayPal, then covers it', async () => {
    customers.__db.set('john', { ...john, savedPaypal: saved, memberships: [lapsed()] })
    paypal.chargeSaved.mockResolvedValue(charged(35))
    const cover = await memberships.coverFor('john', business, { serviceId: 'svc-haircut' })
    expect(paypal.chargeSaved).toHaveBeenCalledWith(expect.objectContaining({ amount: 35, vaultId: 'VAULT1', referenceId: 'mbr_M1_r1', initiator: 'MERCHANT', usagePattern: 'SUBSCRIPTION_PREPAID' }))
    expect(cover).toMatchObject({ covered: true })
    expect(customers.__db.get('john').memberships[0]).toMatchObject({ status: 'active', renewals: 1, uses: { 'svc-haircut': 1 } })
  })

  test('if the saved PayPal doesn\'t pay, it\'s past due and the customer is told', async () => {
    customers.__db.set('john', { ...john, savedPaypal: saved, memberships: [lapsed()] })
    paypal.chargeSaved.mockRejectedValue(new Error('INSTRUMENT_DECLINED'))
    const cover = await memberships.coverFor('john', business, { serviceId: 'svc-haircut' })
    expect(cover).toBeNull()
    expect(customers.__db.get('john').memberships[0].status).toBe('past_due')
    expect(notifyCustomer).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Willow Monthly: payment needed' }))
  })
})
