'use strict'

// Back from PayPal: web-chat buyers are sent to the dashboard's customer page
// (WEB_CHAT_URL, else <DASHBOARD_URL>/demo/client); anyone else gets the hosted page.

jest.mock('../core/paymentConfirm', () => ({ finalizeOrder: jest.fn(), cancelCheckout: jest.fn(), resultKey: jest.fn(), releaseHeldSeat: jest.fn() }))
jest.mock('../services/dynamo/pendingPayments', () => ({ getPendingPayment: jest.fn(), consumePendingPayment: jest.fn() }))
jest.mock('../services/dynamo/processedMessages', () => ({ hasProcessed: jest.fn(), markProcessed: jest.fn(), saveResult: jest.fn(), getResult: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ updateAppointment: jest.fn() }))

const { finalizeOrder } = require('../core/paymentConfirm')
const { returnPage } = require('../handlers/paypal')

const back = () => returnPage({ queryStringParameters: { token: 'ORDER12345' } })

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.WEB_CHAT_URL
  delete process.env.DASHBOARD_URL
})

test('web chat: back to the dashboard\'s customer page with the outcome', async () => {
  process.env.DASHBOARD_URL = 'https://flowhq.vercel.app/'
  finalizeOrder.mockResolvedValue({ status: 'confirmed', channel: 'web' })
  const r = await back()
  expect(r).toMatchObject({ statusCode: 302, headers: { Location: 'https://flowhq.vercel.app/demo/client?order=ORDER12345&status=confirmed' } })
})

test('WEB_CHAT_URL, when set, wins', async () => {
  process.env.DASHBOARD_URL = 'https://flowhq.vercel.app'
  process.env.WEB_CHAT_URL = 'http://localhost:3000/demo/client'
  finalizeOrder.mockResolvedValue({ status: 'confirmed', channel: 'web' })
  expect((await back()).headers.Location).toMatch(/^http:\/\/localhost:3000\/demo\/client\?order=ORDER12345/)
})

test('no dashboard address, or not web chat: the hosted result page', async () => {
  finalizeOrder.mockResolvedValue({ status: 'confirmed', channel: 'web' })
  expect((await back()).statusCode).toBe(200)
  process.env.DASHBOARD_URL = 'https://flowhq.vercel.app'
  finalizeOrder.mockResolvedValue({ status: 'confirmed', channel: 'speaker' })
  expect((await back()).statusCode).toBe(200)
})
