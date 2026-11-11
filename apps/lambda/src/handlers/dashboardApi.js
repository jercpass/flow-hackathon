'use strict'

const dayjs = require('dayjs')
const { randomUUID: uuid } = require('crypto')
const { extractAuth } = require('../utils/jwt')
const { respond } = require('../utils/response')
const { getBusiness, updateBusiness } = require('../services/dynamo/businesses')
const { getAppointmentsForBusiness, updateAppointment, createAppointment } = require('../services/dynamo/appointments')
const { getFreeUnitsForSlot } = require('../core/units')
const { getCustomer } = require('../services/dynamo/customers')
const { ingestDocument, clearBusinessKnowledge, query: ragQuery } = require('../services/rag')
const { generateConfig, getRecommendations } = require('../services/setupAi')
const { routeMessage } = require('../services/aiRouter')
const redis = require('../services/redis')
const { originOf, movedByOf } = require('../core/ownerOps')
const { providerIdFor } = require('../services/payments')
const paypal = require('../services/payments/paypal')
const { isEnabled, publicConfig } = require('../config/edition')
const { currencyOf } = require('../utils/money')
const { requestBalancePayment } = require('../core/paymentFlow')
const log = require('../utils/logger')

// Dashboard routes that belong to one edition only (see config/edition.js).
const ROUTE_FEATURES = [
  [/^payments\/paypal\//,    null,   'paypal']
]
function routeFeature(path, method) {
  const hit = ROUTE_FEATURES.find(([re, m]) => re.test(path) && (!m || m === method))
  return hit ? hit[2] : null
}

exports.handler = async (event) => {
  if (event?.warm) return { warm: true }   // keep-warm ping (serverless.yml custom.warm)
  if (event.httpMethod === 'OPTIONS') return respond(200, {})
  const auth = extractAuth(event)
  // Demo owner tokens die with their session, and the owner's actions join the
  // session's "Under the hood" timeline next to the customer's.
  if (auth?.demoSid) {
    const live = await require('../core/demoSession').getActiveSession(auth.demoSid)
    if (!live) return respond(401, { error: 'Demo session ended', ended: true })
    const trace = require('../services/trace')
    return trace.run(`sess:${auth.demoSid}`, () => trace.forBusiness({ businessId: auth.businessId }, () => handle(event, auth)))
  }
  return handle(event, auth)
}

async function handle(event, auth) {
  if (!auth) return respond(401, { error: 'Unauthorized' })

  const { businessId } = auth
  const method = event.httpMethod
  const path = event.pathParameters?.proxy || ''
  const body = event.body ? JSON.parse(event.body) : {}
  const query = event.queryStringParameters || {}

  const feature = routeFeature(path, method)
  if (feature && !isEnabled(feature)) return respond(404, { error: 'Not available in this edition' })

  try {
    if (path === 'stats' && method === 'GET') return await getStats(businessId)
    if (path === 'bookings' && method === 'GET') return await getBookings(businessId, query)
    if (path === 'bookings' && method === 'PATCH') return await patchBooking(businessId, body)
    if (path === 'bookings/request-balance' && method === 'POST') return await requestBalance(businessId, body)
    if (path === 'bookings/cancel' && method === 'POST') return await cancelBookingRoute(businessId, body)
    if (path === 'bookings/refund-requests' && method === 'GET') return respond(200, await require('../core/refundRequests').listOpen(await getBusiness(businessId)))
    if (path === 'bookings/refund' && method === 'POST') return await refundRoute(businessId, body)
    if (path === 'bookings/refund-request/decline' && method === 'POST') return await declineRefundRoute(businessId, body)
    if (path === 'calendar/booking' && method === 'POST') return await manualBooking(businessId, body)
    if (path === 'calendar/block' && method === 'POST') return await blockTime(businessId, body)
    if (path === 'calendar/events' && method === 'GET') return respond(200, await require('../core/ownerOps').calendar(await getBusiness(businessId), { from_date: query.from, to_date: query.to }))
    if (path === 'calendar/move' && method === 'POST') return await moveBooking(businessId, body)
    if (path.startsWith('disputes')) return await disputesRoute(businessId, path, method, body)
    if (path === 'services' && method === 'GET') return await getServices(businessId)
    if (path === 'services' && method === 'POST') return await addService(businessId, body)
    if (path === 'services' && method === 'PATCH') return await patchService(businessId, body)
    if (path === 'services' && method === 'DELETE') return await deleteService(businessId, body)
    if (path === 'staff' && method === 'GET') return await getStaff(businessId)
    if (path === 'staff' && method === 'POST') return await addStaff(businessId, body)
    if (path === 'staff' && method === 'PATCH') return await patchStaff(businessId, body)
    if (path === 'staff' && method === 'DELETE') return await deleteStaff(businessId, body)
    if (path === 'resources' && method === 'GET') return await getResources(businessId)
    if (path === 'resources' && method === 'POST') return await addResource(businessId, body)
    if (path === 'resources' && method === 'DELETE') return await deleteResource(businessId, body)
    if (path === 'settings' && method === 'GET') return await getSettings(businessId)
    if (path === 'settings' && method === 'PATCH') return await patchSettings(businessId, body)
    if (path === 'config' && method === 'GET') return respond(200, publicConfig())
    if (path === 'trace' && method === 'GET') return await getTrace(businessId, query, auth)
    if (path === 'payments' && method === 'GET') return await getPaymentStatus(businessId)
    if (path === 'payments/paypal/connect' && method === 'POST') return await paypalConnect(businessId)
    if (path === 'payments/paypal/complete' && method === 'POST') return await paypalComplete(businessId, body)
    if (path === 'payments/paypal/demo' && method === 'POST') return await paypalUseDemo(businessId)
    if (path === 'payments/paypal/disconnect' && method === 'POST') return await paypalDisconnect(businessId)
    if (path === 'setup/suggest' && method === 'POST') return await setupSuggest(businessId, body)
    if (path === 'setup/suggestions' && method === 'GET') return suggestServices(query)
    if (path === 'setup/apply' && method === 'POST') return await setupApply(businessId, body)
    if (path === 'setup/recommendation' && method === 'POST') return await applyRecommendation(businessId, body)
    if (path === 'recommendations' && method === 'GET') return await getRecs(businessId)
    if (path === 'test-chat' && method === 'POST') return await testChat(businessId, body)
    if (path === 'knowledge/text' && method === 'POST') return await addKnowledgeText(businessId, body)
    if (path === 'knowledge' && method === 'GET') return respond(200, { documents: await require('../services/rag').listDocuments(businessId) })
    if (path === 'knowledge/ask' && method === 'POST') return await askKnowledge(businessId, body)
    if (path === 'knowledge/preview' && method === 'POST') return await previewKnowledge(body)
    if (path === 'knowledge/remove' && method === 'POST') return await removeKnowledgeDoc(businessId, body)
    if (path === 'knowledge' && method === 'POST') return await uploadKnowledge(businessId, body)
    if (path === 'knowledge' && method === 'DELETE') return await clearKnowledge(businessId)
    if (path === 'memberships' && method === 'GET') return respond(200, await require('../core/memberships').overview(await getBusiness(businessId)))
    if (path === 'memberships' && method === 'POST') return memberResult(await require('../core/memberships').createPlan(await getBusiness(businessId), { ...body, confirm: true }))
    if (path === 'memberships' && method === 'PATCH') return memberResult(await require('../core/memberships').updatePlan(await getBusiness(businessId), { ...body, confirm: true }))
    if (path === 'memberships/cancel-member' && method === 'POST') return memberResult(await require('../core/memberships').cancelMember(await getBusiness(businessId), { ...body, confirm: true }))
    return respond(404, { error: 'Not found' })
  } catch (err) {
    log.error('dashboard_api_error', err, { businessId, path, method })
    return respond(500, { error: 'Internal error' })
  }
}

// ── Stats ───────────────────────────────────────────────────────────────────

// Overview numbers in the BUSINESS's day (not the server's): today, the last 7
// days, money in/out, and the next bookings with names (not ids).
async function getStats(businessId) {
  const { dayjs: tzDayjs, tzOf, fmtLocal } = require('../utils/time')
  const biz = await getBusiness(businessId)
  const tz = tzOf(biz)
  const now = tzDayjs().tz(tz)
  const today = now.startOf('day')
  const weekAgo = today.subtract(7, 'day')
  const horizon = today.add(14, 'day').endOf('day')

  const appts = (await getAppointmentsForBusiness(businessId, weekAgo.toISOString(), horizon.toISOString())).filter(a => a.status !== 'blocked')
  const live = appts.filter(a => a.status !== 'cancelled')
  const inWeek = a => a.startTime >= weekAgo.toISOString() && a.startTime <= now.endOf('day').toISOString()
  const isToday = a => a.startTime >= today.toISOString() && a.startTime <= today.endOf('day').toISOString()
  const realMoney = a => a.paymentProvider !== 'demo'
  const svcName = a => a.serviceName || (biz.config.services || []).find(s => s.serviceId === a.serviceId)?.name || a.serviceId
  const staff = a => (biz.config.staff || []).find(s => s.staffId === a.unitId)?.name || null

  return respond(200, {
    timezone: tz,
    currency: biz.config?.currency || 'USD',
    impact: await impactOf(businessId, today),
    todayBookings: live.filter(isToday).length,
    weekBookings: live.filter(inWeek).length,
    // Money collected for bookings in the last 7 days + upcoming, net of refunds.
    // Made-up money (a sample without a real pool payment) was never collected.
    weekRevenue: Math.round(appts.filter(realMoney).reduce((s, a) => s + Number(a.amountPaid || 0) - Number(a.refundAmount || 0), 0) * 100) / 100,
    weekRefunds: Math.round(appts.filter(realMoney).reduce((s, a) => s + Number(a.refundAmount || 0), 0) * 100) / 100,
    weekCancelled: appts.filter(a => a.status === 'cancelled' && inWeek(a)).length,
    upcoming: live
      .filter(a => a.startTime >= new Date().toISOString())
      .sort((x, y) => x.startTime.localeCompare(y.startTime))
      .slice(0, 6)
      .map(a => ({
        startTime: a.startTime, when: fmtLocal(a.startTime, tz), service: svcName(a), staff: staff(a),
        customerName: a.customerName || null, status: a.status, paid: a.amountPaid || 0, channel: originOf(a), moved: movedByOf(a), notes: a.customerNotes || null
      }))
  })
}

// "What Flow did for you" on the Overview:
// the business's own numbers for the last 30 days and the next 30, never a
// made-up estimate. The demo customer's invented visit history is left out.
const SELF_SERVE = new Set(['web', 'speaker', 'mcp', 'voice', 'whatsapp'])
async function impactOf(businessId, today) {
  const appts = (await getAppointmentsForBusiness(businessId, today.subtract(30, 'day').toISOString(), today.add(30, 'day').endOf('day').toISOString()))
    .filter(a => a.status !== 'blocked' && !(a.seeded && !a.seededOther))
  // Through PayPal, sample bookings' real pool payments included.
  const viaPayPal = a => require('../core/refundRequests').paidThroughPayPal(a)
  const round = n => Math.round(n * 100) / 100
  return {
    days: 30,
    // Booked by the customer's own chat, voice or AI agent: no phone call, no front desk.
    bookedWithoutYou: appts.filter(a => SELF_SERVE.has(a.bookedVia || a.createdVia)).length,
    // Money already in through PayPal before the visit happens.
    paidUpfront: round(appts.filter(viaPayPal).reduce((s, a) => s + Number(a.amountPaid || 0) - Number(a.refundAmount || 0), 0)),
    // Late cancellations and no-shows: what the policy kept instead of an empty chair.
    keptByPolicy: round(appts.filter(a => viaPayPal(a) && (a.status === 'cancelled' || a.status === 'no_show')).reduce((s, a) => s + Math.max(0, Number(a.amountPaid || 0) - Number(a.refundAmount || 0)), 0)),
    noShows: appts.filter(a => a.status === 'no_show').length
  }
}

// Calendar drag-and-drop: move a booking to a new time and/or staff member.
// Validated like any reschedule (staff must do the service and be free); the
// customer gets a message in their inbox. Times arrive as business-local wall-clock strings.

// Disputes (core/disputes, PAYPAL_GAPS.md §4): the owner's page. PayPal errors
// come back as a plain message rather than a 500.
async function disputesRoute(businessId, path, method, body) {
  const disputes = require('../core/disputes')
  const business = await getBusiness(businessId)
  if (!business) return respond(404, { error: 'Business not found' })
  try {
    if (path === 'disputes' && method === 'GET') return respond(200, { disputes: await disputes.list(business), sandbox: (process.env.PAYPAL_ENV || 'sandbox') === 'sandbox' })
    const id = String(body.disputeId || '')
    if (path === 'disputes/draft' && method === 'POST') return disputeOut(await disputes.draft(business, id))
    if (path === 'disputes/send' && method === 'POST') return disputeOut(await disputes.send(business, id, { note: body.note, confirm: !!body.confirm }))
    if (path === 'disputes/accept' && method === 'POST') return disputeOut(await disputes.accept(business, id, { note: body.note, confirm: !!body.confirm }))
    if (path === 'disputes/sandbox' && method === 'POST') return disputeOut(await disputes.sandbox(business, id, String(body.action || '')))
    if (path === 'disputes/practice' && method === 'POST') return disputeOut(await disputes.practice(business, String(body.bookingId || '')))
    return respond(404, { error: 'Not found' })
  } catch (err) {
    log.warn('dispute_route_failed', { path, err: err.message, code: err.code })
    return respond(502, { error: `PayPal didn't accept that (${err.code || 'error'}). Nothing changed.` })
  }
}
const disputeOut = r => respond(r?.error ? 400 : 200, r)

async function moveBooking(businessId, body) {
  const biz = await getBusiness(businessId)
  const r = await require('../core/ownerOps').rescheduleBooking(biz, { booking_id: body.bookingId, new_time: body.startLocal, unit_id: body.resourceId })
  return r.error ? respond(409, { error: r.error }) : respond(200, r)
}

// ── Bookings ────────────────────────────────────────────────────────────────

async function getBookings(businessId, query) {
  const from = query.from || dayjs().startOf('day').toISOString()
  const to = query.to || dayjs().add(7, 'day').endOf('day').toISOString()
  const appts = await getAppointmentsForBusiness(businessId, from, to)

  const biz = await getBusiness(businessId)
  return respond(200, {
    // The list shows times in the salon's time zone, like the calendar.
    timezone: require('../utils/time').tzOf(biz),
    bookings: appts.map(a => ({
      appointmentId: a.appointmentId,
      startTime: a.startTime,
      endTime: a.endTime,
      service: a.serviceName || biz.config.services.find(s => s.serviceId === a.serviceId)?.name || a.serviceId,
      serviceId: a.serviceId,
      unitId: a.unitId,
      blocked: a.status === 'blocked',
      createdVia: a.createdVia,
      customerPhone: a.customerPhone,
      customerName: a.customerName,
      status: a.status,
      amountPaid: a.amountPaid,
      totalAmount: a.totalAmount,
      balanceDue: Math.max(0, Math.round(((a.totalAmount || 0) - (a.amountPaid || 0)) * 100) / 100),
      customerNotes: a.customerNotes || null,
      refundAmount: a.refundAmount || 0,
      // Paid through PayPal, so the page can offer a refund without cancelling.
      paidWithPayPal: require('../core/refundRequests').paidWithPayPal(a) && !a.membershipId,
      // A refund the customer asked for (core/refundRequests).
      refundRequest: a.refundRequest || null,
      // The booking's PayPal invoice.
      invoiceNumber: a.invoiceNumber || null,
      invoiceStatus: a.invoiceStatus || null,
      invoicerUrl: a.invoicerUrl || null,
      invoiceError: a.invoiceError || null,
      // For the PayPal ledger (Payments page): who, how and when money moved.
      staff: (biz.config.staff || []).find(s => s.staffId === a.unitId)?.name || null,
      paymentId: a.paymentId && !String(a.paymentId).startsWith('hist-') ? a.paymentId : null,
      // The demo customer's made-up visit history was never charged anywhere.
      paidWith: a.seeded && Number(a.amountPaid) > 0 && !a.samplePayment ? (a.seededOther ? 'demo' : 'demo_history')
        : a.membershipId || String(a.paymentId || '').startsWith('membership:') ? 'membership'
        : require('../core/refundRequests').paidThroughPayPal(a) ? 'paypal' : Number(a.amountPaid) > 0 ? 'in_person' : null,
      paidUnder: a.paidUnder || null,
      createdAt: a.createdAt || null,
      refundedAt: a.refundedAt || null,
      refundStatus: a.refundStatus || null,
      rescheduledFrom: a.rescheduledFrom || null,
      seeded: !!a.seeded,
      // A sample booking's real PayPal payment, shared by every demo session: read-only.
      samplePayment: !!a.samplePayment
    }))
  })
}

// Memberships: the page has its own confirm step, so it calls with confirm=true.
function memberResult(r) {
  return r?.error ? respond(400, { error: r.error }) : respond(200, r)
}

// Attendance only (came = completed, didn't come = no_show, back to not marked
// = confirmed). Cancelling goes through bookings/cancel: refund by policy, free
// the seat, give a membership use back, tell the customer in their inbox.
const BOOKING_STATUSES = new Set(['confirmed', 'completed', 'no_show'])

// Same code as the owner's MCP cancel_booking (core/ownerOps). Without confirm
// it returns the refund quote (policy / full / none) for the page to show.
async function cancelBookingRoute(businessId, body) {
  const { appointmentId, refund = 'policy', reason, confirm } = body
  if (!appointmentId) return respond(400, { error: 'appointmentId required' })
  if (!['policy', 'full', 'none'].includes(refund)) return respond(400, { error: 'refund must be policy, full or none' })
  const r = await require('../core/ownerOps').cancelBooking(await getBusiness(businessId), { booking_id: appointmentId, refund, reason, confirm: !!confirm })
  return r.error ? respond(400, r) : respond(200, r)
}

// Refund part or all without cancelling: the same code as the owner's MCP
// refund_booking. Without confirm it returns the quote for the page to show.
async function refundRoute(businessId, body) {
  const { appointmentId, amount, reason, confirm } = body
  if (!appointmentId) return respond(400, { error: 'appointmentId required' })
  const r = await require('../core/ownerOps').refundBooking(await getBusiness(businessId), { booking_id: appointmentId, amount: amount == null ? undefined : Number(amount), reason, confirm: !!confirm })
  return r.error ? respond(400, r) : respond(200, r)
}

// Say no to a customer's refund request (core/refundRequests): they're told in their inbox.
async function declineRefundRoute(businessId, body) {
  if (!body.appointmentId) return respond(400, { error: 'appointmentId required' })
  const r = await require('../core/refundRequests').decline(await getBusiness(businessId), { booking_id: body.appointmentId, reason: body.reason })
  return r.error ? respond(400, r) : respond(200, r)
}

async function patchBooking(businessId, body) {
  const { startTime, appointmentId, status } = body
  if (!startTime || !appointmentId || !status) return respond(400, { error: 'startTime, appointmentId, and status required' })
  if (status === 'cancelled') return respond(400, { error: 'Use bookings/cancel: it refunds by your policy and tells the customer.' })
  if (!BOOKING_STATUSES.has(status)) return respond(400, { error: 'status must be confirmed, completed or no_show' })
  await updateAppointment(businessId, startTime, appointmentId, { status, ...(status === 'completed' || status === 'no_show' ? { attendanceMarkedAt: new Date().toISOString() } : {}) })
  return respond(200, { updated: true, status })
}

// ── Owner-managed calendar (Flow-native) ────────────────────────────────────
// Manual/walk-in bookings and time blocks the owner enters by hand. Both write an
// appointment so the AI's live availability stays truthful — a slot the owner
// filled in person can never be double-booked by the assistant.

// The owner types wall-clock times ("11:00") for the salon, so a time without
// a zone is read in the business's time zone, not the server's.
function ownerTime(value, biz) {
  const { tzOf, toUtcIso } = require('../utils/time')
  return toUtcIso(value, tzOf(biz))
}

async function manualBooking(businessId, body) {
  const biz = await getBusiness(businessId)
  const { serviceId, staffId, customerName, customerPhone, markPaid } = body
  const svc = (biz.config.services || []).find(s => s.serviceId === serviceId)
  if (!svc) return respond(400, { error: 'Unknown service' })
  const startTime = ownerTime(body.startTime, biz)
  if (!startTime) return respond(400, { error: 'startTime required' })
  // Same code as the owner's MCP add_booking (core/ownerManage).
  const r = await require('../core/ownerManage').createManualBooking(biz, { svc, staffId, startIso: startTime, customerName, customerPhone, markPaid })
  if (r.error) return respond(r.status || 400, { error: r.error })
  return respond(200, { booked: true, appointmentId: r.appt.appointmentId })
}

async function blockTime(businessId, body) {
  const biz = await getBusiness(businessId)
  const { unitId, label } = body
  const startTime = ownerTime(body.startTime, biz)
  const endTime = ownerTime(body.endTime, biz)
  if (!startTime || !endTime) return respond(400, { error: 'startTime and endTime required' })
  if (endTime <= startTime) return respond(400, { error: 'The end has to be after the start.' })

  // A specific unit, or every staff + resource (a whole-business block).
  let units = (unitId && unitId !== 'all')
    ? [unitId]
    : [...(biz.config.staff || []).map(s => s.staffId), ...(biz.config.resources || []).map(r => r.resourceId)]
  if (!units.length) units = ['__business__']

  let count = 0
  for (const u of units) {
    await createAppointment({
      appointmentId: uuid(), businessId, customerId: null,
      customerName: label || 'Blocked', serviceName: label || 'Blocked',
      unitId: u, startTime, endTime, status: 'blocked', createdVia: 'manual_block'
    })
    count++
  }
  return respond(200, { blocked: true, count })
}

async function findAppointment(businessId, startTime, appointmentId) {
  const from = dayjs(startTime).startOf('day').toISOString()
  const to = dayjs(startTime).endOf('day').toISOString()
  const all = await getAppointmentsForBusiness(businessId, from, to)
  return all.find(a => a.appointmentId === appointmentId) || null
}

// "Collect the rest" — owner triggers collection of the balance on a deposit
// booking. Money routes to the business via Easy Split (same 1.5% cut); on
// payment the webhook marks the booking fully paid.
async function requestBalance(businessId, body) {
  const { appointmentId, startTime } = body
  if (!appointmentId || !startTime) return respond(400, { error: 'appointmentId and startTime required' })

  const biz = await getBusiness(businessId)
  const appt = await findAppointment(businessId, startTime, appointmentId)
  if (!appt) return respond(404, { error: 'Booking not found' })

  const balance = Math.round(((appt.totalAmount || 0) - (appt.amountPaid || 0)) * 100) / 100
  if (balance <= 0) return respond(400, { error: 'No balance due on this booking' })
  if (appt.seeded) return respond(400, { error: 'This is a made-up demo booking, so there is no real customer to send a PayPal link to.' })

  // PayPal: checkout link sent to the customer's inbox.
  const provider = require('../services/payments').getPaymentProvider(biz)
  if (!provider.isConfigured(biz)) return respond(400, { error: 'Connect PayPal before collecting balances' })
  const service = (biz.config.services || []).find(s => s.serviceId === appt.serviceId)
  const customer = appt.customerId ? await getCustomer(appt.customerId) : null
  if (!require('../services/demoInbox').customerInbox(customer)) return respond(400, { error: 'This customer has no Flow inbox (a walk-in you added), so the PayPal link can\'t be sent.' })
  const r = await requestBalancePayment({ business: biz, appointment: appt, customer, serviceName: service?.name || appt.serviceName || 'your booking', balance })
  return respond(200, { sent: true, balance, currency: r.currency, payUrl: r.paymentUrl })
}

// ── Services ────────────────────────────────────────────────────────────────

async function getServices(businessId) {
  const biz = await getBusiness(businessId)
  return respond(200, { services: biz.config.services || [] })
}

async function addService(businessId, body) {
  const biz = await getBusiness(businessId)
  const service = {
    serviceId: uuid(),
    name: body.name,
    price: body.price || 0,
    duration: body.duration || 30,
    // durationMode is REQUIRED by the slot engine — without it resolveDurationMinutes
    // returns null and the service generates zero slots. Default to 'fixed'.
    durationMode: body.durationMode || 'fixed',
    bufferAfterMins: body.bufferAfterMins || 0,
    unitType: body.unitType || 'person',
    // Priced services are paid when booking; "none" only when it's free.
    paymentMode: Number(body.price) > 0 && (!body.paymentMode || body.paymentMode === 'none') ? 'full_prepaid' : (body.paymentMode || 'none'),
    // Optional per-service hours override; null = use the business-wide hours.
    availability: body.availability || null,
    active: true
  }
  biz.config.services = [...(biz.config.services || []), service]
  // A staff-booked service is only bookable once someone does it, so the form
  // says who (everyone by default).
  if (service.unitType === 'person') biz.config.staff = assignStaff(biz.config.staff, service.serviceId, body.staffIds)
  await updateBusiness(businessId, { config: biz.config })
  await redis.invalidateBusiness(businessId)
  return respond(201, { service })
}

// Give a service to exactly these staff (all staff when staffIds is missing).
function assignStaff(staff = [], serviceId, staffIds) {
  const who = Array.isArray(staffIds) ? new Set(staffIds) : null
  return staff.map(p => {
    const has = (p.services || []).includes(serviceId)
    const should = who ? who.has(p.staffId) : true
    if (has === should) return p
    return { ...p, services: should ? [...(p.services || []), serviceId] : (p.services || []).filter(id => id !== serviceId) }
  })
}

async function patchService(businessId, body) {
  const { serviceId, staffIds, ...updates } = body
  if (!serviceId) return respond(400, { error: 'serviceId required' })
  const biz = await getBusiness(businessId)
  const idx = biz.config.services.findIndex(s => s.serviceId === serviceId)
  if (idx === -1) return respond(404, { error: 'Service not found' })
  biz.config.services[idx] = { ...biz.config.services[idx], ...updates }
  // The edit form says who does it (staff-booked services only).
  if (Array.isArray(staffIds) && biz.config.services[idx].unitType === 'person') biz.config.staff = assignStaff(biz.config.staff, serviceId, staffIds)
  await updateBusiness(businessId, { config: biz.config })
  await redis.invalidateBusiness(businessId)
  return respond(200, { service: biz.config.services[idx] })
}

async function deleteService(businessId, body) {
  const { serviceId } = body
  if (!serviceId) return respond(400, { error: 'serviceId required' })
  const biz = await getBusiness(businessId)
  biz.config.services = biz.config.services.filter(s => s.serviceId !== serviceId)
  // Nobody does a deleted service any more.
  biz.config.staff = (biz.config.staff || []).map(p => ({ ...p, services: (p.services || []).filter(id => id !== serviceId) }))
  await updateBusiness(businessId, { config: biz.config })
  await redis.invalidateBusiness(businessId)
  return respond(200, { deleted: true })
}

// ── Staff (units for `person` services) ─────────────────────────────────────
// A `person` service is bookable only if at least one staff member lists it in
// their `services`. resolveUnitCandidates (core/units.js) reads config.staff.

async function getStaff(businessId) {
  const biz = await getBusiness(businessId)
  return respond(200, { staff: biz.config.staff || [] })
}

async function addStaff(businessId, body) {
  if (!body.name) return respond(400, { error: 'Name required' })
  const biz = await getBusiness(businessId)
  const member = { staffId: uuid(), name: body.name, services: body.services || [] }
  biz.config.staff = [...(biz.config.staff || []), member]
  await updateBusiness(businessId, { config: biz.config })
  await redis.invalidateBusiness(businessId)
  return respond(201, { staff: member })
}

async function patchStaff(businessId, body) {
  const { staffId, ...updates } = body
  if (!staffId) return respond(400, { error: 'staffId required' })
  const biz = await getBusiness(businessId)
  const idx = (biz.config.staff || []).findIndex(s => s.staffId === staffId)
  if (idx === -1) return respond(404, { error: 'Staff not found' })
  biz.config.staff[idx] = { ...biz.config.staff[idx], ...updates }
  await updateBusiness(businessId, { config: biz.config })
  await redis.invalidateBusiness(businessId)
  return respond(200, { staff: biz.config.staff[idx] })
}

async function deleteStaff(businessId, body) {
  if (!body.staffId) return respond(400, { error: 'staffId required' })
  const biz = await getBusiness(businessId)
  biz.config.staff = (biz.config.staff || []).filter(s => s.staffId !== body.staffId)
  await updateBusiness(businessId, { config: biz.config })
  await redis.invalidateBusiness(businessId)
  return respond(200, { deleted: true })
}

// ── Resources (units for `resource` services) ───────────────────────────────
// `resource` services fall back to ALL business resources when the service
// doesn't scope to specific ones (core/units.js resolveUnitCandidates). For a
// gaming café with N identical stations, just add N resources.

async function getResources(businessId) {
  const biz = await getBusiness(businessId)
  return respond(200, { resources: biz.config.resources || [] })
}

async function addResource(businessId, body) {
  if (!body.name) return respond(400, { error: 'Name required' })
  const biz = await getBusiness(businessId)
  const resource = { resourceId: uuid(), name: body.name }
  biz.config.resources = [...(biz.config.resources || []), resource]
  await updateBusiness(businessId, { config: biz.config })
  await redis.invalidateBusiness(businessId)
  return respond(201, { resource })
}

async function deleteResource(businessId, body) {
  if (!body.resourceId) return respond(400, { error: 'resourceId required' })
  const biz = await getBusiness(businessId)
  biz.config.resources = (biz.config.resources || []).filter(r => r.resourceId !== body.resourceId)
  await updateBusiness(businessId, { config: biz.config })
  await redis.invalidateBusiness(businessId)
  return respond(200, { deleted: true })
}

// ── Settings ────────────────────────────────────────────────────────────────

// What the AI must collect from a customer before confirming a booking. Name +
// phone are mandatory and fixed; phone defaults to the WhatsApp number they're
// messaging from (allowPreferred lets them give another). Custom fields are
// optional. Flow collects no email addresses. (Future channels — LINE/Instagram IDs — see ROADMAP.)
function defaultRequiredDetails() {
  return [
    { key: 'name',  label: 'Name',         required: true,  fixed: true },
    { key: 'phone', label: 'Phone number', required: true,  fixed: true, allowPreferred: true }
  ]
}

// Clean the refund-tier schedule from the dashboard: keep only valid
// {hoursBefore≥0, refundPct 0–100} rows, de-dupe by window, sort widest-window
// first, cap at 5 tiers. Each tier means "cancel at least hoursBefore in advance
// → refund refundPct of what was paid".
function sanitizeRefundTiers(tiers) {
  if (!Array.isArray(tiers)) return []
  const seen = new Set()
  return tiers
    .map(t => ({ hoursBefore: Number(t?.hoursBefore), refundPct: Number(t?.refundPct) }))
    .filter(t => Number.isFinite(t.hoursBefore) && t.hoursBefore >= 0
              && Number.isFinite(t.refundPct) && t.refundPct >= 0 && t.refundPct <= 100)
    .filter(t => (seen.has(t.hoursBefore) ? false : seen.add(t.hoursBefore)))
    .sort((a, b) => b.hoursBefore - a.hoursBefore)
    .slice(0, 5)
}

async function getSettings(businessId) {
  const biz = await getBusiness(businessId)
  return respond(200, {
    name: biz.name,
    type: biz.type,
    ownerPhone: biz.ownerPhone,
    availability: biz.config.availability,
    bookingLimits: biz.config.bookingLimits || null,
    requiredDetails: biz.config.requiredDetails || defaultRequiredDetails(),
    policies: biz.config.policies || { cancellation: '', reschedule: '', refundTiers: [] },
    ai_config: biz.config.ai_config,
    edition: publicConfig().edition,
    currency: currencyOf(biz),
    paymentProvider: providerIdFor(biz),
    // Its own PayPal, or Flow's demo sandbox account (both take payments and refunds).
    paypalConnected: !!(biz.paypalMerchantId || biz.paypalDemo),
    // A business the judge added on the map (core/addedBusiness): its setup page is /dashboard/added.
    addedByJudge: !!biz.addedByJudge,
    paymentsReady: paypal.isConfigured(biz),
    servicesCount: (biz.config.services || []).filter(s => s.active).length,
    status: biz.status || 'onboarding'
  })
}

async function patchSettings(businessId, body) {
  const biz = await getBusiness(businessId)
  const updates = {}
  if (body.name) updates.name = body.name
  if (body.ownerPhone) updates.ownerPhone = body.ownerPhone
  if (body.availability) {
    biz.config.availability = body.availability
    updates.config = biz.config
  }
  if (body.ai_config) {
    biz.config.ai_config = { ...biz.config.ai_config, ...body.ai_config }
    updates.config = biz.config
  }
  if (body.bookingLimits !== undefined) {
    // null/0 max = no limit; otherwise { period: 'day'|'week'|'month', max: N }
    biz.config.bookingLimits = body.bookingLimits
    updates.config = biz.config
  }
  if (Array.isArray(body.requiredDetails)) {
    biz.config.requiredDetails = body.requiredDetails
    updates.config = biz.config
  }
  if (body.policies && typeof body.policies === 'object') {
    // Short, always-relevant rules — kept as structured config (overwritten, never
    // appended) and injected into the AI system prompt, NOT pushed into RAG where
    // edits would leave stale chunks. refundTiers is the precise cancellation-refund
    // schedule: each {hoursBefore, refundPct} = "cancel ≥ hoursBefore → refundPct%".
    biz.config.policies = {
      cancellation: String(body.policies.cancellation || '').slice(0, 600),
      reschedule:   String(body.policies.reschedule   || '').slice(0, 600),
      refundTiers:  sanitizeRefundTiers(body.policies.refundTiers)
    }
    updates.config = biz.config
  }
  await updateBusiness(businessId, updates)
  await redis.invalidateBusiness(businessId)
  return respond(200, { updated: true })
}

// ── Payments ────────────────────────────────────────────────────────────────

async function getPaymentStatus(businessId) {
  return respond(200, paypalStatus(await getBusiness(businessId)))
}

// ── PayPal (Flow) ────────────────────────────────────────────────────────
// "Connect PayPal": the owner links their own PayPal business account via PayPal's
// onboarding (Partner Referrals) and grants Flow PAYMENT + REFUND. Customer
// payments then land directly in their account. Sandbox without a connected
// account → payments go to the platform's sandbox account (demo mode).

function paypalStatus(biz) {
  const sandbox = process.env.PAYPAL_ENV !== 'live'
  return {
    provider: 'paypal',
    environment: sandbox ? 'sandbox' : 'live',
    platformReady: !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    connected: !!biz.paypalMerchantId || !!biz.paypalDemo,
    merchantId: biz.paypalMerchantId || null,
    email: biz.paypalEmail || null,
    canRefund: biz.paypalCanRefund !== false,
    connectedAt: biz.paypalConnectedAt || null,
    demoAccount: !!biz.paypalDemo,
    demoAvailable: require('../demo/templates').demoPaypalAvailable(),
    // What happens to a payment right now, in plain words for the dashboard.
    payoutTo: biz.paypalMerchantId ? 'your PayPal account' : biz.paypalDemo ? "Flow's demo sandbox account" : (sandbox ? "Flow's demo sandbox account (not chosen yet)" : 'nowhere — connect PayPal to take payments')
  }
}

async function paypalConnect(businessId) {
  const biz = await getBusiness(businessId)
  const returnUrl = `${process.env.DASHBOARD_URL}/dashboard/payments?paypal=return`
  try {
    const { url } = await paypal.createOnboardingLink({ businessId, returnUrl })
    return respond(200, { url })
  } catch (err) {
    log.error('paypal_onboarding_link_failed', err, { businessId })
    // PayPal only lets approved partners onboard other merchants (403 NOT_AUTHORIZED).
    if (err.status === 403 || err.code === 'NOT_AUTHORIZED') return respond(403, { error: 'Connecting your own PayPal account needs PayPal partner access, which this demo\'s PayPal app doesn\'t have yet. Use the demo sandbox account instead: payments, refunds, invoices and memberships all work there.', partnerAccessNeeded: true })
    return respond(502, { error: 'Could not start PayPal onboarding. Please try again.' })
  }
}

// PayPal redirects the owner back with ?merchantId={our tracking id}
// &merchantIdInPayPal=...&permissionsGranted=true&consentStatus=true. The page
// posts those here; we confirm with PayPal before trusting them.
async function paypalComplete(businessId, body) {
  const merchantId = String(body.merchantIdInPayPal || '').trim()
  if (!/^[A-Z0-9]{8,20}$/.test(merchantId)) return respond(400, { error: 'Missing PayPal merchant id' })
  if (body.merchantId && body.merchantId !== businessId) return respond(400, { error: 'This PayPal connection belongs to a different business' })
  if (String(body.permissionsGranted) === 'false') return respond(400, { error: 'PayPal permissions were not granted — please connect again and accept.' })

  let verified = null
  try {
    verified = await paypal.getMerchantStatus(merchantId)
  } catch (err) {
    log.warn('paypal_merchant_status_failed', { businessId, code: err.code })
    return respond(502, { error: 'Could not verify the PayPal account with PayPal. Please try again.' })
  }
  if (verified && verified.trackingId && verified.trackingId !== businessId) {
    return respond(400, { error: 'This PayPal connection belongs to a different business' })
  }
  // Without PAYPAL_PARTNER_MERCHANT_ID we can't query PayPal (sandbox convenience):
  // accept the redirect params, which only an owner who just finished onboarding has.
  const updates = {
    paymentProvider:   'paypal',
    paypalMerchantId:  merchantId,
    paypalEmail:       verified?.email || null,
    paypalCanRefund:   verified ? verified.canRefund : true,
    paypalReceivable:  verified ? verified.paymentsReceivable : true,
    paypalVerified:    !!verified,
    paypalDemo:        false,
    paypalConnectedAt: new Date().toISOString()
  }
  await updateBusiness(businessId, updates)
  await redis.invalidateBusiness(businessId)
  log.info('paypal_connected', { businessId, merchantId, verified: !!verified })
  return respond(200, paypalStatus({ ...(await getBusiness(businessId)), ...updates }))
}

// Sandbox shortcut for demos/judges: use the demo account, Flow's own sandbox
// Business account (demo/templates demoPaypal), without onboarding. Never in live.
async function paypalUseDemo(businessId) {
  const { demoPaypal, demoPaypalAvailable } = require('../demo/templates')
  if (!demoPaypalAvailable()) {
    return respond(400, { error: 'Demo PayPal account is only available in sandbox.' })
  }
  const updates = { ...demoPaypal(), paypalVerified: false, paypalConnectedAt: new Date().toISOString() }
  await updateBusiness(businessId, updates)
  await redis.invalidateBusiness(businessId)
  return respond(200, paypalStatus({ ...(await getBusiness(businessId)), ...updates }))
}

async function paypalDisconnect(businessId) {
  await updateBusiness(businessId, {
    paypalMerchantId: null, paypalEmail: null, paypalVerified: false, paypalDemo: false, paypalConnectedAt: null
  })
  await redis.invalidateBusiness(businessId)
  return respond(200, paypalStatus(await getBusiness(businessId)))
}

// ── AI setup assistant ───────────────────────────────────────────────────────

const SETUP_CALLS_PER_DAY = 15  // abuse guard — cap AI-setup generations per business/day

async function setupSuggest(businessId, body) {
  const used = await redis.incrSetupCount(businessId)
  if (used > SETUP_CALLS_PER_DAY) {
    return respond(429, { error: 'Setup limit reached for today. You can keep configuring manually.' })
  }
  const biz = await getBusiness(businessId)
  try {
    const config = await generateConfig({
      type:        biz.type,
      description: body.description,
      imageBase64: body.imageBase64,
      mimeType:    body.mimeType
    })
    return respond(200, { config })
  } catch (err) {
    log.error('setup_suggest_failed', err, { businessId })
    return respond(500, { error: 'Could not read that — try describing your services in a sentence or two.' })
  }
}

// Guided enrollment: suggested services per business type, so the owner picks
// instead of typing. Curated defaults (deterministic, no AI) — the owner adjusts
// prices and applies. Each carries a serviceId so setup/apply can store it as-is.
const TYPE_SUGGESTIONS = {
  salon:  [['Haircut',400,30],['Hair colour',1200,90],['Facial',800,45],['Beard trim',150,20],['Head massage',500,30],['Bridal package',5000,180]],
  spa:    [['Swedish massage',1500,60],['Deep tissue',1800,60],['Aroma facial',1200,45],['Body scrub',1600,60]],
  clinic: [['Consultation',500,15],['Follow-up',300,10],['Health check-up',1500,30]],
  gym:    [['Day pass',300,60],['Personal training',800,60],['Monthly membership',2000,0]],
  turf:   [['5-a-side (1 hour)',1000,60],['Full ground (1 hour)',2500,60]],
  gaming: [['PS5 station (1 hour)',150,60],['PC station (1 hour)',100,60],['Racing sim (1 hour)',250,60]],
  tutor:  [['1-hour session',600,60],['Demo class',0,30]],
  clinic_dental: [['Consultation',400,20],['Cleaning',1200,45],['Filling',1500,45]]
}
const RESOURCE_TYPES = new Set(['gym', 'turf', 'gaming'])

function suggestServices(query) {
  const type = String(query.type || '').toLowerCase()
  const rows = TYPE_SUGGESTIONS[type]
  if (!rows) return respond(200, { type, services: [] })
  const unitType = RESOURCE_TYPES.has(type) ? 'resource' : 'person'
  const services = rows.map(([name, price, duration]) => ({
    serviceId: uuid(), name, price, duration,
    durationMode: 'fixed', bufferAfterMins: 0, unitType, paymentMode: price > 0 ? 'full_prepaid' : 'none', active: true
  }))
  return respond(200, { type, services })
}

async function setupApply(businessId, body) {
  const { config } = body
  if (!config || !Array.isArray(config.services)) return respond(400, { error: 'A config with services is required' })
  const biz = await getBusiness(businessId)
  biz.config = {
    ...biz.config,
    services:     config.services,
    resources:    config.resources || biz.config.resources || [],
    staff:        config.staff || biz.config.staff || [],
    availability: config.availability || biz.config.availability,
    ai_config:    { ...biz.config.ai_config, ...config.ai_config }
  }
  await updateBusiness(businessId, { config: biz.config })
  await redis.invalidateBusiness(businessId)
  return respond(200, { applied: true, services: biz.config.services.length })
}

async function getRecs(businessId) {
  const biz = await getBusiness(businessId)
  return respond(200, { recommendations: getRecommendations(biz) })
}

async function applyRecommendation(businessId, body) {
  const biz = await getBusiness(businessId)
  if (body.id === 'deposit') {
    const amount = Number(body.amount) || 100
    biz.config.services = (biz.config.services || []).map(s =>
      (!s.paymentMode || s.paymentMode === 'none') && s.unitType !== 'queue'
        ? { ...s, paymentMode: 'deposit_fixed', depositAmount: amount }
        : s)
    await updateBusiness(businessId, { config: biz.config })
    await redis.invalidateBusiness(businessId)
    return respond(200, { applied: true })
  }
  return respond(400, { error: 'Unknown recommendation' })
}

// Live test sandbox — chat with the AI before going live. dryRun so booking tools
// simulate instead of creating real appointments / charging.
async function testChat(businessId, body) {
  const message = (body.message || '').trim()
  if (!message) return respond(400, { error: 'message required' })
  const biz = await getBusiness(businessId)
  // The documents' answer, when they have one (Claude reads them; see services/rag).
  const ragChunks = await ragQuery(businessId, message).catch(() => [])
  const ctx = { business: biz, customer: { customerId: 'test', businessId, phone: 'test', name: null }, dryRun: true, traceScope: require('../services/trace').currentScope() || `biz:${businessId}` }
  const { reply, toolEvents } = await routeMessage(biz, body.history || [], message, ragChunks, ctx)
  // If the simulated booking needed payment, tell the dashboard so it can show a
  // mock Pay Now sheet — a realistic dress rehearsal, nothing recorded or charged.
  const payEvent = (toolEvents || []).find(e => e.name === 'book_appointment' && e.result?.paymentRequired)
  return respond(200, {
    reply,
    sim: payEvent ? { paymentRequired: true, amount: payEvent.result.amount, service: payEvent.result.service || null } : undefined
  })
}

// "Under the hood" timeline for this business's test chat (and, later, its
// demo session). ?since=<sk> returns only newer events for cheap polling.
async function getTrace(businessId, query, auth) {
  const trace = require('../services/trace')
  const scope = auth?.demoSid ? `sess:${auth.demoSid}` : `biz:${businessId}`
  const events = await trace.read(scope, query.since || null, 200)
  return respond(200, { events, cursor: events.length ? events[events.length - 1].sk : (query.since || null) })
}

// Knowledge step: free-text answers to "what should I know?" → a document in the
// knowledge base (Claude's Files API), kept separate from the booking config.
async function addKnowledgeText(businessId, body) {
  const text = (body.text || '').trim()
  if (text.length < 10) return respond(400, { error: 'Add a bit more detail' })
  // A readable name in the documents list (the content hash keeps them apart).
  const name = `Notes, ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.txt`
  const result = await ingestDocument(businessId, Buffer.from(text, 'utf-8'), name, 'text/plain')
  return respond(result.error ? 400 : 200, result)
}

// ── Knowledge ───────────────────────────────────────────────────────────────

async function uploadKnowledge(businessId, body) {
  const { filename, contentType, fileBase64 } = body
  if (!filename || !fileBase64) return respond(400, { error: 'filename and fileBase64 required' })

  const buffer = Buffer.from(fileBase64, 'base64')
  if (buffer.length > 10 * 1024 * 1024) return respond(400, { error: 'File too large (max 10MB)' })

  try {
    const result = await ingestDocument(businessId, buffer, filename, contentType || 'application/octet-stream')
    return respond(result.error ? 400 : 200, result)
  } catch (err) {
    log.warn('knowledge_add_failed', { err: String(err.message).slice(0, 160) })
    return respond(503, { error: err.code === 'NO_CLAUDE' ? err.message : "Couldn't store that document just now (Claude didn't answer). Try again in a moment." })
  }
}

// Before saving: what the file becomes in Claude (format, pages, tokens per
// question) and the exact text, so the owner sees it first. Stores nothing.
async function previewKnowledge(body) {
  const { filename, contentType, fileBase64 } = body
  if (!filename || !fileBase64) return respond(400, { error: 'filename and fileBase64 required' })
  const buffer = Buffer.from(fileBase64, 'base64')
  if (buffer.length > 10 * 1024 * 1024) return respond(400, { error: 'File too large (max 10MB)' })
  try {
    const r = await require('../services/rag').describe(buffer, filename, contentType || 'application/octet-stream')
    return respond(r.error ? 400 : 200, r)
  } catch (err) {
    log.warn('knowledge_preview_failed', { err: String(err.message).slice(0, 160) })
    return respond(503, { error: "Couldn't read that file just now. Try again in a moment." })
  }
}

// "Test a question": the answer a customer asking this would get, with its sources.
async function askKnowledge(businessId, body) {
  const question = String(body.question || '').trim()
  if (question.length < 3) return respond(400, { error: 'Type a question a customer might ask.' })
  try {
    const biz = await getBusiness(businessId)
    const r = await require('../services/rag').ask(businessId, question, { businessName: biz?.name })
    return respond(200, { question, answer: r?.answer || null, sources: r?.sources || [], documents: r?.documents || 0, model: r ? require('../utils/modelName').modelName(r.model) : null })
  } catch (err) {
    log.warn('knowledge_ask_failed', { err: err.message })
    return respond(503, { error: "Claude couldn't read the documents just now. Try again in a moment." })
  }
}

// Remove one document (the page asks first).
async function removeKnowledgeDoc(businessId, body) {
  if (!body.sourceHash) return respond(400, { error: 'Which document?' })
  const removed = await require('../services/rag').removeDocument(businessId, String(body.sourceHash))
  return removed ? respond(200, { removed: true }) : respond(404, { error: 'That document is no longer there.' })
}

async function clearKnowledge(businessId) {
  await clearBusinessKnowledge(businessId)
  return respond(200, { cleared: true })
}

exports._ownerTime = ownerTime   // tests
