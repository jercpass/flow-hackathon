// @ts-check
'use strict'

// ─── Owner operations (run the business by asking) ────────────────────────────
// What a business owner can do from their own AI agent via the business MCP
// link: read the schedule, revenue and customers; block time; move a booking;
// cancel or refund — money and destructive actions always quote first and only
// act on confirm=true. Everything is scoped to ONE business.

const { randomUUID: uuid } = require('crypto')
const { getAppointmentsForBusiness, createAppointment, updateAppointment } = require('../services/dynamo/appointments')
const { getFreeUnitsForSlot } = require('./units')
const { quoteRefund, refundAppointment } = require('./refunds')
const { formatMoney, round2, currencyOf } = require('../utils/money')
const { dayjs, tzOf, toUtcIso, atLocal, fmtLocal } = require('../utils/time')
const redis = require('../services/redis')
const bookingMail = require('./bookingMail')
const trace = require('../services/trace')

const short = id => String(id || '').slice(0, 8)
// A reference photo the customer sent, as a signed link that lasts an hour (services/photos).
const photoLink = id => require('../services/photos').link(id)

async function bookingsBetween(business, fromIso, toIso) {
  return (await getAppointmentsForBusiness(business.businessId, fromIso, toIso))
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
}

function staffName(business, unitId) {
  return (business.config.staff || []).find(s => s.staffId === unitId)?.name || unitId || null
}

function view(business, a) {
  const cur = a.currency || currencyOf(business)
  return {
    booking_id: short(a.appointmentId),
    when: fmtLocal(a.startTime, tzOf(business)),
    service: a.serviceName || (business.config.services || []).find(s => s.serviceId === a.serviceId)?.name || a.serviceId,
    customer: a.customerName || null,
    staff: staffName(business, a.unitId),
    status: a.status,
    paid: a.amountPaid ? formatMoney(a.amountPaid, cur) : null,
    refunded: a.refundAmount ? formatMoney(a.refundAmount, cur) : null,
    notes: a.customerNotes || null,
    ...(a.customerPhotos?.length ? { reference_photos: a.customerPhotos.map(photoLink) } : {}),
    channel: originOf(a),
    ...paypalView(business, a, cur),
    ...(a.refundRequest ? { refund_request: require('./refundRequests').statusText(a, cur), ...(a.refundRequest.status === 'open' ? { refund_reason: a.refundRequest.reason } : {}) } : {}),
    ...(movedByOf(a) ? { moved_by: movedByOf(a) === 'owner' ? 'you' : 'the customer' } : {})
  }
}

