'use strict'

// PayPal invoices: every PayPal-paid booking gets
// a paid invoice in the account that got the money; balances and refunds are
// recorded on it; both inbox messages carry the receipt PDF; a PayPal refusal never
// holds up the booking; owner and customer tools. PayPal is mocked.

jest.mock('../services/dynamo', () => ({ getBusiness: jest.fn(), getCustomer: jest.fn() }))
jest.mock('../services/dynamo/customers', () => ({ getCustomer: jest.fn(), updateCustomer: jest.fn() }))
jest.mock('../services/dynamo/pendingPayments', () => ({ getPendingPayment: jest.fn(), consumePendingPayment: jest.fn() }))
jest.mock('../services/dynamo/processedMessages', () => ({ saveResult: jest.fn(), getResult: jest.fn() }))
jest.mock('../services/dynamo/appointments', () => ({ updateAppointment: jest.fn(), getAppointmentsForBusiness: jest.fn().mockResolvedValue([]), createAppointment: jest.fn() }))
jest.mock('../services/redis', () => ({ holdSlotForPayment: jest.fn().mockResolvedValue({ held: true }), releaseSlot: jest.fn().mockResolvedValue(), invalidateBusiness: jest.fn() }))
jest.mock('../services/notify', () => ({ notifyCustomer: jest.fn().mockResolvedValue(['inbox']), notifyOwner: jest.fn().mockResolvedValue(true) }))
jest.mock('../core/units', () => ({ getFreeUnitsForSlot: jest.fn().mockResolvedValue(['staff-ana']), getNextQueueToken: jest.fn(), priceForUnit: jest.fn(s => s) }))
jest.mock('../core/engine', () => ({ createBooking: jest.fn(), getService: jest.fn((biz, id) => biz.config.services.find(s => s.serviceId === id)), getAvailability: jest.fn() }))
jest.mock('../services/payments', () => {
  const provider = { id: 'paypal', capture: jest.fn(), refund: jest.fn() }
  return { getProviderById: () => provider, getPaymentProvider: () => provider, providerIdFor: () => 'paypal', __provider: provider }
})
jest.mock('../services/payments/paypal', () => ({
  createInvoice: jest.fn(), sendInvoice: jest.fn().mockResolvedValue(), recordInvoicePayment: jest.fn().mockResolvedValue({ paymentId: 'P1' }),
  recordInvoiceRefund: jest.fn().mockResolvedValue({ refundId: 'R1' }), getInvoice: jest.fn()
}))

process.env.PAYPAL_CLIENT_ID = 'id'
process.env.PAYPAL_CLIENT_SECRET = 'secret'
process.env.DEMO_STORE = 'memory'

