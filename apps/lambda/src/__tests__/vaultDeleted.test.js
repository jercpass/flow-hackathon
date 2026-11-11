'use strict'

// VAULT.PAYMENT-TOKEN.DELETED: the customer removed Flow in PayPal. Flow forgets
// the saved PayPal and stops the AI mandate; an old or unknown token changes nothing.

const customers = {}
const results = {}
jest.mock('../services/dynamo/customers', () => ({
  getCustomer: jest.fn(async id => customers[id] ? { ...customers[id] } : null),
  updateCustomer: jest.fn(async (id, u) => { customers[id] = { ...customers[id], ...u } })
}))
jest.mock('../services/dynamo/processedMessages', () => ({
  saveResult: jest.fn(async (k, v) => { results[k] = v }),
  getResult: jest.fn(async k => results[k] || null)
}))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn(async () => ({})) }))
jest.mock('../services/payments/paypal', () => ({ deleteSaved: jest.fn(async () => ({})) }))

const saved = require('../core/savedPaypal')
const notify = require('../services/notify')

beforeEach(() => {
  jest.clearAllMocks()
  for (const k of Object.keys(customers)) delete customers[k]
  for (const k of Object.keys(results)) delete results[k]
  customers.C1 = { customerId: 'C1', name: 'John', aiAllowance: { on: true, perBooking: 50, perMonth: 200 } }
})

test('removing Flow in PayPal forgets the saved PayPal and stops the AI mandate, and the customer is told', async () => {
  await saved.remember('C1', { vaultId: 'V1', email: 'john@example.com' })
  expect(await saved.onTokenDeleted('V1')).toEqual({ forgotten: true })
  expect(customers.C1.savedPaypal).toBeNull()
  expect(customers.C1.aiAllowance).toMatchObject({ on: false, endedBy: 'paypal' })
  expect(notify.notifyCustomer).toHaveBeenCalledWith(expect.objectContaining({ kind: 'saved_paypal_removed' }))
})

test('a token that is no longer the saved one (Flow swapped or removed it) changes nothing', async () => {
  await saved.remember('C1', { vaultId: 'V1', email: 'john@example.com' })
  await saved.remember('C1', { vaultId: 'V2', email: 'john@example.com' })
  expect(await saved.onTokenDeleted('V1')).toEqual({ forgotten: false })
  expect(customers.C1.savedPaypal.vaultId).toBe('V2')
  expect(await saved.onTokenDeleted('UNKNOWN')).toEqual({ forgotten: false })
  expect(notify.notifyCustomer).not.toHaveBeenCalled()
})
