'use strict'

// Memberships (PayPal Subscriptions) and packs (one PayPal payment): joining,
// activation checked with PayPal, covered bookings at $0, member discounts,
// giving a use back on cancel, cancelling, monthly resets, the owner's plans,
// and subscription webhooks. PayPal is mocked.

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
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), createAppointment: jest.fn(async () => ({ created: true })), updateAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ reserveSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn().mockResolvedValue(['staff-ana']), getNextQueueToken: jest.fn(), priceForUnit: jest.fn((svc) => svc) }))
jest.mock('../core/paymentFlow', () => ({ requestPayment: jest.fn(), requestBalancePayment: jest.fn() }))
jest.mock('../services/notify', () => ({ notifyOwner: jest.fn().mockResolvedValue(true), notifyCustomer: jest.fn().mockResolvedValue(['inbox']) }))
jest.mock('../services/payments/paypal', () => ({
  isConfigured: () => true,
  createMembershipPlan: jest.fn(async () => ({ productId: 'PROD-1', planId: 'P-PLAN1' })),
  createSubscription: jest.fn(async () => ({ subscriptionId: 'I-SUB1', approveUrl: 'https://paypal.test/subscribe', status: 'APPROVAL_PENDING' })),
  getSubscription: jest.fn(),
  cancelSubscription: jest.fn(async id => ({ subscriptionId: id, status: 'CANCELLED' })),
  createCheckout: jest.fn(async () => ({ providerOrderId: 'ORDERPACK1', approveUrl: 'https://paypal.test/pay' })),
  capture: jest.fn()
}))
jest.mock('../services/payments', () => ({ getPaymentProvider: () => ({ id: 'paypal', isConfigured: () => true }) }))

process.env.API_URL = 'http://api.test'
const customers = require('../services/dynamo/customers')
const businesses = require('../services/dynamo/businesses')
const { getAppointmentsForBusiness, createAppointment, updateAppointment } = require('../services/dynamo/appointments')
const { requestPayment } = require('../core/paymentFlow')
const { notifyOwner } = require('../services/notify')
const paypal = require('../services/payments/paypal')
const memberships = require('../core/memberships')
const { executeTool } = require('../services/tools')
const { CATALOG, PERSONA } = require('../demo/templates')

const BID = 'demo-m'
let catalog
const ctx = () => ({ catalog, customer: { customerId: 'sam', name: 'Sam Rivera', demoSessionId: 'm' }, customerLocation: { ...PERSONA.home }, business: catalog[0], channel: 'web' })
// 11:00 at the salon, d days from now: on the grid for both Haircut (hourly) and Color (2 h).
const { toUtcIso, localDate } = require('../utils/time')
const inDays = d => toUtcIso(`${localDate(new Date(Date.now() + d * 86_400_000).toISOString(), 'America/Chicago')}T11:00`, 'America/Chicago')

beforeEach(() => {
  jest.clearAllMocks()
  customers.__db.clear(); businesses.__db.clear()
  catalog = CATALOG.map((c, i) => ({ ...c.build(), businessId: i === 0 ? BID : `${BID}-${c.slug}`, demoSessionId: 'm', ownerInbox: i === 0 }))
  for (const b of catalog) businesses.__db.set(b.businessId, b)
  customers.__db.set('sam', { customerId: 'sam', name: 'Sam Rivera', demoSessionId: 'm' })
  getAppointmentsForBusiness.mockResolvedValue([])
  paypal.getSubscription.mockResolvedValue({ subscriptionId: 'I-SUB1', status: 'ACTIVE', customId: null, nextBillingTime: inDays(30) })
  paypal.capture.mockResolvedValue({ captureId: 'CAPPACK', captureStatus: 'COMPLETED', amount: 180 })
  requestPayment.mockResolvedValue({ orderId: 'O1', amountDue: 108, currency: 'USD', paymentUrl: 'https://paypal.test/order' })
})

async function joinMonthly() {
  const r = await executeTool('join_membership', { business_name: 'Willow & Co. Salon', plan_name: 'Willow Monthly' }, ctx())
  const m = customers.__db.get('sam').memberships[0]
  paypal.getSubscription.mockResolvedValue({ subscriptionId: 'I-SUB1', status: 'ACTIVE', customId: `${BID}|sam|${m.membershipId}`, nextBillingTime: inDays(30) })
  await memberships.activate({ businessId: BID, customerId: 'sam', membershipId: m.membershipId })
  return { r, m }
}

