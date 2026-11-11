'use strict'

// The AI fails after a booking or payment already went through (a timeout after
// paying, say). The customer must hear what was done, never "try again", which
// would invite a second booking and charge.

jest.mock('../services/ai', () => ({
  chat: jest.fn(),
  models: () => ({ main: 'main-model' }),
  modelLabel: () => 'the main AI',
  aiLabel: () => 'The main AI',
  errorReason: err => err.message
}))
jest.mock('../services/tools', () => ({
  getTools: () => [],
  executeTool: jest.fn(),
  hasSideEffects: name => ['book_appointment', 'cancel_booking'].includes(name)
}))

const ai = require('../services/ai')
const { executeTool } = require('../services/tools')
const { routeMessage } = require('../services/aiRouter')

const business = { businessId: 'biz', name: 'Willow & Co.', type: 'salon', config: { services: [], policies: {} } }
const ctx = { systemPrompt: 'You book things.', channel: 'web' }
const PAID = { booked: true, paidWithSaved: true, amount: 18, message: 'Booked and paid: $18 with your saved PayPal (j***@example.com). Beard Trim on Mon, Oct 26, 5:00 PM.' }

// The AI runs the given tools, then fails.
function aiRunsThenFails(calls, err = new Error('timed out')) {
  ai.chat.mockImplementation(async ({ runTool }) => {
    for (const [name, result] of calls) { executeTool.mockResolvedValueOnce(result); await runTool(name, {}) }
    throw err
  })
}

beforeEach(() => jest.clearAllMocks())

test('paid, then the AI times out: the reply says booked and paid, not "try again"', async () => {
  aiRunsThenFails([['check_availability', { available: true }], ['book_appointment', PAID]])
  const r = await routeMessage(business, [], 'book it', [], ctx)
  expect(r.reply).toMatch(/^Booked and paid: \$18 with your saved PayPal/)
  expect(r.reply).toMatch(/no need to ask again/)
  expect(r.reply).not.toMatch(/try again/i)
  // The chat still gets the step, so it shows the paid card and refreshes bookings.
  expect(r.toolEvents).toEqual([expect.objectContaining({ name: 'book_appointment', result: PAID })])
})

test('a PayPal link was made, then the AI fails: the link still reaches the customer', async () => {
  const link = { booked: false, paymentRequired: true, paymentUrl: 'https://paypal.test/pay', message: 'To confirm your Haircut booking, please pay $40 with the PayPal button below.' }
  aiRunsThenFails([['book_appointment', link]])
  const r = await routeMessage(business, [], 'book it', [], ctx)
  expect(r.reply).toMatch(/PayPal button below/)
  expect(r.toolEvents[0].result.paymentUrl).toBe('https://paypal.test/pay')
})

test('only a quote or an error before failing: the usual apology, nothing claimed', async () => {
  aiRunsThenFails([
    ['book_appointment', { booked: false, needsConfirm: true, message: 'Pay $40 now with your saved PayPal?' }],
    ['cancel_booking', { cancelled: false, message: 'Not cancelled.' }],
    ['book_appointment', { error: 'That time was just taken.' }]
  ])
  const r = await routeMessage(business, [], 'book it', [], ctx)
  expect(r.reply).toBe('Sorry, I had a technical issue. Please try again in a moment.')
  expect(r.toolEvents).toEqual([])
})

test('the AI ran out of tool rounds after paying: same honest reply', async () => {
  ai.chat.mockImplementation(async ({ runTool }) => {
    executeTool.mockResolvedValueOnce(PAID)
    await runTool('book_appointment', {})
    return { reply: 'I had trouble processing that. Could you try again?', toolEvents: [{ name: 'book_appointment', result: PAID }], usedTools: true, gaveUp: true, model: 'main-model' }
  })
  const r = await routeMessage(business, [], 'book it', [], ctx)
  expect(r.reply).toMatch(/^Booked and paid: \$18/)
  expect(r.reply).not.toMatch(/try again/i)
})
