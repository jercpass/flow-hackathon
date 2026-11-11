'use strict'

// Seat holds while a customer pays. With Redis unreachable (Flow's own stack
// has none, and local runs usually don't either), the hold falls back to the
// demo store, so two customers still can't both get a PayPal link for the last
// seat. Releasing is owner-safe, like Redis.

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  status: 'wait',
  connect: () => Promise.reject(new Error('Connection is closed.')),
  get: () => Promise.reject(new Error('Connection is closed.')),
  set: () => Promise.reject(new Error('Connection is closed.')),
  del: () => Promise.reject(new Error('Connection is closed.')),
  on: () => {}
})))

const { setStore, memory, store } = require('../services/demoStore')
const redis = require('../services/redis')

const START = '2026-11-03T15:00:00.000Z'
beforeEach(() => setStore(memory()))

test('Redis down: the first customer holds the seat, a second is refused, the first can hold it again', async () => {
  expect(await redis.holdSlotForPayment('biz', START, 'staff-ana', 'sam')).toEqual({ held: true, backup: true })
  expect(await redis.holdSlotForPayment('biz', START, 'staff-ana', 'pat')).toEqual({ held: false })
  expect(await redis.holdSlotForPayment('biz', START, 'staff-ana', 'sam')).toMatchObject({ held: true })
  // Another stylist at the same time is a different seat.
  expect(await redis.holdSlotForPayment('biz', START, 'staff-ben', 'pat')).toMatchObject({ held: true })
})

test('the booking write respects the hold: only the customer who holds it can lock it', async () => {
  await redis.holdSlotForPayment('biz', START, 'staff-ana', 'sam')
  expect(await redis.reserveSlot('biz', START, 'staff-ana', 'pat')).toBe(false)
  expect(await redis.reserveSlot('biz', START, 'staff-ana', 'sam')).toBe(true)
})

test('releasing is owner-safe; once released (or expired) the seat is free again', async () => {
  await redis.holdSlotForPayment('biz', START, 'staff-ana', 'sam')
  await redis.releaseSlot('biz', START, 'staff-ana', 'pat')          // not Pat's hold: kept
  expect(await redis.holdSlotForPayment('biz', START, 'staff-ana', 'pat')).toEqual({ held: false })
  await redis.releaseSlot('biz', START, 'staff-ana', 'sam')
  expect(await redis.holdSlotForPayment('biz', START, 'staff-ana', 'pat')).toMatchObject({ held: true })
  // An expired hold doesn't block anyone.
  await store().claimKey('SEATHOLD', 'slot:biz:2026-11-04T15:00:staff-ana', 'sam', Date.now() - 1)
  expect(await redis.holdSlotForPayment('biz', '2026-11-04T15:00:00.000Z', 'staff-ana', 'pat')).toMatchObject({ held: true })
})

test('if the backup store fails too, it fails open (the DB check and the auto-refund still protect the customer)', async () => {
  setStore({ ...memory(), claimKey: async () => { throw new Error('store down') } })
  expect(await redis.holdSlotForPayment('biz', START, 'staff-ana', 'sam')).toEqual({ held: true, degraded: true })
})

// Runs fn as if in AWS, with or without a Redis address, then puts the env back.
async function inAws(redisUrl, fn) {
  const before = { url: process.env.REDIS_URL, fn: process.env.AWS_LAMBDA_FUNCTION_NAME }
  if (redisUrl) process.env.REDIS_URL = redisUrl
  else delete process.env.REDIS_URL
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'flowhq-dev-demo'
  try { return await fn() } finally {
    if (before.url === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = before.url
    if (before.fn === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME
    else process.env.AWS_LAMBDA_FUNCTION_NAME = before.fn
  }
}

test('in AWS with no Redis set, it goes straight to the backup store (no localhost retries)', async () => {
  await inAws(null, async () => {
    expect(await redis.holdSlotForPayment('biz', START, 'staff-ana', 'sam')).toEqual({ held: true, backup: true })
  })
})

// Flow's stack has no Redis on purpose: Under the hood names DynamoDB, not an error.
test('Under the hood says DynamoDB when there is no Redis, and "Redis unreachable" only when one is set', async () => {
  const trace = require('../services/trace')
  const titles = []
  const spy = jest.spyOn(trace, 'event').mockImplementation((kind, title) => { titles.push(title) })
  try {
    await inAws(null, async () => {
      await redis.holdSlotForPayment('biz', START, 'staff-ana', 'sam')
      await redis.releaseSlot('biz', START, 'staff-ana', 'sam')
    })
    expect(titles).toEqual(['Seat held while the customer pays (DynamoDB)', 'Seat hold released (DynamoDB)'])
    titles.length = 0
    await inAws('rediss://example', () => redis.holdSlotForPayment('biz', START, 'staff-ben', 'sam'))
    expect(titles).toEqual(['Seat held while the customer pays (DynamoDB, Redis unreachable)'])
  } finally { spy.mockRestore() }
})