test('"what do you offer" and list_memberships show the plans, paid with PayPal', async () => {
  const s = await executeTool('list_services', { business_name: 'Willow & Co. Salon' }, ctx())
  expect(s.memberships_and_packs.map(p => p.name)).toEqual(['Willow Monthly', '5-Cut Pack'])
  const all = await executeTool('list_memberships', {}, ctx())
  expect(all.offers.map(o => o.business)).toEqual(['Willow & Co. Salon', 'Eastside Barber Co.', 'Barton Springs Day Spa'])
  expect(all.offers[0].plans[0]).toMatchObject({ price: '$35 a month', includes: '1 Haircut every month', discount: '10% off Color & Gloss', paid_with: 'PayPal, billed monthly; cancel any time' })
  expect(all.offers[0].plans[1]).toMatchObject({ price: '$180 once', includes: '5 Haircuts, to use within 180 days' })
})

test('join a monthly membership: PayPal plan + subscription link, active only after PayPal confirms', async () => {
  const r = await executeTool('join_membership', { business_name: 'Willow & Co. Salon', plan_name: 'willow monthly' }, ctx())
  expect(r).toMatchObject({ paymentUrl: 'https://paypal.test/subscribe', paymentKind: 'subscription', kind: 'monthly', amount: 35 })
  expect(paypal.createMembershipPlan).toHaveBeenCalledWith(expect.objectContaining({ name: 'Willow Monthly', price: 35, currency: 'USD' }))
  const sub = paypal.createSubscription.mock.calls[0][0]
  expect(sub).toMatchObject({ planId: 'P-PLAN1' })
  expect(sub.returnUrl).toMatch(/^http:\/\/api\.test\/pay\/paypal\/membership\/return\?bid=demo-m&cid=sam&mid=[a-f0-9]+&ch=web$/)
  const m = customers.__db.get('sam').memberships[0]
  expect(m).toMatchObject({ status: 'pending', subscriptionId: 'I-SUB1' })
  expect(businesses.__db.get(BID).config.memberships[0]).toMatchObject({ paypalPlanId: 'P-PLAN1', paypalPrice: 35 })

  // A wrong custom_id from PayPal is refused; the right one activates.
  paypal.getSubscription.mockResolvedValue({ subscriptionId: 'I-SUB1', status: 'ACTIVE', customId: 'someone|else|x' })
  expect((await memberships.activate({ businessId: BID, customerId: 'sam', membershipId: m.membershipId })).status).toBe('failed')
  paypal.getSubscription.mockResolvedValue({ subscriptionId: 'I-SUB1', status: 'ACTIVE', customId: `${BID}|sam|${m.membershipId}` })
  expect(await memberships.activate({ businessId: BID, customerId: 'sam', membershipId: m.membershipId })).toMatchObject({ status: 'active', plan: 'Willow Monthly' })
  expect(customers.__db.get('sam').memberships[0]).toMatchObject({ status: 'active', uses: { 'svc-haircut': 1 } })
  expect(businesses.__db.get(BID).members).toEqual([expect.objectContaining({ customerName: 'Sam Rivera', planName: 'Willow Monthly', status: 'active' })])
  expect(notifyOwner.mock.calls.some(c => /New member: Sam Rivera joined Willow Monthly/.test(c[0].subject))).toBe(true)
  // Idempotent (return page + webhook both arriving).
  expect((await memberships.activate({ businessId: BID, customerId: 'sam', membershipId: m.membershipId })).already).toBe(true)
  expect((await executeTool('join_membership', { business_name: 'Willow & Co. Salon', plan_name: 'Willow Monthly' }, ctx())).error).toMatch(/Already a member/)
})

test('a covered haircut costs nothing and uses one; the next one is paid; colour gets the 10% member discount', async () => {
  await joinMonthly()
  const r = await executeTool('book_appointment', { business_name: 'Willow & Co. Salon', service_name: 'Haircut', start_time: inDays(3), staff_name: 'Ana' }, ctx())
  expect(r).toMatchObject({ booked: true, coveredBy: 'Willow Monthly', usesLeft: 0 })
  expect(r.message).toMatch(/nothing to pay\. 0 Haircuts left this month/)
  expect(requestPayment).not.toHaveBeenCalled()
  expect(createAppointment.mock.calls[0][0]).toMatchObject({ amountPaid: 0, paymentStatus: 'membership', membershipPlan: 'Willow Monthly', totalAmount: 40 })
  expect(customers.__db.get('sam').memberships[0].uses['svc-haircut']).toBe(0)

  // No uses left this month → a normal paid booking (no discount on haircuts).
  await executeTool('book_appointment', { business_name: 'Willow & Co. Salon', service_name: 'Haircut', start_time: inDays(5) }, ctx())
  expect(requestPayment.mock.calls[0][0].discountPercent).toBe(0)

  // Colour: 10% member discount, worked out in code.
  const c = await executeTool('book_appointment', { business_name: 'Willow & Co. Salon', service_name: 'Color & Gloss', start_time: inDays(6) }, ctx())
  expect(requestPayment.mock.calls[1][0].discountPercent).toBe(10)
  expect(c).toMatchObject({ memberDiscount: '10%', amount: 108 })
  expect(c.message).toMatch(/10% member discount/)
})