const dynamo = require('../services/dynamo')
const customers = require('../services/dynamo/customers')
const { getPendingPayment, consumePendingPayment } = require('../services/dynamo/pendingPayments')
const { updateAppointment, getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const { createBooking } = require('../core/engine')
const { notifyCustomer, notifyOwner } = require('../services/notify')
const provider = require('../services/payments').__provider
const paypal = require('../services/payments/paypal')
const { finalizeOrder, confirmPaidBooking } = require('../core/paymentConfirm')
const invoices = require('../core/invoices')
const { refundAppointment } = require('../core/refunds')
const ownerPaypal = require('../core/ownerPaypal')
const { executeTool } = require('../services/tools')
const { CATALOG, PERSONA } = require('../demo/templates')

const BID = 'biz-inv'
const business = { ...CATALOG[0].build(), businessId: BID, paypalMerchantId: 'SALON1', paypalEmail: 'salon@example.com', ownerEmail: 'o@example.com' }
const sam = { customerId: 'sam', name: 'Sam Rivera', demoSessionId: 'sess1' }
const START = '2026-10-24T20:00:00.000Z'
const pending = { referenceId: 'ref1', provider: 'paypal', businessId: BID, serviceId: 'svc-haircut', serviceName: 'Haircut', startIso: START, customerId: 'sam', amountDue: 40, currency: 'USD', channel: 'web', payeeMerchantId: 'SALON1' }
const capture = { captureId: 'CAP1', captureStatus: 'COMPLETED', amount: 40, currency: 'USD', paidAt: '2026-10-21T10:00:00Z', payeeMerchantId: 'SALON1' }
const booked = (o = {}) => ({ appointmentId: 'appt-inv-1', businessId: BID, customerId: 'sam', customerName: 'Sam Rivera', serviceId: 'svc-haircut', serviceName: 'Haircut', unitId: 'staff-ana', startTime: START, endTime: '2026-10-24T21:00:00.000Z', status: 'confirmed', totalAmount: 40, amountPaid: 40, paymentId: 'CAP1', paymentProvider: 'paypal', payeeMerchantId: 'SALON1', currency: 'USD', ...o })
const INVOICE = { invoiceId: 'INV2-AAAA', number: '0012', status: 'DRAFT', total: 40, recipientUrl: 'https://paypal.test/invoice/p/0012', invoicerUrl: 'https://paypal.test/invoice/s/0012' }
const saved = () => Object.assign({}, ...updateAppointment.mock.calls.map(c => c[3]))

beforeEach(() => {
  jest.clearAllMocks()
  dynamo.getBusiness.mockResolvedValue(business)
  dynamo.getCustomer.mockResolvedValue(sam)
  customers.getCustomer.mockResolvedValue(sam)
  getPendingPayment.mockResolvedValue(pending)
  consumePendingPayment.mockResolvedValue(pending)
  provider.capture.mockResolvedValue(capture)
  paypal.createInvoice.mockResolvedValue(INVOICE)
  getAppointmentsForBusiness.mockResolvedValue([])
})

describe('a paid booking', () => {
  test('gets a paid invoice in the salon\'s PayPal, and both inbox messages carry the receipt PDF', async () => {
    createBooking.mockResolvedValue(booked())
    const r = await finalizeOrder('ORDER1')
    expect(r.status).toBe('confirmed')

    expect(paypal.createInvoice.mock.calls[0][0]).toMatchObject({
      merchantId: 'SALON1', invoicerEmail: 'salon@example.com', businessName: 'Willow & Co. Salon', currency: 'USD',
      customer: { name: 'Sam Rivera' }, lines: [{ name: 'Haircut', amount: 40, description: expect.stringMatching(/with Ana/) }],
      requestId: 'inv_appt-inv-1'
    })
    expect(paypal.sendInvoice.mock.calls[0][0]).toMatchObject({ merchantId: 'SALON1', invoiceId: 'INV2-AAAA' })
    expect(paypal.recordInvoicePayment.mock.calls[0][0]).toMatchObject({ invoiceId: 'INV2-AAAA', amount: 40, captureId: 'CAP1' })
    expect(saved()).toMatchObject({ invoiceId: 'INV2-AAAA', invoiceNumber: '0012', invoiceStatus: 'PAID', invoicePaid: 40, invoiceError: null })

    const toSam = notifyCustomer.mock.calls[0][0]
    expect(toSam.attachments[0]).toMatchObject({ filename: 'receipt-0012.pdf', contentType: 'application/pdf' })
    expect(toSam.attachments[0].content.subarray(0, 5).toString()).toBe('%PDF-')
    expect(toSam.text).toMatch(/PayPal invoice 0012 \(paid\): https:\/\/paypal\.test\/invoice\/p\/0012/)
    expect(toSam.html).toMatch(/View your invoice on PayPal/)
    const toOwner = notifyOwner.mock.calls[0][0]
    expect(toOwner.attachments[0].filename).toBe('receipt-0012.pdf')
    expect(toOwner.text).toMatch(/invoice\/s\/0012/)
  })

  test('PayPal refuses invoicing: the booking still stands, the receipt still goes, the owner is told', async () => {
    createBooking.mockResolvedValue(booked())
    paypal.createInvoice.mockRejectedValue(Object.assign(new Error('PayPal 403 NOT_AUTHORIZED'), { code: 'NOT_AUTHORIZED', status: 403 }))
    const r = await finalizeOrder('ORDER1')
    expect(r.status).toBe('confirmed')
    expect(provider.refund).not.toHaveBeenCalled()
    expect(saved().invoiceError).toMatch(/didn't allow invoicing/)
    expect(notifyCustomer.mock.calls[0][0].attachments[0].filename).toBe('receipt-appt-inv.pdf')
    expect(notifyOwner.mock.calls[0][0].text).toMatch(/No PayPal invoice yet: PayPal didn't allow invoicing/)
    // A connected business reconnects; on Flow's demo account the fix is in Flow's PayPal app.
    expect(saved().invoiceError).toMatch(/reconnect PayPal/)
    jest.clearAllMocks()
    createBooking.mockResolvedValue(booked({ payeeMerchantId: null }))
    await finalizeOrder('ORDER1')
    expect(saved().invoiceError).toBe("PayPal didn't allow invoicing yet: Flow's PayPal app needs Invoicing switched on in the PayPal developer dashboard")
  })

  test('a deposit is one invoice, partly paid; the balance payment makes it paid', async () => {
    createBooking.mockResolvedValue(booked({ totalAmount: 120, amountPaid: 30, serviceName: 'Color & Gloss' }))
    await finalizeOrder('ORDER1')
    expect(paypal.createInvoice.mock.calls[0][0].lines[0].amount).toBe(120)
    expect(paypal.recordInvoicePayment.mock.calls[0][0].amount).toBe(30)
    expect(saved().invoiceStatus).toBe('PARTIALLY_PAID')

    jest.clearAllMocks()
    getAppointmentsForBusiness.mockResolvedValue([booked({ totalAmount: 120, amountPaid: 120, balancePaymentId: 'CAP2', serviceName: 'Color & Gloss', invoiceId: 'INV2-AAAA', invoiceNumber: '0012', invoiceStatus: 'PARTIALLY_PAID', invoicePaid: 30 })])
    await confirmPaidBooking({ kind: 'balance', businessId: BID, appointmentId: 'appt-inv-1', startTime: START, totalAmount: 120, customerId: 'sam', serviceName: 'Color & Gloss', channel: 'email' }, { provider: 'paypal', paymentId: 'CAP2', amount: 90, currency: 'USD' })
    expect(paypal.createInvoice).not.toHaveBeenCalled()
    expect(paypal.recordInvoicePayment.mock.calls[0][0]).toMatchObject({ amount: 90, captureId: 'CAP2' })
    expect(saved().invoiceStatus).toBe('PAID')
    expect(notifyCustomer.mock.calls[0][0].attachments[0].filename).toBe('receipt-0012.pdf')
    expect(notifyOwner.mock.calls[0][0].subject).toMatch(/Paid in full/)
  })

  test('a retry finishes a part-done invoice instead of making a second one', async () => {
    const a = booked({ invoiceId: 'INV2-AAAA', invoiceNumber: '0012', invoiceStatus: 'DRAFT' })
    const out = await invoices.issueForBooking({ business, appointment: a, customer: sam })
    expect(paypal.createInvoice).not.toHaveBeenCalled()
    expect(paypal.sendInvoice).toHaveBeenCalled()
    expect(out.invoiceStatus).toBe('PAID')
  })

  test('nothing to invoice: demo history, membership-covered, cash walk-in', async () => {
    for (const o of [{ seeded: true, paymentId: 'hist-1' }, { membershipId: 'm1', paymentId: 'membership:m1', amountPaid: 0 }, { paymentProvider: null, paymentId: null }]) {
      expect((await invoices.issueForBooking({ business, appointment: booked(o) })).skipped).toBeTruthy()
    }
    expect(paypal.createInvoice).not.toHaveBeenCalled()
  })
})

test('a refund is recorded on the invoice', async () => {
  provider.refund.mockResolvedValue({ refundId: 'REF1', status: 'COMPLETED', amount: 40, currency: 'USD' })
  const r = await refundAppointment({ business, appointment: booked({ invoiceId: 'INV2-AAAA', invoiceNumber: '0012', invoiceStatus: 'PAID', invoicePaid: 40 }), amount: 40, notify: false })
  expect(paypal.recordInvoiceRefund.mock.calls[0][0]).toMatchObject({ merchantId: 'SALON1', invoiceId: 'INV2-AAAA', amount: 40, requestId: 'invref_REF1' })
  expect(r.invoiceStatus).toBe('REFUNDED')
})

describe('owner tools (MCP)', () => {
  const withInvoice = booked({ invoiceId: 'INV2-AAAA', invoiceNumber: '0012', invoiceStatus: 'PAID', invoicePaid: 40, invoiceUrl: INVOICE.recipientUrl, invoicerUrl: INVOICE.invoicerUrl })

  test('list_invoices and get_invoice show the status PayPal reports now', async () => {
    getAppointmentsForBusiness.mockResolvedValue([withInvoice, booked({ appointmentId: 'appt-inv-2', invoiceError: "PayPal didn't allow invoicing on this account" })])
    paypal.getInvoice.mockResolvedValue({ status: 'PAID', total: 40, paid: 40, refunded: 0, due: 0 })
    const list = await ownerPaypal.listInvoices(business, {})
    expect(list.invoices.map(i => [i.invoice, i.status])).toEqual([['0012', 'Paid'], [null, 'not issued yet']])
    expect(list.invoices[0].in_paypal).toMatchObject({ status: 'Paid', due: 0 })
    expect(list.invoices[1].problem).toMatch(/didn't allow/)
    const one = await ownerPaypal.getInvoice(business, { invoice_number: '0012' })
    expect(one).toMatchObject({ invoice: '0012', open_in_your_paypal: INVOICE.invoicerUrl, customer_link: INVOICE.recipientUrl })
  })

  test('send_invoice quotes first, then puts the receipt PDF in the customer\'s inbox', async () => {
    getAppointmentsForBusiness.mockResolvedValue([withInvoice])
    const q = await ownerPaypal.sendInvoice(business, { booking_id: 'appt-inv-1' })
    expect(q.message).toMatch(/sends invoice 0012 .* to Sam Rivera's inbox/)
    expect(notifyCustomer).not.toHaveBeenCalled()
    const r = await ownerPaypal.sendInvoice(business, { booking_id: 'appt-inv-1', confirm: true })
    expect(r).toMatchObject({ sent: true, to: "Sam Rivera's inbox", attachment: 'receipt-0012.pdf' })
  })

  test('issue_invoice creates a missing one after a quote', async () => {
    getAppointmentsForBusiness.mockResolvedValue([booked({ invoiceError: 'PayPal error (500)' })])
    expect((await ownerPaypal.issueInvoice(business, { booking_id: 'appt-inv-1' })).needs_confirmation).toBe(true)
    expect(paypal.createInvoice).not.toHaveBeenCalled()
    const r = await ownerPaypal.issueInvoice(business, { booking_id: 'appt-inv-1', confirm: true })
    expect(r).toMatchObject({ issued: true, invoice: '0012', status: 'Paid' })
  })
})

describe('customer tools', () => {
  const catalog = CATALOG.map((c, i) => ({ ...c.build(), businessId: i === 0 ? BID : `${BID}-${c.slug}` }))
  const ctx = () => ({ catalog, customer: sam, customerLocation: { ...PERSONA.home }, channel: 'web' })

  test('get_my_invoices shows only their own; send_my_invoice puts it in their own inbox', async () => {
    getAppointmentsForBusiness.mockImplementation(async id => (id === BID ? [booked({ invoiceNumber: '0012', invoiceStatus: 'PAID', invoiceUrl: INVOICE.recipientUrl }), booked({ appointmentId: 'someone-else', customerId: 'kim', customerName: 'Kim' })] : []))
    const list = await executeTool('get_my_invoices', {}, ctx())
    expect(list.invoices).toHaveLength(1)
    expect(list.invoices[0]).toMatchObject({ invoice: '0012', status: 'Paid', view_on_paypal: INVOICE.recipientUrl })
    const r = await executeTool('send_my_invoice', { business_name: 'Willow & Co. Salon' }, ctx())
    expect(r).toMatchObject({ sent: true, to: 'your Flow inbox', invoice: '0012' })
    expect(notifyCustomer.mock.calls[0][0]).toMatchObject({ customer: expect.objectContaining({ customerId: 'sam' }), attachments: [expect.objectContaining({ filename: 'receipt-0012.pdf' })] })
  })
})

test('the web inbox keeps the PDF with the message', async () => {
  const inbox = jest.requireActual('../services/demoInbox')
  await inbox.deliver({ sid: 'abcdef123456', role: 'customer', to: 'Sam Rivera', subject: 'Receipt', text: 'hi', attachments: [{ filename: 'receipt-0012.pdf', content: Buffer.from('%PDF-1.7 test'), contentType: 'application/pdf' }] })
  const [m] = await inbox.list('abcdef123456')
  expect(m.attachments).toEqual([{ filename: 'receipt-0012.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.7 test').toString('base64') }])
})
