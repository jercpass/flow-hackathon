'use strict'

// A new service can be given to staff (when it's added, or later from the
// Staff page), and the owner can say who came or didn't (and undo it).

jest.mock('../services/dynamo/businesses', () => {
  const db = new Map()
  return {
    __db: db,
    getBusiness: jest.fn(async id => (db.has(id) ? JSON.parse(JSON.stringify(db.get(id))) : null)),
    updateBusiness: jest.fn(async (id, u) => { db.set(id, { ...db.get(id), ...JSON.parse(JSON.stringify(u)) }) })
  }
})
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn().mockResolvedValue([]), updateAppointment: jest.fn(), createAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ invalidateBusiness: jest.fn().mockResolvedValue() }))

process.env.FLOW_LINK_SECRET = 'test-secret'
const businesses = require('../services/dynamo/businesses')
const { updateAppointment } = require('../services/dynamo/appointments')
const { createToken } = require('../utils/jwt')
const { handler } = require('../handlers/dashboardApi')
const manage = require('../core/ownerManage')
const { CATALOG } = require('../demo/templates')

const BID = 'biz-staff'
const call = async (method, path, body) => {
  const r = await handler({ httpMethod: method, pathParameters: { proxy: path }, headers: { Authorization: `Bearer ${createToken({ businessId: BID }, 3600)}` }, body: body ? JSON.stringify(body) : null })
  return { status: r.statusCode, body: JSON.parse(r.body || '{}') }
}
const staff = () => businesses.__db.get(BID).config.staff
const doers = id => staff().filter(p => p.services.includes(id)).map(p => p.name)

beforeEach(() => {
  jest.clearAllMocks()
  businesses.__db.set(BID, { ...CATALOG[0].build(), businessId: BID })
})

test('a new staff service goes to everyone by default, or to the staff picked', async () => {
  const a = await call('POST', 'services', { name: 'Blowout', price: 45, duration: 45, unitType: 'person' })
  expect(a.status).toBe(201)
  expect(doers(a.body.service.serviceId)).toEqual(['Ana', 'Ben'])
  const b = await call('POST', 'services', { name: 'Balayage', price: 180, duration: 180, unitType: 'person', staffIds: ['staff-ana'] })
  expect(doers(b.body.service.serviceId)).toEqual(['Ana'])
  // A room-booked service isn't given to staff.
  const c = await call('POST', 'services', { name: 'Steam room', price: 20, duration: 30, unitType: 'resource' })
  expect(doers(c.body.service.serviceId)).toEqual([])
})

test('editing a service changes who does it; deleting it removes it from everyone', async () => {
  const { body } = await call('POST', 'services', { name: 'Blowout', price: 45, duration: 45, unitType: 'person', staffIds: ['staff-ana'] })
  const id = body.service.serviceId
  await call('PATCH', 'services', { serviceId: id, price: 50, staffIds: ['staff-ben'] })
  expect(doers(id)).toEqual(['Ben'])
  await call('PATCH', 'services', { serviceId: id, price: 55 })          // no staffIds: unchanged
  expect(doers(id)).toEqual(['Ben'])
  await call('DELETE', 'services', { serviceId: id })
  expect(doers(id)).toEqual([])
})

test('the Staff page can change an existing person\'s services', async () => {
  const { body } = await call('POST', 'services', { name: 'Blowout', price: 45, duration: 45, unitType: 'person', staffIds: [] })
  expect(doers(body.service.serviceId)).toEqual([])
  await call('PATCH', 'staff', { staffId: 'staff-ben', services: ['svc-haircut', body.service.serviceId] })
  expect(doers(body.service.serviceId)).toEqual(['Ben'])
})

test('attendance: came, no-show, back to not marked; nothing else', async () => {
  const b = { startTime: '2026-10-20T20:00:00.000Z', appointmentId: 'a1' }
  for (const status of ['completed', 'no_show', 'confirmed']) {
    expect((await call('PATCH', 'bookings', { ...b, status })).status).toBe(200)
  }
  expect(updateAppointment.mock.calls.map(c => c[3].status)).toEqual(['completed', 'no_show', 'confirmed'])
  expect(updateAppointment.mock.calls[0][3].attendanceMarkedAt).toBeTruthy()
  expect((await call('PATCH', 'bookings', { ...b, status: 'whatever' })).status).toBe(400)
  // Cancelling can't skip the refund rules this way.
  expect((await call('PATCH', 'bookings', { ...b, status: 'cancelled' })).body.error).toMatch(/bookings\/cancel/)
})

test('MCP: the owner can say "came" or "didn\'t come" in plain words', async () => {
  const appt = { appointmentId: 'abcdef12-x', businessId: BID, serviceName: 'Haircut', status: 'confirmed', startTime: new Date(Date.now() - 3600_000).toISOString(), unitId: 'staff-ana' }
  require('../services/dynamo/appointments').getAppointmentsForBusiness.mockResolvedValue([appt])
  const biz = businesses.__db.get(BID)
  expect(await manage.updateBookingStatus(biz, { booking_id: 'abcdef12', status: 'came' })).toMatchObject({ updated: true, status: 'completed' })
  expect(await manage.updateBookingStatus(biz, { booking_id: 'abcdef12', status: "didn't come" })).toMatchObject({ status: 'no_show' })
  expect(await manage.updateBookingStatus(biz, { booking_id: 'abcdef12', status: 'not marked' })).toMatchObject({ status: 'confirmed' })
})