test('cancelling a covered booking gives the use back (no money moves)', async () => {
  const { m } = await joinMonthly()
  await executeTool('book_appointment', { business_name: 'Willow & Co. Salon', service_name: 'Haircut', start_time: inDays(3) }, ctx())
  const booked = { ...createAppointment.mock.calls[0][0], appointmentId: 'a1' }
  getAppointmentsForBusiness.mockImplementation(async id => (id === BID ? [booked] : []))
  const q = await executeTool('cancel_booking', { business_name: 'Willow & Co. Salon' }, ctx())
  expect(q.message).toMatch(/covered by Willow Monthly, so cancelling gives the Haircut back/)
  const r = await executeTool('cancel_booking', { business_name: 'Willow & Co. Salon', confirm: true }, ctx())
  expect(r).toMatchObject({ cancelled: true, usesLeft: 1 })
  expect(updateAppointment).toHaveBeenCalledWith(BID, booked.startTime, 'a1', expect.objectContaining({ status: 'cancelled' }))
  expect(customers.__db.get('sam').memberships.find(x => x.membershipId === m.membershipId).uses['svc-haircut']).toBe(1)
})

test('cancel the membership: quoted, PayPal stops billing, uses last until the end of the month', async () => {
  await joinMonthly()
  const q = await executeTool('cancel_membership', { business_name: 'Willow & Co. Salon' }, ctx())
  expect(q.needs_confirmation).toBe(true)
  expect(q.changes[0]).toMatch(/PayPal stops billing \$35 a month/)
  expect(paypal.cancelSubscription).not.toHaveBeenCalled()
  const r = await executeTool('cancel_membership', { business_name: 'Willow & Co. Salon', confirm: true }, ctx())
  expect(r.cancelled).toBe(true)
  expect(paypal.cancelSubscription).toHaveBeenCalledWith('I-SUB1', 'Cancelled by the customer')
  const mine = await executeTool('my_memberships', {}, ctx())
  expect(mine.memberships[0]).toMatchObject({ plan: 'Willow Monthly', status: 'cancelled', renews: false })
  // Still covers this month.
  expect((await executeTool('book_appointment', { business_name: 'Willow & Co. Salon', service_name: 'Haircut', start_time: inDays(2) }, ctx())).coveredBy).toBe('Willow Monthly')
})

test('a pack: one PayPal payment, 5 uses, no cancelling (it just expires)', async () => {
  const r = await executeTool('join_membership', { business_name: 'Willow & Co. Salon', plan_name: '5-Cut Pack' }, ctx())
  expect(r).toMatchObject({ paymentKind: 'pack', paymentUrl: 'https://paypal.test/pay', amount: 180 })
  expect(paypal.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ amount: 180, referenceId: expect.stringMatching(/^mbr_/) }))
  const m = customers.__db.get('sam').memberships[0]
  expect(await memberships.activate({ businessId: BID, customerId: 'sam', membershipId: m.membershipId })).toMatchObject({ status: 'active', kind: 'pack' })
  expect(paypal.capture).toHaveBeenCalledWith('ORDERPACK1')
  expect(customers.__db.get('sam').memberships[0]).toMatchObject({ uses: { 'svc-haircut': 5 }, captureId: 'CAPPACK' })
  expect((await executeTool('cancel_membership', { business_name: 'Willow & Co. Salon' }, ctx())).error).toMatch(/pack: it doesn't renew/)
  const b = await executeTool('book_appointment', { business_name: 'Willow & Co. Salon', service_name: 'Haircut', start_time: inDays(3) }, ctx())
  expect(b.message).toMatch(/4 Haircuts left in the pack/)
})

test('a new month resets the uses; an expired pack stops covering', () => {
  const customer = { memberships: [
    { membershipId: 'm1', businessId: BID, kind: 'monthly', status: 'active', covers: [{ serviceId: 'svc-haircut', uses: 1 }], uses: { 'svc-haircut': 0 }, periodStart: inDays(-40), periodEnd: inDays(-10) },
    { membershipId: 'm2', businessId: BID, kind: 'pack', status: 'active', covers: [{ serviceId: 'svc-haircut', uses: 5 }], uses: { 'svc-haircut': 2 }, periodEnd: inDays(-1) }
  ] }
  const { live, changed } = memberships.inForce(customer, BID)
  expect(changed).toBe(true)
  expect(live.map(m => m.membershipId)).toEqual(['m1'])
  expect(customer.memberships[0].uses['svc-haircut']).toBe(1)
  expect(Date.parse(customer.memberships[0].periodEnd)).toBeGreaterThan(Date.now())
  expect(customer.memberships[1].status).toBe('expired')
})

