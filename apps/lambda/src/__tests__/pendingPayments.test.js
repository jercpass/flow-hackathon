'use strict'

// A checkout is filed under PayPal's order id, the id PayPal sends back when the
// buyer returns. Flow's own checkout reference must never replace that key
// (it once did, and every PayPal return then said "Link expired").

jest.mock('../services/dynamo/client', () => {
  const sent = []
  class Cmd { constructor(input) { this.input = input } }
  return {
    __sent: sent,
    db: { send: jest.fn(async cmd => { sent.push(cmd.input); return { Item: sent.find(i => i.Item)?.Item } }) },
    TABLES: { PENDING_PAYMENTS: 'pending' },
    PutCommand: Cmd, GetCommand: Cmd, DeleteCommand: Cmd
  }
})

const client = require('../services/dynamo/client')
const { savePendingPayment } = require('../services/dynamo/pendingPayments')

test('the PayPal order id stays the key; the internal reference is kept as checkoutRef', async () => {
  await savePendingPayment('ORDER123', { provider: 'paypal', referenceId: 'flow_abc', businessId: 'b1', amountDue: 40 })
  const item = client.__sent[0].Item
  expect(item.referenceId).toBe('ORDER123')
  expect(item.checkoutRef).toBe('flow_abc')
  expect(item).toMatchObject({ provider: 'paypal', businessId: 'b1', amountDue: 40 })
  expect(item.ttl).toBeGreaterThan(Date.now() / 1000)
})
