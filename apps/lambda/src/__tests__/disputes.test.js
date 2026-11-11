'use strict'

// Disputes answered from the booking timeline:
// a PayPal case is linked to its booking through the capture, the AI drafts from
// the booking's facts only, nothing goes to PayPal without the owner's confirm,
// the response carries the booking record as a PDF, and practice cases never
// reach PayPal.

const refs = {}
jest.mock('../services/dynamo/processedMessages', () => ({ getResult: jest.fn(async k => refs[k] || null), saveResult: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ updateAppointment: jest.fn(async () => ({})) }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn() }))
jest.mock('../services/notify', () => ({ notifyOwner: jest.fn(async () => ({})) }))
jest.mock('../services/payments/paypal', () => ({
  getDispute: jest.fn(), listDisputes: jest.fn(async () => []),
  provideDisputeEvidence: jest.fn(async () => ({ sent: true })), acceptDisputeClaim: jest.fn(async () => ({ accepted: true })), sandboxDispute: jest.fn(async () => ({ done: true }))
}))
jest.mock('../services/ai', () => ({ generate: jest.fn() }))
jest.mock('../core/ownerOps', () => ({ findBooking: jest.fn() }))

const { setStore, memory } = require('../services/demoStore')
const paypal = require('../services/payments/paypal')
const ai = require('../services/ai')
const { updateAppointment } = require('../services/dynamo/appointments')
const { getBusiness } = require('../services/dynamo/businesses')
const notify = require('../services/notify')
const { findBooking } = require('../core/ownerOps')
const disputes = require('../core/disputes')
const { CATALOG } = require('../demo/templates')