test('owner: create a plan (quoted), change its price, see members and monthly recurring revenue, cancel a member', async () => {
  const biz = () => businesses.__db.get(BID)
  const q = await memberships.createPlan(biz(), { name: 'Color Club', price: 99, covers: [{ service_name: 'Color & Gloss', uses: 1 }] })
  expect(q.needs_confirmation).toBe(true)
  expect(q.changes[0]).toBe('new monthly membership: Color Club, $99 a month')
  await memberships.createPlan(biz(), { name: 'Color Club', price: 99, covers: [{ service_name: 'Color & Gloss', uses: 1 }], confirm: true })
  expect(biz().config.memberships.map(p => p.name)).toContain('Color Club')
  const u = await memberships.updatePlan(biz(), { plan_name: 'Willow Monthly', price: 39 })
  expect(u.changes).toEqual(expect.arrayContaining(['price: $35 a month → $39 a month', 'current members keep the price they joined at; new members pay the new price']))
  // Pausing is said once, in words.
  expect((await memberships.updatePlan(biz(), { plan_name: 'Color Club', active: false })).changes).toEqual(['paused: no new members (current members keep it)'])
  expect((await memberships.updatePlan(biz(), { plan_name: 'Willow Monthly', active: true })).error).toBe('Nothing to change.')

  await joinMonthly()
  const o = await memberships.overview(biz())
  expect(o).toMatchObject({ monthly_recurring_revenue: '$35' })
  expect(o.members[0]).toMatchObject({ customer: 'Sam Rivera', plan: 'Willow Monthly', status: 'active', uses_left: '1 Haircut this month' })
  expect((await memberships.cancelMember(biz(), { customer_name: 'Sam' })).needs_confirmation).toBe(true)
  const c = await memberships.cancelMember(biz(), { customer_name: 'Sam', confirm: true })
  expect(c.cancelled).toBe(true)
  expect(paypal.cancelSubscription).toHaveBeenCalledWith('I-SUB1', 'Cancelled by the business')
})

test('subscription webhooks: renewal paid, payment failed (owner alerted), cancelled on PayPal', async () => {
  const { m } = await joinMonthly()
  const custom_id = `${BID}|sam|${m.membershipId}`
  await memberships.onSubscriptionEvent('PAYMENT.SALE.COMPLETED', { custom: custom_id, create_time: '2026-11-17T10:00:00Z' })
  expect(customers.__db.get('sam').memberships[0].lastPaymentAt).toBe('2026-11-17T10:00:00Z')
  await memberships.onSubscriptionEvent('BILLING.SUBSCRIPTION.PAYMENT.FAILED', { custom_id })
  expect(customers.__db.get('sam').memberships[0].paymentFailed).toBe(true)
  expect(notifyOwner.mock.calls.some(c => /Payment failed: Sam Rivera/.test(c[0].subject))).toBe(true)
  await memberships.onSubscriptionEvent('BILLING.SUBSCRIPTION.CANCELLED', { custom_id })
  expect(customers.__db.get('sam').memberships[0]).toMatchObject({ status: 'cancelled', cancelledBy: 'paypal' })
  expect(await memberships.onSubscriptionEvent('PAYMENT.SALE.COMPLETED', { custom: 'not-ours' })).toEqual({ ignored: true })
})

test('setup: the price list offers both plans, and the ready-made salon has them with fixed IDs', async () => {
  const { DOCS } = require('../demo/setupDocs')
  expect(DOCS.find(d => d.id === 'price-list').text).toMatch(/Willow Monthly: \$35 a month[\s\S]*5-Cut Pack: \$180/)
  const willow = CATALOG[0].build().config
  expect(willow.memberships.map(p => p.planId)).toEqual(['plan-monthly', 'plan-pack5'])
  const demoSetup = require('../core/demoSetup')
  const { normalize } = require('../services/setupAi')
  const draft = demoSetup.reconcile(normalize({
    services: [{ name: 'Haircut', price: 40, duration: 60 }, { name: 'Color & Gloss', price: 120, duration: 120 }],
    memberships: [{ name: 'Willow Monthly', kind: 'monthly', price: 35, covers: [{ service: 'Haircut', uses: 1 }], discountPercent: 10, discountServices: ['Color & Gloss'] }]
  }))
  expect(draft.memberships[0]).toMatchObject({ planId: 'plan-monthly', covers: [{ serviceId: 'svc-haircut', uses: 1 }], discountServiceIds: ['svc-color'] })
  expect(demoSetup.summarize(draft).memberships[0]).toMatchObject({ name: 'Willow Monthly', price: '$35 a month' })
})
