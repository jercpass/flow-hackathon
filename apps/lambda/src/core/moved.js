// @ts-check
'use strict'

// A moved booking is a new appointment plus the old one cancelled (the table key
// includes the start time). The payment, its PayPal ids and its invoice travel
// to the new booking, so the old record must stop claiming them: otherwise it
// still says "paid $40" against the same PayPal payment, and after a refund the
// books disagree with PayPal (the owner's PayPal check reports "out of sync").

/** What the old record becomes when its booking moves to `newAppointmentId`. */
function movedAwayFields(newAppointmentId, extra = {}) {
  return {
    status: 'cancelled',
    movedTo: newAppointmentId,
    paymentStatus: 'moved',
    amountPaid: 0,
    paymentId: null,
    balancePaymentId: null,
    invoiceId: null,
    invoiceNumber: null,
    invoiceStatus: null,
    invoiceUrl: null,
    invoicerUrl: null,
    invoicePaid: 0,
    ...extra
  }
}

module.exports = { movedAwayFields }
