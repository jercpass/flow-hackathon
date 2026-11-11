'use strict'

const trace = require('../services/trace')

let sink
beforeEach(() => { sink = trace.memorySink(); trace.setSink(sink) })
afterAll(() => trace.setSink(null))

test('no scope → events are dropped and spans just run', async () => {
  trace.event('ai', 'ignored')
  expect(await trace.span('paypal', 'x', async () => 42)).toBe(42)
  expect(sink.events).toHaveLength(0)
})

test('events inside a scope are written in order and flushed before run() returns', async () => {
  await trace.run('sess:abc', async () => {
    trace.event('ai', 'Asked Gemini 3.5 Flash', { provider: 'gemini' })
    await trace.span('paypal', 'PayPal: order created', async () => ({ id: 'ORDER1' }), r => ({ order: r.id }), )
    trace.event('db', 'Booking written')
  })
  expect(sink.events.map(e => e.title)).toEqual(['Asked Gemini 3.5 Flash', 'PayPal: order created', 'Booking written'])
  expect(sink.events.every(e => e.scope === 'sess:abc')).toBe(true)
  expect(sink.events[1]).toMatchObject({ layer: 'paypal', detail: { order: 'ORDER1' } })
  expect(typeof sink.events[1].ms).toBe('number')
})

test('scope follows async calls without being passed around', async () => {
  const deep = async () => { await new Promise(r => setTimeout(r, 1)); trace.event('redis', 'Seat held') }
  await trace.run('sess:deep', async () => { await deep() })
  expect(sink.events[0]).toMatchObject({ scope: 'sess:deep', title: 'Seat held' })
})

test('re-entering the same scope reuses it; a different scope nests', async () => {
  await trace.run('sess:a', async () => {
    trace.event('ai', 'one')
    await trace.run('sess:a', async () => trace.event('ai', 'two'))
    await trace.run('sess:b', async () => trace.event('ai', 'other'))
    expect(trace.currentScope()).toBe('sess:a')
  })
  expect(sink.events.map(e => `${e.scope}:${e.seq}:${e.title}`)).toEqual(['sess:a:1:one', 'sess:a:2:two', 'sess:b:1:other'])
})

test('failed spans are recorded and the error still propagates', async () => {
  await expect(trace.run('sess:f', () => trace.span('paypal', 'PayPal: payment captured', async () => {
    throw Object.assign(new Error('nope'), { code: 'INSTRUMENT_DECLINED' })
  }))).rejects.toThrow('nope')
  expect(sink.events[0]).toMatchObject({ title: 'PayPal: payment captured — failed', detail: { error: 'INSTRUMENT_DECLINED' } })
})

test('redaction drops secrets, masks emails, and shortens ids', () => {
  const r = trace.redact({ accessToken: 'abc', password: 'x', to: 'sam.rivera@example.com', nested: { apiKey: 'k', ok: 1 } })
  expect(r).toEqual({ to: 's•••@example.com', nested: { ok: 1 } })
  expect(trace.short('5O190127TN364715T')).toBe('5O1901…715T')
  expect(trace.short('CAP1')).toBe('CAP1')
})

test('read returns events after a cursor (cheap polling)', async () => {
  await trace.run('sess:r', async () => { trace.event('ai', 'a'); trace.event('ai', 'b'); trace.event('ai', 'c') })
  const all = await trace.read('sess:r')
  expect(all.map(e => e.title)).toEqual(['a', 'b', 'c'])
  const newer = await trace.read('sess:r', all[0].sk)
  expect(newer.map(e => e.title)).toEqual(['b', 'c'])
  expect(all[0].scope).toBeUndefined()
})

test('a sink failure never breaks the request', async () => {
  trace.setSink({ write: async () => { throw new Error('dynamo down') }, read: async () => [] })
  await expect(trace.run('sess:x', async () => { trace.event('ai', 'still fine'); return 'ok' })).resolves.toBe('ok')
})

test('steps inside forBusiness carry that business (the owner side shows one business at a time), in order', async () => {
  await trace.run('sess:biz', async () => {
    trace.event('ai', 'Asked the main AI')
    await trace.forBusiness({ businessId: 'demo-x-eastside', name: 'Eastside Barber Co.' }, async () => {
      trace.event('tool', 'Tool: book_appointment')
      await trace.span('paypal', 'PayPal: order created', async () => 1)
    })
    trace.event('ai', 'The main AI replied')
  })
  expect(sink.events.map(e => [e.title, e.biz || null])).toEqual([
    ['Asked the main AI', null],
    ['Tool: book_appointment', 'demo-x-eastside'],
    ['PayPal: order created', 'demo-x-eastside'],
    ['The main AI replied', null]
  ])
  expect(sink.events[1].bizName).toBe('Eastside Barber Co.')
  // One sequence for the whole scope, business or not.
  expect(sink.events.map(e => e.seq)).toEqual([1, 2, 3, 4])
  // No scope or no business: just runs.
  expect(await trace.forBusiness({ businessId: 'b' }, async () => 7)).toBe(7)
})