const business = { ...CATALOG[0].build(), businessId: 'B1' }
const visit = {
  appointmentId: 'appt-1234567890', businessId: 'B1', startTime: '2026-10-20T16:00:00.000Z', endTime: '2026-10-20T17:00:00.000Z',
  serviceName: 'Haircut', customerName: 'John Doe', createdVia: 'mcp', createdAt: '2026-10-18T15:00:00.000Z', status: 'completed',
  amountPaid: 40, currency: 'USD', paymentId: 'CAP1', paidUnder: 'allowance', paymentMandateId: 'pm_abc', mandateId: 'om_xyz', customerNotes: 'Short on the sides'
}
const ppCase = { disputeId: 'PP-D-1', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', amount: 40, currency: 'USD', captureId: 'CAP1', dueAt: '2026-11-10T00:00:00.000Z', createdAt: '2026-10-30T00:00:00.000Z', buyerMessage: 'I never got my haircut.' }

beforeEach(() => {
  jest.clearAllMocks()
  setStore(memory())
  for (const k of Object.keys(refs)) delete refs[k]
  refs['cap:CAP1'] = { businessId: 'B1', startTime: visit.startTime, appointmentId: visit.appointmentId, amountPaid: 40 }
  getBusiness.mockResolvedValue(business)
  findBooking.mockResolvedValue(visit)
  paypal.getDispute.mockResolvedValue(ppCase)
  ai.generate.mockResolvedValue({ text: 'John Doe booked and paid for a haircut on October 20, and the visit was completed. We ask PayPal to decide for the business.', model: 'claude-haiku-5-5' })
})

test('a PayPal case is linked to its booking through the capture; the booking is flagged and the owner told', async () => {
  await disputes.onWebhook('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'PP-D-1' })
  const [d] = await disputes.list(business, { fresh: false })
  expect(d).toMatchObject({ disputeId: 'PP-D-1', open: true, bookingId: visit.appointmentId, money: '$40', practice: false })
  expect(updateAppointment).toHaveBeenCalledWith('B1', visit.startTime, visit.appointmentId, { dispute: expect.objectContaining({ id: 'PP-D-1', dueAt: ppCase.dueAt, practice: false }) })
  expect(notify.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dispute' }))
})

test('a case on a payment Flow never took is left alone', async () => {
  paypal.getDispute.mockResolvedValue({ ...ppCase, captureId: 'SOMEONE_ELSES' })
  await disputes.onWebhook('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'PP-D-1' })
  expect(await disputes.list(business, { fresh: false })).toEqual([])
  expect(notify.notifyOwner).not.toHaveBeenCalled()
})

test('the draft is written from the booking facts only, picks the evidence type, and sends nothing', async () => {
  await disputes.onWebhook('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'PP-D-1' })
  const { dispute } = await disputes.draft(business, 'PP-D-1')
  expect(dispute.draft).toMatchObject({ evidenceType: 'PROOF_OF_FULFILLMENT', by: expect.stringMatching(/Haiku/) })
  const facts = dispute.draft.facts.join('\n')
  expect(facts).toMatch(/their own AI assistant \(MCP\)/)
  expect(facts).toMatch(/spending mandate the customer signed/)
  expect(facts).toMatch(/Cancellation policy shown before paying/)
  expect(facts).toMatch(/marked completed/)
  const prompt = ai.generate.mock.calls[0][0]
  expect(prompt.system).toMatch(/Use ONLY the facts listed/)
  expect(prompt.parts[0].text).toMatch(/I never got my haircut/)
  expect(paypal.provideDisputeEvidence).not.toHaveBeenCalled()
})

test('sending asks first, then sends the response with the booking record as a PDF', async () => {
  await disputes.onWebhook('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'PP-D-1' })
  await disputes.draft(business, 'PP-D-1')
  expect(await disputes.send(business, 'PP-D-1')).toMatchObject({ needs_confirmation: true })
  expect(paypal.provideDisputeEvidence).not.toHaveBeenCalled()
  expect(await disputes.send(business, 'PP-D-1', { confirm: true })).toMatchObject({ sent: true, practice: false })
  const call = paypal.provideDisputeEvidence.mock.calls[0][0]
  expect(call).toMatchObject({ disputeId: 'PP-D-1', evidenceType: 'PROOF_OF_FULFILLMENT', notes: expect.stringMatching(/visit was completed/) })
  expect(call.pdf.subarray(0, 4).toString()).toBe('%PDF')
})

test('without the AI, the draft is the facts themselves', async () => {
  ai.generate.mockRejectedValue(new Error('down'))
  await disputes.onWebhook('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'PP-D-1' })
  const { dispute } = await disputes.draft(business, 'PP-D-1')
  expect(dispute.draft.by).toBe('template')
  expect(dispute.draft.note).toMatch(/Paid \$40 with PayPal/)
})

test('a practice case is labelled and never reaches PayPal', async () => {
  const { dispute } = await disputes.practice(business, visit.appointmentId)
  expect(dispute).toMatchObject({ practice: true, open: true, disputeId: expect.stringMatching(/^PRACTICE-/) })
  await disputes.draft(business, dispute.disputeId)
  expect(await disputes.send(business, dispute.disputeId, { confirm: true })).toMatchObject({ sent: true, practice: true })
  await disputes.sandbox(business, dispute.disputeId, 'seller_wins')
  const [after] = await disputes.list(business, { fresh: false })
  expect(after).toMatchObject({ open: false, outcome: 'RESOLVED_SELLER_FAVOUR' })
  expect(paypal.provideDisputeEvidence).not.toHaveBeenCalled()
  expect(paypal.sandboxDispute).not.toHaveBeenCalled()
  findBooking.mockResolvedValue({ ...visit, amountPaid: 0 })
  expect(await disputes.practice(business, visit.appointmentId)).toMatchObject({ error: expect.stringMatching(/paid booking/) })
})

test('accepting asks first, then accepts at PayPal', async () => {
  await disputes.onWebhook('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'PP-D-1' })
  expect(await disputes.accept(business, 'PP-D-1')).toMatchObject({ needs_confirmation: true })
  expect(paypal.acceptDisputeClaim).not.toHaveBeenCalled()
  expect(await disputes.accept(business, 'PP-D-1', { confirm: true })).toMatchObject({ accepted: true })
  expect(paypal.acceptDisputeClaim).toHaveBeenCalledWith({ disputeId: 'PP-D-1', note: undefined })
})
