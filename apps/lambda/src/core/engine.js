// @ts-check
'use strict'

// ─── Booking engine ───────────────────────────────────────────────────────────
// The universal engine from brief section A/E: one code path for every business
// type, driven entirely by service config (unit_type x payment_mode). A gaming
// café, a doctor, and a queue-based clinic all call the same three functions.

const { randomUUID: uuid } = require('crypto')
const dayjs = require('dayjs')
const { generateCandidateSlots } = require('./slots')
const { getFreeUnitsForSlot, getNextQueueToken, priceForUnit } = require('./units')
const { resolveAmountDue } = require('./paymentModes')
const { createAppointment, getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const redis = require('../services/redis')
const trace = require('../services/trace')
const log = require('../utils/logger')

// Per-period booking quota (for freelancers / solo providers who cap how many
// bookings they take regardless of open slots). Returns the [from,to] window
// containing the given time, for the configured period.
function periodWindow(period, iso) {
  const unit = period === 'day' ? 'day' : period === 'month' ? 'month' : 'week'
  return { from: dayjs(iso).startOf(unit).toISOString(), to: dayjs(iso).endOf(unit).toISOString() }
}

async function withinBookingLimit(business, startIso) {
  const limit = business.config?.bookingLimits
  if (!limit || !limit.max || limit.max <= 0) return true
  const { from, to } = periodWindow(limit.period, startIso)
  const existing = await getAppointmentsForBusiness(business.businessId, from, to)
  const active = existing.filter(a => a.status !== 'cancelled')
  return active.length < limit.max
}

function getService(business, serviceId) {
  const service = business.config.services.find(s => s.serviceId === serviceId && s.active)
  if (!service) throw new Error(`service ${serviceId} not found or inactive`)
  return service
}

/**
 * Available slots for one service on one date, with at least one free unit.
 * Queue-type services don't have a slot grid — caller should branch to
 * getNextQueueToken instead (the AI's intent router decides which to call).
 */
async function getAvailability(business, serviceId, dateIso, unitId) {
  const service = getService(business, serviceId)
  if (service.unitType === 'queue') {
    throw new Error('queue services have no slot grid — call getNextQueueToken')
  }

  // A service may override the business-wide hours/days. Merge so it only changes
  // what it sets (open/close/workingDays), inheriting holidays, notice, and
  // advance window from the business unless explicitly overridden.
  const availability = service.availability
    ? { ...business.config.availability, ...service.availability }
    : business.config.availability

  const candidates = generateCandidateSlots(service, availability, dateIso, business.timezone)
  const available = []
  const dayCache = new Map()   // each unit's bookings for the day, read once for all the slots

  for (const slot of candidates) {
    let freeUnits = await getFreeUnitsForSlot(business, service, slot.start, slot.end, dayCache)
    if (unitId) freeUnits = freeUnits.filter(u => u === unitId)   // scope to a specific staff member
    if (freeUnits.length) available.push({ ...slot, freeUnitCount: freeUnits.length })
  }

  return available
}

/**
 * Can a customer book this exact time? The same grid check_availability offers:
 * opening days and hours, holidays, notice and how far ahead, and, if they named
 * someone, that this person does the service and is free. Run before a PayPal
 * link or a covered booking, so nobody pays for a time that can't happen.
 * Returns null when it can be booked, else a plain message with the open times that day.
 */
async function whyNotBookable(business, service, startIso, unitId) {
  if (service.unitType === 'queue') return null
  const { tzOf, localDate, fmtLocal } = require('../utils/time')
  const tz = tzOf(business)
  const at = new Date(startIso).getTime()
  if (!Number.isFinite(at)) return `"${startIso}" isn't a time I can book.`

  const member = unitId ? (business.config.staff || []).find(s => s.staffId === unitId) : null
  if (member && service.unitType === 'person' && !member.services?.includes(service.serviceId)) {
    const who = (business.config.staff || []).filter(s => s.services?.includes(service.serviceId)).map(s => s.name)
    return `${member.name} doesn't do ${service.name}.${who.length ? ` ${who.join(' or ')} can.` : ''}`
  }

  const when = fmtLocal(startIso, tz)
  if (at <= Date.now()) return `${when} has already passed.`
  const availability = service.availability ? { ...business.config.availability, ...service.availability } : business.config.availability
  const date = localDate(startIso, tz)
  const slot = generateCandidateSlots(service, availability, date, tz).find(s => new Date(s.start).getTime() === at)
  // A service without a fixed length has no grid to check against.
  if (!slot && service.durationMode !== 'variable') {
    return `${when} isn't open for ${service.name}.${await openTimes()}`
  }
  if (slot) {
    const free = await getFreeUnitsForSlot(business, service, slot.start, slot.end)
    if (!free.length) return `${when} is already taken.${await openTimes()}`
    if (member && !free.includes(member.staffId)) return `${member.name} isn't free at ${when}.${await openTimes()}`
  }
  return null

  async function openTimes() {
    const open = await getAvailability(business, service.serviceId, date, unitId).catch(() => [])
    return open.length
      ? ` Open times that day: ${open.slice(0, 6).map(s => fmtLocal(s.start, tz).replace(/^.*, /, '')).join(', ')}.`
      : ' Nothing is open that day; try check_availability for another date.'
  }
}

/**
 * Confirm a booking for a specific slot. Reserves the unit via a Redis NX lock
 * first (closes the race between two customers picking the same slot), then
 * writes the appointment with the payment-idempotency guard from appointments.js.
 *
 * @param {string} paymentId - provider payment id (PayPal capture id / Cashfree cf_payment_id), or null for payment_mode "none"
 * @param {object} [payment] - { provider, providerOrderId, currency, payeeMerchantId } recorded so refunds know where to go
 */
// covered: { membershipId, planName } when a membership or pack pays for it
// (core/memberships): nothing is charged and the booking says so.
async function createBooking({ business, serviceId, startIso, customer, paymentId, createdVia, preferredUnitId, payment, notes, photos, covered }) {
  const service = getService(business, serviceId)
  let { amountDue, requiresPayment } = resolveAmountDue(service)

  if (requiresPayment && !paymentId && !covered) {
    throw new Error('payment required before booking can be confirmed')
  }

  if (!(await withinBookingLimit(business, startIso))) {
    const p = business.config.bookingLimits.period
    throw new Error(`Fully booked for this ${p} — please try a different ${p}.`)
  }

  let unitId
  let queueInfo = null

  if (service.unitType === 'queue') {
    queueInfo = await getNextQueueToken(business, service)
    unitId = service.serviceId
  } else {
    const duration = service.duration || 60
    const endIso = new Date(new Date(startIso).getTime() + duration * 60_000).toISOString()
    const freeUnits = await getFreeUnitsForSlot(business, service, startIso, endIso)
    if (!freeUnits.length) throw new Error('slot no longer available')

    // Honour the customer's chosen staff member if they picked one and that person
    // is free; otherwise assign the first available.
    unitId = (preferredUnitId && freeUnits.includes(preferredUnitId)) ? preferredUnitId : freeUnits[0]
    const locked = await redis.reserveSlot(business.businessId, startIso, unitId, customer.customerId)
    if (!locked) throw new Error('slot was just taken by another customer')
  }

  // Apply any per-staff price override now that the unit is assigned, so the
  // recorded amount matches what the customer was actually charged.
  const priced = priceForUnit(service, business, unitId)
  if (requiresPayment && priced.price !== service.price) {
    amountDue = resolveAmountDue(priced).amountDue
  }
  // What PayPal actually charged wins (e.g. a member discount).
  if (requiresPayment && payment?.amount != null) amountDue = payment.amount
  const charged = requiresPayment && !covered
  // The whole price after any member discount: paying less than this = a deposit.
  const fullPrice = Math.round((priced.price || 0) * (100 - (payment?.memberDiscountPct || 0))) / 100

  const duration = service.duration || (queueInfo ? 15 : 60)
  const endIso = new Date(new Date(startIso).getTime() + duration * 60_000).toISOString()

  // Platform fee accrued per booking for tracking/reporting. With Cashfree
  // Easy Split the actual fee deduction happens at payment time (the split
  // config in core/paymentFlow.js), so this field is informational — it
  // records what was charged, not what will be invoiced.
  // Informational only — Flow's margin share of this booking (the real split,
  // gateway-cost passthrough + margin, is computed post-payment in the webhook).
  // PayPal (Flow) takes no platform fee — the business keeps 100% minus PayPal's own fee.
  const platformFeeDue = charged && payment?.provider !== 'paypal'
    ? Math.round(amountDue * (parseFloat(process.env.FLOW_MARGIN_PCT || '0.75') / 100) * 100) / 100
    : 0

  const appointment = {
    appointmentId: uuid(),
    businessId:    business.businessId,
    customerId:    customer.customerId,
    // Denormalised onto the appointment so the reminder job, weekly report, and
    // dashboard don't each need a customer lookup per booking. These are read by
    // reminder.js (customerPhone), the dashboard bookings/stats (customerName,
    // amountPaid), and weeklyReport.js (amountPaid) — without them those features
    // silently show blanks / zero revenue.
    customerPhone: customer.phone,
    customerName:  customer.name || null,
    serviceId:     service.serviceId,
    // Kept on the booking so messages, receipts and the calendar say "Haircut",
    // not "booking", even if the service is later renamed or switched off.
    serviceName:   service.name || null,
    unitId,
    startTime:     startIso,
    endTime:       endIso,
    status:        'confirmed',
    // totalAmount vs amountPaid drives the "collect the rest" flow. A deposit booking
    // pays part now (amountPaid < totalAmount = a balance is owed); full_prepaid/free
    // leave no balance.
    totalAmount:   payment?.memberDiscountPct ? fullPrice : (priced.price || 0),
    amountPaid:    charged ? amountDue : 0,
    depositPaid:   charged ? amountDue : 0,
    paymentId:     paymentId || null,
    paymentProvider: payment?.provider || null,
    providerOrderId: payment?.providerOrderId || null,
    // Connected PayPal business that received the money (refunds act on its behalf).
    payeeMerchantId: payment?.payeeMerchantId || null,
    currency:      payment?.currency || business.config?.currency || null,
    paymentStatus: covered ? 'membership' : !requiresPayment ? 'not_required' : (amountDue < fullPrice - 0.001 ? 'partial' : 'paid'),
    membershipId:  covered?.membershipId || null,
    membershipPlan: covered?.planName || null,
    memberDiscountPct: payment?.memberDiscountPct || null,
    platformFeeDue,
    platformFeeStatus: platformFeeDue > 0 ? 'accrued' : 'not_applicable',
    createdVia,
    customerNotes: notes || null,
    // Reference photo ids the customer sent (services/photos): the owner sees the picture.
    customerPhotos: Array.isArray(photos) && photos.length ? photos : null,
    // Lets later events (refund webhooks, owner actions) join the same timeline.
    traceScope:    trace.currentScope(),
    queuePosition: queueInfo?.position ?? null,
    queueToken:    queueInfo?.tokenNumber ?? null
  }

  const result = await createAppointment(appointment)
  trace.event('db', result.created ? 'Booking written to DynamoDB' : 'Duplicate payment id — existing booking kept', {
    booking: trace.short(appointment.appointmentId), service: service.name, unit: unitId, start: startIso,
    paymentStatus: appointment.paymentStatus, paid: appointment.amountPaid
  })
  if (!result.created) {
    log.warn('booking_duplicate_payment_id', { paymentId, businessId: business.businessId })
    return { ...appointment, duplicate: true }
  }

  if (service.unitType !== 'queue') {
    await redis.releaseSlot(business.businessId, startIso, unitId)
  }

  return appointment
}

module.exports = { getAvailability, createBooking, getService, whyNotBookable }
