'use strict'

// Log in with PayPal for the demo customer: the
// return only counts for the session that started it, once, and renames the
// customer everywhere the demo shows them.

jest.mock('axios')
jest.mock('../services/dynamo/processedMessages', () => ({ saveResult: jest.fn(), getResult: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ updateCustomer: jest.fn(), getCustomer: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn(), updateAppointment: jest.fn().mockResolvedValue() }))
// No business here, so login doesn't go on to saving PayPal (that's loginSavesPaypal.test.js).
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn().mockResolvedValue(null) }))

const axios = require('axios')
const { saveResult, getResult } = require('../services/dynamo/processedMessages')
const { updateCustomer } = require('../services/dynamo/customers')
const { getAppointmentsForBusiness, updateAppointment } = require('../services/dynamo/appointments')
const { memory, setStore } = require('../services/demoStore')
const paypal = require('../services/payments/paypal')
const login = require('../core/paypalLogin')

const session = { sid: 's1', status: 'active', customerId: 'demo-s1-c', customerName: 'John Doe', businessId: 'b1', businessIds: ['b1', 'b2'] }
let store

beforeEach(async () => {
  jest.resetAllMocks()
  process.env.API_URL = 'http://localhost:4000'
  process.env.PAYPAL_CLIENT_ID = 'cid'
  process.env.PAYPAL_CLIENT_SECRET = 'sec'
  process.env.PAYPAL_ENV = 'sandbox'
  store = memory()
  setStore(store)
  await store.putSession({ ...session })
  getAppointmentsForBusiness.mockResolvedValue([])
  updateAppointment.mockResolvedValue()
})

test('start: PayPal sandbox login page with our return URL and a state tied to this session', async () => {
  const { url } = await login.start(session)
  const u = new URL(url)
  expect(u.origin + u.pathname).toBe('https://www.sandbox.paypal.com/connect')
  expect(u.searchParams.get('client_id')).toBe('cid')
  expect(u.searchParams.get('scope')).toBe('openid profile email')
  expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:4000/pay/paypal/login/return')
  const state = u.searchParams.get('state')
  expect(state).toMatch(/^[a-f0-9]{32}$/)
  expect(saveResult).toHaveBeenCalledWith(`pplogin:${state}`, { sid: 's1' }, 900)
})

test('unknown, malformed or already used states change nothing', async () => {
  expect(await login.finish({ code: 'C', state: 'not-a-state' })).toEqual({ status: 'not_found' })
  getResult.mockResolvedValue(null)
  expect(await login.finish({ code: 'C', state: 'a'.repeat(32) })).toEqual({ status: 'not_found' })
  getResult.mockResolvedValue({ sid: 's1', used: true })
  expect(await login.finish({ code: 'C', state: 'a'.repeat(32) })).toEqual({ status: 'not_found' })
  expect(axios.post).not.toHaveBeenCalled()
  expect(updateCustomer).not.toHaveBeenCalled()
})

test('logged in: the customer takes the PayPal name in the session, on the record and on its bookings', async () => {
  getResult.mockResolvedValue({ sid: 's1' })
  axios.post.mockResolvedValue({ data: { access_token: 'user-token' } })
  axios.get.mockResolvedValue({ data: { name: 'Priya Shah', payer_id: 'PAYER1', emails: [{ value: 'priya@example.com', primary: true }] } })
  getAppointmentsForBusiness.mockImplementation(async bid => bid === 'b1'
    ? [{ appointmentId: 'h1', startTime: '2026-10-01T15:00:00.000Z', customerId: 'demo-s1-c', customerName: 'John Doe' }, { appointmentId: 'x', startTime: '2026-10-01T16:00:00.000Z', customerId: 'someone-else', customerName: 'Ana' }]
    : [])

  const r = await login.finish({ code: 'CODE1', state: 'b'.repeat(32) })
  expect(r).toEqual({ status: 'ok', name: 'Priya Shah', next: null })

  // the code exchange is the authorization_code grant with Flow's app credentials
  expect(axios.post.mock.calls[0][1]).toBe('grant_type=authorization_code&code=CODE1')
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe('Bearer user-token')
  expect(saveResult).toHaveBeenCalledWith(`pplogin:${'b'.repeat(32)}`, { sid: 's1', used: true }, 900)

  expect(await store.getSession('s1')).toMatchObject({ customerName: 'Priya Shah', paypalLogin: { name: 'Priya Shah', email: 'p***@example.com' } })
  expect(updateCustomer).toHaveBeenCalledWith('demo-s1-c', { name: 'Priya Shah', paypalLogin: { name: 'Priya Shah', email: 'priya@example.com', payerId: 'PAYER1', at: expect.any(String) } })
  expect(updateAppointment).toHaveBeenCalledTimes(1)
  expect(updateAppointment).toHaveBeenCalledWith('b1', '2026-10-01T15:00:00.000Z', 'h1', { customerName: 'Priya Shah' })
})

test('PayPal shares no name: nothing renamed', async () => {
  getResult.mockResolvedValue({ sid: 's1' })
  axios.post.mockResolvedValue({ data: { access_token: 't' } })
  axios.get.mockResolvedValue({ data: { payer_id: 'P' } })
  expect(await login.finish({ code: 'C', state: 'c'.repeat(32) })).toEqual({ status: 'no_name' })
  expect(updateCustomer).not.toHaveBeenCalled()
})

test('a separate login app (PAYPAL_LOGIN_CLIENT_ID / _SECRET) is used for login only', async () => {
  process.env.PAYPAL_LOGIN_CLIENT_ID = 'login-cid'
  process.env.PAYPAL_LOGIN_CLIENT_SECRET = 'login-sec'
  try {
    const { url } = await login.start(session)
    expect(new URL(url).searchParams.get('client_id')).toBe('login-cid')
    axios.post.mockResolvedValue({ data: { access_token: 't' } })
    axios.get.mockResolvedValue({ data: { name: 'Priya Shah' } })
    await paypal.loginUser('C')
    expect(axios.post.mock.calls[0][2].auth).toEqual({ username: 'login-cid', password: 'login-sec' })
  } finally {
    delete process.env.PAYPAL_LOGIN_CLIENT_ID
    delete process.env.PAYPAL_LOGIN_CLIENT_SECRET
  }
  // Without it, the main app.
  expect(new URL((await login.start(session)).url).searchParams.get('client_id')).toBe('cid')
})

test('userinfo in the openid shape (given and family name) also works', async () => {
  axios.post.mockResolvedValue({ data: { access_token: 't' } })
  axios.get.mockResolvedValue({ data: { given_name: 'John', family_name: 'Doe', email: 'sb-buyer@personal.example.com' } })
  expect(await paypal.loginUser('C')).toEqual({ name: 'John Doe', email: 'sb-buyer@personal.example.com', payerId: null })
})
