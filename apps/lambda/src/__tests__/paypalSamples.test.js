'use strict'

// Sample bookings paid with real sandbox PayPal:
// each sample takes a matching payment from a pool made once by
// scripts/paypal-samples.js. The pool is shared by every demo session, so a
// sample is read-only: it counts as PayPal money everywhere, but nothing may
// refund it. Without a matching pool payment it falls back to made-up money.

jest.mock('../services/dynamo/appointments', () => {
  const rows = []
  return {
    __rows: rows,
    createAppointment: jest.fn(async a => { rows.push({ ...a }); return { created: true } }),
    getAppointmentsForBusiness: jest.fn(async (bid, from, to) => rows.filter(a => a.businessId === bid && (!from || a.startTime >= from) && (!to || a.startTime <= to)).map(a => ({ ...a }))),
    updateAppointment: jest.fn(async (bid, start, id, u) => { Object.assign(rows.find(a => a.appointmentId === id), u) })
  }
})
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn(), updateBusiness: jest.fn() }))
jest.mock('../services/redis', () => ({ releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../core/bookingMail', () => ({ cancelled: jest.fn().mockResolvedValue({}) }))

process.env.FLOW_LINK_SECRET = 'test-secret'
const appts = require('../services/dynamo/appointments')
const { getBusiness } = require('../services/dynamo/businesses')
const { seedOthers, planOthers, clientIdHash, kindOf } = require('../demo/seedBookings')
const { CATALOG } = require('../demo/templates')
const { dayjs } = require('../utils/time')
const { createToken } = require('../utils/jwt')

const willow = { ...CATALOG[0].build(), businessId: 'biz-w' }   // demoTemplate 'willow'
// Wednesday noon in Austin: two of today's samples are already over.
const NOW = dayjs.tz('2026-10-21 12:00', 'America/Chicago').valueOf()

// A pool that covers exactly what Willow's plan needs at NOW, like the script makes.
function poolFor(business, now) {
  const list = planOthers(business, { now }).filter(s => s.paid > 0).map((s, n) => ({
    amount: s.paid, currency: 'USD', orderId: `ORD${n}`, captureId: `CAP${n}`, ...(s.status === 'cancelled' ? { refundId: `REF${n}` } : {})
  }))
  return { env: 'sandbox', businesses: { [business.demoTemplate]: list } }
}

beforeEach(() => { appts.__rows.length = 0; jest.clearAllMocks() })

describe('seeding', () => {
  test('each sample takes a matching real payment and is stored as a PayPal booking', async () => {
    const pool = poolFor(willow, NOW)
    const n = await seedOthers(willow, { sid: 's1', now: NOW, pool })
    const rows = appts.__rows
    expect(n).toBe(rows.length)
    expect(rows.length).toBeGreaterThanOrEqual(6)
    for (const r of rows) {
      expect(r).toMatchObject({ paymentProvider: 'paypal', samplePayment: true, seeded: true, seededOther: true })
      expect(r.paymentId).toMatch(/^CAP\d+$/)
      expect(r.providerOrderId).toMatch(/^ORD\d+$/)
      const used = pool.businesses.willow.find(x => x.captureId === r.paymentId)
      expect(kindOf(used.amount, used.currency, !!used.refundId)).toBe(kindOf(r.amountPaid, r.currency, r.status === 'cancelled'))
    }
    // No payment backs two samples of the same business.
    expect(new Set(rows.map(r => r.paymentId)).size).toBe(rows.length)
    // A cancelled sample was refunded in full, through its own refund.
    for (const r of rows.filter(x => x.status === 'cancelled')) expect(r).toMatchObject({ refundAmount: r.amountPaid, refundStatus: 'COMPLETED', refundId: expect.stringMatching(/^REF/) })
  })

  test('a sample with no matching pool payment falls back to made-up money', async () => {
    const pool = poolFor(willow, NOW)
    pool.businesses.willow = pool.businesses.willow.map(x => ({ ...x, amount: x.amount + 1 }))   // nothing matches
    await seedOthers(willow, { sid: 's1', now: NOW, pool })
    expect(appts.__rows.every(r => r.paymentProvider === 'demo' && r.paymentId === null && !r.samplePayment)).toBe(true)
  })

  test("another business's pool payments are never used", async () => {
    const pool = poolFor(willow, NOW)
    pool.businesses = { eastside: pool.businesses.willow }
    await seedOthers(willow, { sid: 's1', now: NOW, pool })
    expect(appts.__rows.every(r => r.paymentProvider === 'demo')).toBe(true)
  })
})

describe('the pool file', () => {
  const env = { ...process.env }
  afterEach(() => { process.env = { ...env } })

  // In its own module registry, so the rest of this file keeps its mocks.
  const withFile = pool => {
    let out
    jest.isolateModules(() => {
      jest.doMock('../demo/paypalSamples.json', () => pool, { virtual: true })
      out = require('../demo/seedBookings').loadPool()
    })
    return out
  }

  test('is used only with the PayPal app that made it, in the sandbox', () => {
    process.env.PAYPAL_ENV = 'sandbox'
    process.env.PAYPAL_CLIENT_ID = 'client-a'
    const pool = { env: 'sandbox', clientIdHash: clientIdHash('client-a'), businesses: {} }
    expect(withFile(pool)).toEqual(pool)
    expect(withFile({ ...pool, clientIdHash: clientIdHash('client-b') })).toBeNull()
    expect(withFile({ ...pool, env: 'live' })).toBeNull()
    process.env.PAYPAL_ENV = 'live'
    expect(withFile({ ...pool, env: 'live' })).toBeNull()
  })

  test('stores a short hash of the client ID, never the ID', () => {
    expect(clientIdHash('client-a')).toMatch(/^[0-9a-f]{12}$/)
    expect(clientIdHash('client-a')).not.toContain('client')
  })
})

describe('the owner side', () => {
  const dash = async (method, proxy, body, query) => {
    const { handler } = require('../handlers/dashboardApi')
    const r = await handler({ httpMethod: method, pathParameters: { proxy }, queryStringParameters: query || null, headers: { Authorization: `Bearer ${createToken({ businessId: 'biz-w' }, 3600)}` }, body: body ? JSON.stringify(body) : null })
    return JSON.parse(r.body)
  }
  beforeEach(() => { getBusiness.mockResolvedValue(willow) })

  test('the ledger and the Overview count sample payments as PayPal money, and nothing made-up', async () => {
    const now = Date.now()
    await seedOthers(willow, { sid: 's1', now, pool: poolFor(willow, now) })
    const from = new Date(now - 10 * 86_400_000).toISOString(), to = new Date(now + 10 * 86_400_000).toISOString()
    const { bookings } = await dash('GET', 'bookings', null, { from, to })
    expect(bookings.length).toBeGreaterThan(0)
    for (const b of bookings) expect(b).toMatchObject({ paidWith: 'paypal', samplePayment: true, paidWithPayPal: false })

    const stats = await dash('GET', 'stats')
    const inWindow = appts.__rows.filter(a => a.startTime >= dayjs().tz('America/Chicago').startOf('day').subtract(7, 'day').toISOString())
    const net = inWindow.reduce((s, a) => s + a.amountPaid - (a.refundAmount || 0), 0)
    expect(stats.weekRevenue).toBeCloseTo(net, 2)
    expect(stats.impact.paidUpfront).toBeGreaterThan(0)
  })

  test('made-up money (no pool) is left out of Collected, so it agrees with PayPal: $0', async () => {
    await seedOthers(willow, { sid: 's1', now: Date.now(), pool: null })
    const stats = await dash('GET', 'stats')
    expect(stats.weekRevenue).toBe(0)
    expect(stats.impact.paidUpfront).toBe(0)
  })
})

describe('shared, so read-only', () => {
  const sample = () => ({ appointmentId: 'smp00001-aaaa', businessId: 'biz-w', startTime: new Date(Date.now() + 2 * 86_400_000).toISOString(), status: 'confirmed', serviceName: 'Haircut', amountPaid: 40, totalAmount: 40, currency: 'USD', paymentProvider: 'paypal', paymentId: 'CAP1', providerOrderId: 'ORD1', samplePayment: true, seeded: true, seededOther: true, customerId: 'demo-s1-o4' })

  test('the owner can\'t refund a sample, and is told why', async () => {
    appts.__rows.push(sample())
    const r = await require('../core/ownerOps').refundBooking(willow, { booking_id: 'smp00001-aaaa', confirm: true })
    expect(r.error).toMatch(/sample booking.*every demo session shares it/i)
  })

  test('cancelling a sample moves no money and says so', async () => {
    appts.__rows.push(sample())
    const ops = require('../core/ownerOps')
    const q = await ops.cancelBooking(willow, { booking_id: 'smp00001-aaaa' })
    expect(q.message).toMatch(/sample booking.*moves no money/i)
    const r = await ops.cancelBooking(willow, { booking_id: 'smp00001-aaaa', confirm: true })
    expect(r).toMatchObject({ cancelled: true, refunded: false })
    expect(r.message).toMatch(/sample booking/i)
  })

  test('refundAppointment refuses any seeded booking without calling PayPal', async () => {
    const provider = { refund: jest.fn() }
    let refundAppointment
    jest.isolateModules(() => {
      jest.doMock('../services/payments', () => ({ getProviderById: () => provider, providerIdFor: () => 'paypal' }))
      refundAppointment = require('../core/refunds').refundAppointment
    })
    const r = await refundAppointment({ business: willow, appointment: sample(), amount: 40 })
    expect(r).toMatchObject({ refunded: false, reason: 'sample_booking' })
    expect(provider.refund).not.toHaveBeenCalled()
  })

  test('the owner can still look a sample up at PayPal (it is a real capture)', () => {
    const { _paypalRef } = require('../core/ownerPaypal')
    expect(_paypalRef(sample())).toMatchObject({ captureId: 'CAP1', providerOrderId: 'ORD1' })
    // Made-up history still has nothing to look up.
    expect(_paypalRef({ ...sample(), samplePayment: false, paymentId: 'hist-1' })).toHaveProperty('none')
  })
})
