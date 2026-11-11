'use strict'

// Reference photos on the booking: a photo a
// customer sends is kept for their session only, opens through a signed link
// while the session runs, can be attached to a booking (notes keep the
// description too), and is deleted when the session ends.

process.env.FLOW_LINK_SECRET = 'test-secret'   // signs the photo links (utils/jwt reads it on load)

jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), createAppointment: jest.fn(), updateAppointment: jest.fn() }))
jest.mock('../services/notify', () => ({ notifyOwner: jest.fn().mockResolvedValue(true), notifyCustomer: jest.fn() }))

const { setStore, memory, store } = require('../services/demoStore')
const { createToken } = require('../utils/jwt')
const photos = require('../services/photos')
const { getAppointmentsForBusiness, updateAppointment } = require('../services/dynamo/appointments')
const { executeTool } = require('../services/tools')
const { CATALOG, PERSONA } = require('../demo/templates')

const session = sid => ({ sid, status: 'active', expiresAt: Date.now() + 3600_000 })
const fQuery = url => ({ f: decodeURIComponent(url.split('f=')[1]) })

beforeEach(async () => {
  jest.clearAllMocks()
  setStore(memory())
  delete process.env.AWS_LAMBDA_FUNCTION_NAME
  process.env.API_URL = 'https://api.example.com/dev'
  await store().putSession(session('S1'))
  await store().putSession(session('S2'))
})

test('a photo is kept for its session and opens through a signed link while the session runs', async () => {
  const id = await photos.save(await store().getSession('S1'), { buffer: Buffer.from('jpeg-bytes'), mimeType: 'image/jpeg' })
  expect(id).toMatch(/^ph_[\w-]{10,}$/)
  expect((await store().getSession('S1')).photos).toEqual([id])
  const url = photos.link(id)
  expect(url.startsWith('https://api.example.com/dev/demo/photo?f=')).toBe(true)
  const res = await photos.serve(fQuery(url))
  expect(res).toMatchObject({ statusCode: 200, isBase64Encoded: true, headers: { 'Content-Type': 'image/jpeg' } })
  expect(Buffer.from(res.body, 'base64').toString()).toBe('jpeg-bytes')
})

test('only the same session can attach it; other ids and made-up ones are dropped', async () => {
  const mine = await photos.save(await store().getSession('S1'), { buffer: Buffer.from('a'), mimeType: 'image/png' })
  const theirs = await photos.save(await store().getSession('S2'), { buffer: Buffer.from('b'), mimeType: 'image/png' })
  expect(await photos.owned('S1', [mine, theirs, 'ph_madeup000', 'not-an-id', mine])).toEqual([mine])
})

test('links expire, are photo-only, and stop working when the session ends; ending it deletes the photos', async () => {
  const s = await store().getSession('S1')
  const id = await photos.save(s, { buffer: Buffer.from('a'), mimeType: 'image/jpeg' })
  expect((await photos.serve({ f: createToken({ typ: 'photo', id }, -10) })).statusCode).toBe(403)
  expect((await photos.serve({ f: createToken({ typ: 'inboxfile', id }, 60) })).statusCode).toBe(403)
  await store().updateSession('S1', { status: 'ended' })
  expect((await photos.serve(fQuery(photos.link(id)))).statusCode).toBe(410)
  await photos.forget(await store().getSession('S1'))
  expect(await store().getKey(`PHOTO#${id}`, 'P')).toBeNull()
})

test('at most 10 a session, and nothing over 4 MB', async () => {
  const s = await store().getSession('S1')
  for (let i = 0; i < photos.MAX_PER_SESSION; i++) expect(await photos.save(s, { buffer: Buffer.from(`p${i}`), mimeType: 'image/jpeg' })).toBeTruthy()
  expect(await photos.save(s, { buffer: Buffer.from('one more'), mimeType: 'image/jpeg' })).toBeNull()
  expect(await photos.save(await store().getSession('S2'), { buffer: Buffer.alloc(4_000_001), mimeType: 'image/jpeg' })).toBeNull()
})

test('add_booking_note puts the photo on an existing booking, and the AI is told it did', async () => {
  const id = await photos.save(await store().getSession('S1'), { buffer: Buffer.from('a'), mimeType: 'image/jpeg' })
  const catalog = CATALOG.map((c, i) => ({ ...c.build(), businessId: i === 0 ? 'demo-S1' : `demo-S1-${c.slug}` }))
  const start = new Date(Date.now() + 3 * 86_400_000).toISOString()
  getAppointmentsForBusiness.mockImplementation(async bid => (bid === 'demo-S1' ? [{ appointmentId: 'a1', customerId: 'sam', serviceName: 'Haircut', status: 'confirmed', startTime: start }] : []))
  const ctx = { catalog, customer: { customerId: 'sam', name: 'Sam Rivera' }, customerLocation: { ...PERSONA.home }, business: catalog[0], channel: 'telegram', demoSid: 'S1' }
  const r = await executeTool('add_booking_note', { note: 'From a reference photo: skin fade, full beard', photo_ids: [id] }, ctx)
  expect(updateAppointment).toHaveBeenCalledWith('demo-S1', start, 'a1', { customerNotes: 'From a reference photo: skin fade, full beard', customerPhotos: [id] })
  expect(r).toMatchObject({ saved: true, photosAttached: 1 })
  expect(r.message).toMatch(/The reference photo is on the booking, for the business to see/)
})
