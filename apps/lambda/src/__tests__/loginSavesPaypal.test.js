'use strict'

// Log in with PayPal goes straight on to saving PayPal:
// login alone can't authorise payments, so PayPal asks once to save the account,
// and the first booking already pays in one click.

jest.mock('../services/dynamo/processedMessages', () => ({ saveResult: jest.fn(), getResult: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ updateCustomer: jest.fn(), getCustomer: jest.fn() }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ getAppointmentsForBusiness: jest.fn().mockResolvedValue([]), updateAppointment: jest.fn() }))
jest.mock('../services/payments/paypal', () => ({ loginUser: jest.fn() }))
jest.mock('../core/savedPaypal', () => ({ canSave: jest.fn(), usable: jest.fn(), startChange: jest.fn(), finishChange: jest.fn(), returnToFor: jest.fn(), masked: e => e }))

const { getResult } = require('../services/dynamo/processedMessages')
const { getCustomer } = require('../services/dynamo/customers')
const { getBusiness } = require('../services/dynamo/businesses')
const paypal = require('../services/payments/paypal')
const savedPaypal = require('../core/savedPaypal')
const { memory, setStore } = require('../services/demoStore')
const login = require('../core/paypalLogin')

const STATE = 'a'.repeat(32)
const session = { sid: 's1', status: 'active', customerId: 'demo-s1-c', customerName: 'John Doe', businessId: 'b1', businessIds: ['b1'] }

beforeEach(async () => {
  jest.clearAllMocks()
  const store = memory(); setStore(store); await store.putSession({ ...session })
  getResult.mockResolvedValue({ sid: 's1' })
  paypal.loginUser.mockResolvedValue({ name: 'Pratik T', email: 'pratik@example.com', payerId: 'P1' })
  getBusiness.mockResolvedValue({ businessId: 'b1' })
  getCustomer.mockResolvedValue({ customerId: 'demo-s1-c' })
  savedPaypal.canSave.mockReturnValue(true)
  savedPaypal.usable.mockReturnValue(null)
  savedPaypal.startChange.mockResolvedValue({ approveUrl: 'https://www.sandbox.paypal.com/agreements/approve?token=SETUP1' })
})

test('logged in and nothing saved yet: the next stop is PayPal\'s save page, coming back to the chat', async () => {
  const r = await login.finish({ code: 'c', state: STATE })
  expect(r).toEqual({ status: 'ok', name: 'Pratik T', next: 'https://www.sandbox.paypal.com/agreements/approve?token=SETUP1' })
  expect(savedPaypal.startChange).toHaveBeenCalledWith({ customer: { customerId: 'demo-s1-c' }, returnTo: 'login' })
})

test('PayPal already saved, or it can\'t be: no extra stop', async () => {
  savedPaypal.usable.mockReturnValue({ vaultId: 'V1' })
  expect((await login.finish({ code: 'c', state: STATE })).next).toBeNull()
  getResult.mockResolvedValue({ sid: 's1' })
  savedPaypal.usable.mockReturnValue(null); savedPaypal.canSave.mockReturnValue(false)
  expect((await login.finish({ code: 'c', state: STATE })).next).toBeNull()
})

test('logged in with another PayPal than the saved one: PayPal asks to save the new one', async () => {
  savedPaypal.usable.mockReturnValue({ vaultId: 'V1', email: 'someone.else@example.com' })
  expect((await login.finish({ code: 'c', state: STATE })).next).toMatch(/SETUP1$/)
  getResult.mockResolvedValue({ sid: 's1' })
  savedPaypal.usable.mockReturnValue({ vaultId: 'V1', email: 'Pratik@Example.com' })   // same account, any case
  expect((await login.finish({ code: 'c', state: STATE })).next).toBeNull()
})

test('if starting the save fails, the login still counts', async () => {
  savedPaypal.startChange.mockRejectedValue(new Error('PayPal down'))
  expect(await login.finish({ code: 'c', state: STATE })).toEqual({ status: 'ok', name: 'Pratik T', next: null })
})

describe('the return pages', () => {
  const handlers = require('../handlers/paypal')
  beforeEach(() => { process.env.WEB_CHAT_URL = 'https://flow.example/demo/client' })

  test('login return sends a fresh login on to the save page', async () => {
    const r = await handlers.loginReturn({ queryStringParameters: { code: 'c', state: STATE } })
    expect(r).toMatchObject({ statusCode: 302, headers: { Location: 'https://www.sandbox.paypal.com/agreements/approve?token=SETUP1' } })
  })

  test('back from the save page: the chat, logged in, saying whether PayPal was saved', async () => {
    savedPaypal.finishChange.mockResolvedValue({ status: 'saved', returnTo: 'login' })
    const r = await handlers.vaultReturn({ queryStringParameters: { token: 'SETUP12345' } })
    expect(r).toMatchObject({ statusCode: 302, headers: { Location: 'https://flow.example/demo/client?login=ok&saved=saved' } })
    savedPaypal.returnToFor.mockResolvedValue('login')
    const c = await handlers.vaultCancel({ queryStringParameters: { token: 'SETUP12345' } })
    expect(c.headers.Location).toBe('https://flow.example/demo/client?login=ok&saved=cancelled')
  })
})