async function findBooking(business, bookingId) {
  const id = String(bookingId || '').trim().toLowerCase()
  if (id.length < 6) return null
  const all = await bookingsBetween(business, dayjs().subtract(120, 'day').toISOString(), dayjs().add(120, 'day').toISOString())
  return all.find(a => a.appointmentId.toLowerCase() === id || a.appointmentId.toLowerCase().startsWith(id)) || null
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function getSchedule(business, { from_date, to_date } = {}) {
  const tz = tzOf(business)
  const from = from_date ? atLocal(from_date, '00:00', tz) : dayjs().tz(tz).startOf('day')
  const to = to_date ? atLocal(to_date, '23:59', tz) : from.add(7, 'day').endOf('day')
  const rows = (await bookingsBetween(business, from.toISOString(), to.toISOString())).filter(a => a.status !== 'cancelled')
  return {
    business: business.name,
    from: from.format('ddd, MMM D'),
    to: to.format('ddd, MMM D'),
    bookings: rows.filter(a => a.status !== 'blocked').map(a => view(business, a)),
    blocked: rows.filter(a => a.status === 'blocked').map(a => ({ when: fmtLocal(a.startTime, tz), until: fmtLocal(a.endTime, tz), staff: staffName(business, a.unitId), reason: a.serviceName })),
    // Seats held while a customer pays with PayPal (not booked yet).
    waiting_for_paypal: (await require('./holds').list(business.businessId, from.toISOString(), to.toISOString()).catch(() => [])).map(h => ({
      when: fmtLocal(h.startIso, tz), service: h.serviceName, customer: h.customerName || null, staff: staffName(business, h.unitId),
      amount: h.amount ? formatMoney(h.amount, h.currency || currencyOf(business)) : null,
      status: h.status === 'reviewing' ? 'PayPal is reviewing the payment' : `held ${Math.max(0, Math.ceil((h.until - Date.now()) / 60_000))} more min while they pay`
    }))
  }
}

// What PayPal says about a booking's payment, for the owner's AI (the calendar shows the same).
function paypalView(business, a, cur) {
  const out = {}
  if (a.paidUnder === 'allowance') out.paid_by = `the customer's AI, under their signed mandate${a.paymentMandateId ? ` (${a.paymentMandateId})` : ''}`
  if (a.paymentStatus === 'reversed') out.reversed_by_paypal = formatMoney(a.reversedAmount || a.amountPaid, cur)
  if (a.dispute) {
    out.dispute = { id: a.dispute.id, status: a.dispute.outcome || a.dispute.status, reason: require('./disputes').reasonText(a.dispute.reason), respond_by: a.dispute.dueAt ? fmtLocal(a.dispute.dueAt, tzOf(business)) : null, ...(a.dispute.practice ? { practice: true } : {}) }
  }
  return out
}

async function getRevenue(business, { days = 7 } = {}) {
  const n = Math.min(90, Math.max(1, Number(days) || 7))
  const cur = currencyOf(business)
  const rows = (await bookingsBetween(business, dayjs().subtract(n, 'day').toISOString(), dayjs().add(30, 'day').toISOString()))
    .filter(a => a.status !== 'blocked' && Number(a.amountPaid) > 0)
  const paid = round2(rows.reduce((s, a) => s + Number(a.amountPaid || 0), 0))
  const refunded = round2(rows.reduce((s, a) => s + Number(a.refundAmount || 0), 0))
  const byService = {}
  for (const a of rows) {
    const k = a.serviceName || a.serviceId
    byService[k] = round2((byService[k] || 0) + Number(a.amountPaid || 0) - Number(a.refundAmount || 0))
  }
  return {
    business: business.name,
    window: `bookings from the last ${n} days and the next 30 days`,
    bookings_paid: rows.length,
    collected: formatMoney(paid, cur),
    refunded: formatMoney(refunded, cur),
    net: formatMoney(round2(paid - refunded), cur),
    by_service: Object.fromEntries(Object.entries(byService).map(([k, v]) => [k, formatMoney(v, cur)])),
    note: 'All payments go through PayPal; Flow takes no platform fee.'
  }
}

async function listCustomers(business) {
  const rows = (await bookingsBetween(business, dayjs().subtract(400, 'day').toISOString(), dayjs().add(60, 'day').toISOString()))
    .filter(a => a.customerId && a.status !== 'blocked' && a.status !== 'cancelled')
  const by = {}
  for (const a of rows) {
    const c = by[a.customerId] || (by[a.customerId] = { name: a.customerName || 'Customer', visits: 0, last: null, spent: 0 })
    c.visits++; c.spent += Number(a.amountPaid || 0) - Number(a.refundAmount || 0)
    if (!c.last || a.startTime > c.last) c.last = a.startTime
  }
  return {
    customers: Object.values(by).sort((x, y) => y.visits - x.visits).map(c => ({
      name: c.name, visits: c.visits, last_booking: fmtLocal(c.last, tzOf(business)), spent: formatMoney(round2(c.spent), currencyOf(business))
    }))
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function blockTime(business, { date, start_time, end_time, staff_name, reason }) {
  const tz = tzOf(business)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !/^\d{2}:\d{2}$/.test(String(start_time || '')) || !/^\d{2}:\d{2}$/.test(String(end_time || ''))) {
    return { error: 'Give date as YYYY-MM-DD and start_time / end_time as HH:mm (business local time).' }
  }
  const start = atLocal(date, start_time, tz), end = atLocal(date, end_time, tz)
  if (!end.isAfter(start)) return { error: 'end_time must be after start_time.' }
  let units = (business.config.staff || []).map(s => s.staffId)
  if (staff_name) {
    const s = (business.config.staff || []).find(x => x.name.toLowerCase() === String(staff_name).toLowerCase())
    if (!s) return { error: `No staff member named ${staff_name}.` }
    units = [s.staffId]
  }
  if (!units.length) units = ['__business__']
  for (const u of units) {
    await createAppointment({
      appointmentId: uuid(), businessId: business.businessId, customerId: null,
      customerName: reason || 'Blocked', serviceName: reason || 'Blocked',
      unitId: u, startTime: start.utc().toISOString(), endTime: end.utc().toISOString(), status: 'blocked', createdVia: 'mcp_block'
    })
  }
  trace.event('db', `Owner blocked time: ${fmtLocal(start.toISOString(), tz)}–${end.format('h:mm A')}`, { staff: staff_name || 'everyone', reason: reason || null })
  return { blocked: true, from: fmtLocal(start.toISOString(), tz), until: end.format('h:mm A'), staff: staff_name || 'all staff', reason: reason || null }
}

async function rescheduleBooking(business, { booking_id, new_time, unit_id }) {
  const a = await findBooking(business, booking_id)
  if (!a || a.status === 'blocked') return { error: 'No booking with that id. Use get_schedule to find booking_id.' }
  if (a.status === 'cancelled') return { error: 'That booking is cancelled.' }
  const tz = tzOf(business)
  const newIso = toUtcIso(new_time, tz)
  if (!newIso) return { error: 'Give new_time as YYYY-MM-DDTHH:mm in business local time.' }
  const svc = (business.config.services || []).find(s => s.serviceId === a.serviceId)
  const minutes = svc?.duration || Math.round((new Date(a.endTime).getTime() - new Date(a.startTime).getTime()) / 60000)
  const endIso = new Date(new Date(newIso).getTime() + minutes * 60000).toISOString()
  let unitId = a.unitId
  if (svc && svc.unitType !== 'queue') {
    // The booking itself must not block its own move (same staff, overlapping time).
    const free = (await getFreeUnitsForSlot(business, svc, newIso, endIso))
    const selfOverlap = a.unitId && !free.includes(a.unitId) && new Date(a.startTime) < new Date(endIso) && new Date(newIso) < new Date(a.endTime)
    if (selfOverlap && await onlyItselfBlocks(business, a, newIso, endIso)) free.push(a.unitId)
    if (unit_id) {
      const staff = (business.config.staff || []).find(s => s.staffId === unit_id)
      if (!staff) return { error: 'Unknown staff member.' }
      if (!(staff.services || []).includes(svc.serviceId)) return { error: `${staff.name} doesn't do ${svc.name}.` }
      if (!free.includes(unit_id)) return { error: `${staff.name} isn't free at ${fmtLocal(newIso, tz)}.` }
      unitId = unit_id
    } else {
      if (!free.length) return { error: `Nobody is free at ${fmtLocal(newIso, tz)} for ${svc.name}.` }
      unitId = free.includes(a.unitId) ? a.unitId : free[0]
    }
  }
  // bookedVia keeps how it was first booked (web chat, voice…); movedBy says who moved it.
  const moved = { ...a, appointmentId: uuid(), startTime: newIso, endTime: endIso, unitId, status: 'confirmed', createdVia: 'owner_reschedule', bookedVia: originOf(a), movedBy: 'owner', rescheduledFrom: a.appointmentId }
  await createAppointment(moved)
  // The payment and invoice now belong to the new booking (core/moved).
  await updateAppointment(business.businessId, a.startTime, a.appointmentId, require('./moved').movedAwayFields(moved.appointmentId, { cancelledBy: 'owner_reschedule', cancelledAt: new Date().toISOString() }))
  if (a.unitId) await redis.releaseSlot(business.businessId, a.startTime, a.unitId).catch(() => {})
  trace.event('db', 'Owner moved a booking', { from: fmtLocal(a.startTime, tz), to: fmtLocal(newIso, tz), staff: staffName(business, unitId) })
  const mail = await bookingMail.moved({ business, from: a, to: moved, by: 'owner' })
  return { rescheduled: true, booking_id: short(moved.appointmentId), service: moved.serviceName, when: fmtLocal(newIso, tz), staff: staffName(business, unitId), customer_notified: mail.customer }
}

// True when the only thing occupying a.unitId in [start, end) is booking `a` itself.
async function onlyItselfBlocks(business, a, startIso, endIso) {
  const others = (await bookingsBetween(business, dayjs(startIso).subtract(1, 'day').toISOString(), dayjs(endIso).add(1, 'day').toISOString()))
    .filter(x => x.unitId === a.unitId && x.appointmentId !== a.appointmentId && x.status !== 'cancelled')
    .filter(x => new Date(x.startTime) < new Date(endIso) && new Date(startIso) < new Date(x.endTime))
  return others.length === 0
}

// ── Calendar feed (Bryntum Scheduler) ────────────────────────────────────────
// Staff as resources; bookings and blocked time as events. Times are sent as
// business-local wall-clock strings so the calendar shows the salon's hours in
// any browser; drops come back the same way (see rescheduleBooking new_time).
async function calendar(business, { from_date, to_date } = {}) {
  const tz = tzOf(business)
  const from = from_date ? atLocal(from_date, '00:00', tz) : dayjs().tz(tz).startOf('day')
  const to = to_date ? atLocal(to_date, '23:59', tz) : from.add(7, 'day').endOf('day')
  const local = iso => dayjs(iso).tz(tz).format('YYYY-MM-DDTHH:mm:ss')
  const now = Date.now()
  const rows = (await bookingsBetween(business, from.toISOString(), to.toISOString())).filter(a => a.status !== 'cancelled')
  const staff = (business.config.staff || []).map(s => ({
    id: s.staffId, name: s.name,
    services: (s.services || []).map(id => (business.config.services || []).find(x => x.serviceId === id)?.name).filter(Boolean).join(', ')
  }))
  const resources = rows.some(a => a.unitId === '__business__') ? [...staff, { id: '__business__', name: 'Whole salon', services: '' }] : staff
  const events = rows.map(a => {
    const blocked = a.status === 'blocked'
    const past = new Date(a.endTime).getTime() < now
    const cur = a.currency || currencyOf(business)
    const partly = !blocked && Number(a.amountPaid) > 0 && Number(a.amountPaid) < Number(a.totalAmount || 0)
    const pay = blocked ? null : paymentState(a, partly)
    return {
      id: a.appointmentId,
      resourceId: a.unitId || '__business__',
      startDate: local(a.startTime),
      endDate: local(a.endTime),
      name: blocked ? (a.serviceName || 'Blocked') : (a.serviceName || a.serviceId),
      customer: blocked ? null : (a.customerName || 'Customer'),
      status: blocked ? 'blocked' : a.status,
      paid: !blocked && a.amountPaid ? formatMoney(a.amountPaid, cur) : null,
      refunded: a.refundAmount ? formatMoney(a.refundAmount, cur) : null,
      notes: a.customerNotes || null,
      photos: !blocked && a.customerPhotos?.length ? a.customerPhotos.map(photoLink) : null,
      channel: originOf(a),
      moved: movedByOf(a),
      // What PayPal says about the payment (PAYPAL_GAPS.md §5): the bar's colour and its tooltip.
      pay,
      paypal: blocked ? null : paypalLines(a, cur),
      ...(a.dispute ? { disputeId: a.dispute.id, disputeDue: a.dispute.dueAt ? local(a.dispute.dueAt) : null, disputeOpen: !a.dispute.outcome && a.dispute.status !== 'RESOLVED' } : {}),
      eventColor: blocked ? 'gray' : PAY_COLOR[pay] || (past ? 'gray' : 'blue'),
      draggable: !blocked && !past,
      resizable: false
    }
  })
  // Seats held while a customer pays with PayPal: shown until PayPal settles them,
  // then the booking takes their place (or they're gone if the payment never came).
  const held = await require('./holds').list(business.businessId, from.toISOString(), to.toISOString()).catch(() => [])
  for (const h of held) {
    events.push({
      id: `hold:${h.orderId}`, resourceId: h.unitId || '__business__', startDate: local(h.startIso), endDate: local(h.endIso),
      name: h.serviceName || 'Held', customer: h.customerName || 'Customer', status: 'held', pay: h.status === 'reviewing' ? 'reviewing' : 'held',
      heldUntil: h.until, amountDue: h.amount ? formatMoney(h.amount, h.currency || currencyOf(business)) : null, channel: h.channel || null,
      paypal: [h.status === 'reviewing' ? 'PayPal is reviewing this payment: it books when the payment clears' : `Held while the customer pays with PayPal (order ${String(h.orderId).slice(0, 6)}…)`],
      eventColor: 'yellow', cls: 'cal-held', draggable: false, resizable: false
    })
  }
  const av = business.config.availability || {}
  return { business: business.name, timezone: tz, hours: { open: av.open || '09:00', close: av.close || '18:00' }, from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD'), resources, events }
}

// The booking's payment as PayPal last told us; a dispute or reversal wins over the rest.
const PAY_COLOR = { deposit: 'orange', refunded: 'red', partially_refunded: 'red', reversed: 'purple', disputed: 'deep-orange' }
function paymentState(a, partly) {
  if (a.paymentStatus === 'reversed') return 'reversed'
  if (a.dispute && !a.dispute.outcome && a.dispute.status !== 'RESOLVED') return 'disputed'
  if (Number(a.refundAmount) > 0) return Number(a.refundAmount) >= Number(a.amountPaid || 0) ? 'refunded' : 'partially_refunded'
  if (a.paymentStatus === 'membership') return 'membership'
  if (partly) return 'deposit'
  return Number(a.amountPaid) > 0 ? 'paid' : 'none'
}
function paypalLines(a, cur) {
  const out = []
  if (Number(a.amountPaid) > 0 && a.paymentId && !String(a.paymentId).startsWith('hist-') && (!a.seeded || a.samplePayment)) {
    out.push(`PayPal capture ${String(a.paymentId).slice(0, 8)}…${a.samplePayment ? ' (sample payment, shared by every demo session)' : ''}${a.paidUnder === 'allowance' ? ` · paid by the customer's AI under their signed mandate${a.paymentMandateId ? ` (${a.paymentMandateId})` : ''}` : ''}`)
  }
  if (a.paymentStatus === 'reversed') out.push(`PayPal took back ${formatMoney(a.reversedAmount || a.amountPaid, cur)} (chargeback or dispute outcome)`)
  if (a.dispute) {
    const d = a.dispute
    out.push(d.outcome || d.status === 'RESOLVED'
      ? `Dispute ${d.id}: ${String(d.outcome || 'resolved').replace(/^RESOLVED_/, '').replace(/_/g, ' ').toLowerCase()}`
      : `Dispute ${d.practice ? '(practice) ' : ''}open: ${require('./disputes').reasonText(d.reason)}${d.dueAt ? ` · respond by ${new Date(d.dueAt).toDateString()}` : ''}`)
  }
  return out.length ? out : null
}

// Refund part or all of what was paid (owner's choice), quote first.
async function refundBooking(business, { booking_id, amount, reason, confirm }) {
  const a = await findBooking(business, booking_id)
  if (!a || !(Number(a.amountPaid) > 0)) return { error: 'No paid booking with that id.' }
  // Paid at the salon (a walk-in marked paid): there's no PayPal payment to send money back from.
  if (!a.paymentId) return { error: "This was paid in person, not with PayPal, so Flow can't refund it. Refund the customer directly." }
  if (a.samplePayment) return { error: "This is a sample booking. Its PayPal payment is real (sandbox), but every demo session shares it, so it can't be refunded. Book your own on the Customer side to try a refund." }
  if (a.seeded || String(a.paymentId).startsWith('hist-')) return { error: "This visit is part of the demo's made-up history: it was never charged, so there is nothing to refund." }
  const cur = a.currency || currencyOf(business)
  const refundable = round2(Number(a.amountPaid) - Number(a.refundAmount || 0))
  if (refundable <= 0) return { error: 'This booking is already fully refunded.' }
  const value = amount == null ? refundable : round2(Number(amount))
  if (!(value > 0) || value > refundable) return { error: `Refund must be between ${formatMoney(0.01, cur)} and ${formatMoney(refundable, cur)}.` }
  if (!confirm) {
    return { needs_confirmation: true, booking: view(business, a), refund: formatMoney(value, cur), refundable: formatMoney(refundable, cur), message: `This will refund ${formatMoney(value, cur)} to ${a.customerName || 'the customer'} via PayPal. Call again with confirm=true to do it.` }
  }
  const already = Number(a.refundAmount || 0)
  const r = await refundAppointment({ business, appointment: a, amount: value, reason: reason || 'Refund from the business', initiatedBy: 'owner', requestSuffix: `-o${Math.round(already * 100)}` })
  // A refund the customer asked for (core/refundRequests) is answered by this one.
  if (r.refunded) await require('./refundRequests').settle(business, a, r.amount)
  return r.refunded
    ? { refunded: true, amount: formatMoney(r.amount, cur), status: r.status, refund_id: r.refundId }
    : { refunded: false, message: r.manual ? 'This payment can\'t be refunded automatically — refund it from PayPal directly.' : 'Nothing to refund.' }
}

// Cancel on the customer's behalf: refund per policy, in full, or not at all.
async function cancelBooking(business, { booking_id, refund = 'policy', reason, confirm }) {
  const a = await findBooking(business, booking_id)
  if (!a || a.status === 'blocked') return { error: 'No booking with that id.' }
  if (a.status === 'cancelled') return { error: 'Already cancelled.' }
  const cur = a.currency || currencyOf(business)
  const paid = round2(Number(a.amountPaid || 0) - Number(a.refundAmount || 0))
  const q = quoteRefund(a, business.config.policies?.refundTiers)
  const amount = refund === 'full' ? paid : refund === 'none' ? 0 : q.amount
  if (!confirm) {
    return {
      needs_confirmation: true, booking: view(business, a),
      refund: formatMoney(amount, cur), refund_rule: refund === 'policy' ? `${q.pct}% under the cancellation policy` : refund,
      paid: formatMoney(paid, cur),
      // Every choice, so a screen can show them side by side.
      options: { policy: { amount: q.amount, label: formatMoney(q.amount, cur), pct: q.pct }, full: { amount: paid, label: formatMoney(paid, cur) }, none: { amount: 0, label: formatMoney(0, cur) } },
      ...(a.membershipId ? { covered_by: a.membershipPlan || 'a membership', note: 'Covered by a membership: nothing was paid, and the use goes back to the membership.' } : {}),
      tells_customer: !!a.customerId,
      ...(a.seeded ? { demo_booking: true } : {}),
      // Paid at the salon: there's no PayPal payment to refund from, so the owner pays it back.
      ...(amount > 0 && !a.paymentId ? { refund_how: 'in person' } : {}),
      message: a.samplePayment
        ? "This is a sample booking. Its PayPal payment is shared by every demo session, so cancelling it moves no money and refunds nothing. Call again with confirm=true to cancel."
        : a.seeded
        ? 'This is a made-up demo booking: nothing was really paid, so cancelling moves no money. Call again with confirm=true to cancel.'
        : amount > 0 && !a.paymentId
        ? `This cancels the booking. They paid in person, so refund ${formatMoney(amount, cur)} to them directly; Flow can't send it through PayPal. Call again with confirm=true to cancel.`
        : `This cancels the booking and refunds ${formatMoney(amount, cur)}${amount > 0 ? ' through PayPal' : ''}. Call again with confirm=true to do it.`
    }
  }
  await updateAppointment(business.businessId, a.startTime, a.appointmentId, { status: 'cancelled', cancelledBy: 'owner', cancelledAt: new Date().toISOString() })
  if (a.unitId) await redis.releaseSlot(business.businessId, a.startTime, a.unitId).catch(() => {})
  // A booking a membership paid for gives its use back (core/memberships).
  const usesLeft = a.membershipId ? await require('./memberships').afterCancel(a).catch(() => null) : null
  trace.event('db', 'Owner cancelled a booking', { when: fmtLocal(a.startTime, tzOf(business)), refund: formatMoney(amount, cur) })
  let r = { refunded: false, amount: 0 }
  // A made-up demo booking: no real money to send back.
  if (a.seeded) r = { refunded: false, amount: 0, demo: true }
  // Paid in person: nothing to send back through PayPal; the owner refunds it directly.
  else if (amount > 0 && !a.paymentId) r = { refunded: false, amount, manual: true }
  else if (amount > 0) {
    try {
      r = await refundAppointment({ business, appointment: a, amount, reason: reason || 'Cancelled by the business', initiatedBy: 'owner', requestSuffix: `-oc${Math.round(Number(a.refundAmount || 0) * 100)}`, notify: false })
    } catch (err) {
      // The booking is already cancelled (the seat is free); say plainly the money didn't move.
      trace.event('paypal', 'Refund failed: the owner needs to refund from PayPal', { reason: String(err.message).slice(0, 80) })
      await bookingMail.cancelled({ business, appointment: a, by: 'owner', refund: { kind: 'failed', amount }, reason })
      return { cancelled: true, refunded: false, refund_failed: true, refund: formatMoney(0, cur), message: `Cancelled, but the ${formatMoney(amount, cur)} refund didn't go through automatically. Refund it from PayPal.` }
    }
  }
  if (r.refunded) await require('./refundRequests').settle(business, a, r.amount)
  const kind = a.membershipId ? 'membership' : r.refunded ? 'refunded' : r.manual ? 'manual' : paid > 0 ? 'none' : 'unpaid'
  const mail = await bookingMail.cancelled({ business, appointment: a, by: 'owner', refund: { kind, amount: r.refunded ? r.amount : amount, usesLeft, invoiceStatus: r.invoiceStatus }, reason })
  return { cancelled: true, refunded: !!r.refunded, refund: formatMoney(r.refunded ? r.amount : 0, cur), customer_notified: !!mail.customer, ...(r.demo ? { message: a.samplePayment ? 'It was a sample booking: its PayPal payment is shared by every demo session, so no money moved.' : 'It was a made-up demo booking, so no money moved.' } : {}), ...(r.manual ? { refund_to_pay_directly: formatMoney(amount, cur), message: `They paid in person, so refund ${formatMoney(amount, cur)} to them directly.` } : {}) }
}

// How a booking first came in, even after it has been moved (older moves kept no bookedVia).
const MOVE_CHANNELS = new Set(['owner_reschedule', 'reschedule'])
function originOf(a) {
  return a.bookedVia || (MOVE_CHANNELS.has(a.createdVia) ? null : a.createdVia) || null
}
function movedByOf(a) {
  return a.movedBy || (a.createdVia === 'owner_reschedule' ? 'owner' : a.createdVia === 'reschedule' ? 'customer' : null)
}

module.exports = { getSchedule, getRevenue, listCustomers, blockTime, rescheduleBooking, refundBooking, cancelBooking, findBooking, view, calendar, originOf, movedByOf }
