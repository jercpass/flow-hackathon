// @ts-check
'use strict'

// ─── Everything else an owner manages (owner MCP tools) ───────────────────────
// The dashboard actions that ownerOps (schedule, refunds) and ownerSetup
// (services, staff, hours, refunds) don't cover: walk-in and phone bookings,
// moving a booking to another stylist, completed / no-show, asking for the rest
// of a deposit, removing staff, business details, the knowledge base, and
// connecting PayPal. Same rule as the rest: anything that moves money, messages
// a customer or removes something is quoted first and needs confirm=true.

const { randomUUID: uuid } = require('crypto')
const { createAppointment, updateAppointment, getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const { updateBusiness } = require('../services/dynamo/businesses')
const { getCustomer } = require('../services/dynamo/customers')
const { getFreeUnitsForSlot } = require('./units')
const { sameName } = require('../services/setupAi')
const { formatMoney, round2, currencyOf } = require('../utils/money')
const { dayjs, tzOf, toUtcIso, fmtLocal } = require('../utils/time')
const redis = require('../services/redis')
const trace = require('../services/trace')
const owner = require('./ownerOps')
const { findService, setupView } = require('./ownerSetup')

const quote = (changes, message) => ({ needs_confirmation: true, changes, message: message || 'Tell the owner exactly this; if they agree, call again with the same arguments and confirm=true.' })
const findStaff = (business, name) => (business.config.staff || []).find(s => sameName(s.name, name)) || null

/**
 * A booking the owner takes in person or by phone. Shared with the dashboard's
 * calendar ("Add booking"): writes an appointment so the assistant never offers
 * that slot again.
 * @returns {Promise<{ appt?: any, error?: string, status?: number }>}
 */
async function createManualBooking(business, { svc, staffId, startIso, customerName, customerPhone, markPaid, createdVia = 'manual' }) {
  const endIso = new Date(new Date(startIso).getTime() + (svc.duration || 60) * 60_000).toISOString()
  let unitId = svc.serviceId
  if (svc.unitType !== 'queue') {
    const free = await getFreeUnitsForSlot(business, svc, startIso, endIso)
    if (staffId && !free.includes(staffId)) return { error: 'That staff member is not free at that time.', status: 409 }
    unitId = (staffId && free.includes(staffId)) ? staffId : free[0]
    if (!unitId) return { error: 'Nothing is free at that time.', status: 409 }
    const locked = await redis.reserveSlot(business.businessId, startIso, unitId, 'manual')
    if (!locked) return { error: 'That slot was just taken.', status: 409 }
  }
  const known = await knownCustomer(business, customerName)
  const appt = {
    appointmentId: uuid(), businessId: business.businessId, customerId: known?.customerId || null,
    customerName: known?.name || customerName || 'Walk-in', customerPhone: customerPhone || known?.phone || null,
    serviceId: svc.serviceId, serviceName: svc.name, unitId, startTime: startIso, endTime: endIso,
    status: 'confirmed', createdVia,
    totalAmount: svc.price || 0,
    amountPaid: markPaid ? (svc.price || 0) : 0,
    paymentStatus: markPaid ? 'paid' : 'not_required',
    currency: currencyOf(business)
  }
  await createAppointment(appt)
  const customerTold = known ? await tellCustomer(business, appt) : false
  return { appt, customerTold }
}

// A booking the owner adds for someone who has booked before ("John Doe") is
// theirs: they see it, can move or cancel it, and it counts in their history.
// Exact name only, so two different people are never merged by a guess.
async function knownCustomer(business, name) {
  const n = String(name || '').trim().toLowerCase()
  if (!n || n === 'walk-in') return null
  const past = await getAppointmentsForBusiness(business.businessId, dayjs().subtract(400, 'day').toISOString(), dayjs().add(60, 'day').toISOString())
  const hit = (past || []).find(a => a.customerId && String(a.customerName || '').trim().toLowerCase() === n)
  if (hit) return { customerId: hit.customerId, name: hit.customerName, phone: hit.customerPhone || null }
  // In a demo the session's customer (John) is a customer of every business in it,
  // even one John hasn't been to yet.
  if (!business.demoSessionId) return null
  const session = await require('./demoSession').getActiveSession(business.demoSessionId).catch(() => null)
  const sam = session?.customerId ? await getCustomer(session.customerId).catch(() => null) : null
  return sam && String(sam.name || '').trim().toLowerCase() === n ? { customerId: sam.customerId, name: sam.name, phone: sam.phone || null } : null
}

// The customer hears about a booking made for them, like any other change.
async function tellCustomer(business, appt) {
  try {
    const c = await getCustomer(appt.customerId)
    if (!require('../services/demoInbox').customerInbox(c)) return false
    const when = fmtLocal(appt.startTime, tzOf(business))
    const due = appt.amountPaid ? '' : ` ${formatMoney(appt.totalAmount || 0, appt.currency)} to pay at the salon.`
    const sent = await require('../services/notify').notifyCustomer({ business, customer: c, channel: 'inbox', kind: 'confirmation', subject: `Booked: ${appt.serviceName}, ${when}`, text: `${business.name} booked your ${appt.serviceName} for ${when}.${due}` })
    return Array.isArray(sent) ? sent.includes('inbox') : !!sent
  } catch {
    return false
  }
}

// Owners may book after hours on purpose, so it isn't refused: the AI is told to say so.
function outsideHours(business, svc, startIso, endIso) {
  const av = { ...business.config?.availability, ...svc.availability }
  if (!av.open || !av.close) return null
  const tz = tzOf(business)
  const start = dayjs(startIso).tz(tz), end = dayjs(endIso).tz(tz)
  const closedDay = av.workingDays && !av.workingDays.includes(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][start.day()])
  if (!closedDay && start.format('HH:mm') >= av.open && end.format('HH:mm') <= av.close && end.isSame(start, 'day')) return null
  const hours = closedDay ? `you're closed on ${start.format('dddd')}s` : `you're open ${av.open}–${av.close}`
  return `Outside your opening hours (${hours}). It's booked anyway; tell the owner.`
}

async function addBooking(business, { service_name, start_time, staff_name, customer_name, customer_phone, paid }) {
  const svc = findService(business, service_name)
  if (!svc) return { error: `No service called "${service_name}".` }
  const tz = tzOf(business)
  const startIso = toUtcIso(start_time, tz)
  if (!startIso) return { error: 'Give start_time as YYYY-MM-DDTHH:mm in business local time.' }
  let staffId
  if (staff_name) {
    const s = findStaff(business, staff_name)
    if (!s) return { error: `No staff member called ${staff_name}.` }
    if (!(s.services || []).includes(svc.serviceId)) return { error: `${s.name} doesn't do ${svc.name}.` }
    staffId = s.staffId
  }
  const r = await createManualBooking(business, { svc, staffId, startIso, customerName: customer_name, customerPhone: customer_phone, markPaid: !!paid, createdVia: 'mcp_owner' })
  if (r.error) return { error: r.error }
  trace.event('db', `Owner added a booking: ${svc.name}, ${fmtLocal(startIso, tz)}`, { customer: r.appt.customerName, paid: !!paid })
  const warning = outsideHours(business, svc, r.appt.startTime, r.appt.endTime)
  return { booked: true, ...owner.view(business, r.appt), payment: paid ? 'paid in person' : `${formatMoney(svc.price || 0)} to pay at the salon`, customer_notified: !!r.customerTold, ...(warning ? { warning } : {}) }
}

// Move to another time and/or another stylist (like dragging on the calendar).
async function moveBooking(business, { booking_id, new_time, staff_name }) {
  const a = await owner.findBooking(business, booking_id)
  if (!a || a.status === 'blocked') return { error: 'No booking with that id. Use get_schedule to find booking_id.' }
  let unit_id
  if (staff_name) {
    const s = findStaff(business, staff_name)
    if (!s) return { error: `No staff member called ${staff_name}.` }
    unit_id = s.staffId
  }
  if (!new_time && !unit_id) return { error: 'Give new_time, staff_name, or both.' }
  const time = new_time || dayjs(a.startTime).tz(tzOf(business)).format('YYYY-MM-DDTHH:mm')
  const r = await owner.rescheduleBooking(business, { booking_id, new_time: time, unit_id })
  const svc = r.rescheduled && business.config.services.find(x => x.serviceId === a.serviceId)
  const startIso = svc && toUtcIso(time, tzOf(business))
  const warning = startIso && outsideHours(business, svc, startIso, new Date(new Date(startIso).getTime() + (svc.duration || 60) * 60_000).toISOString())
  return warning ? { ...r, warning } : r
}

// Attendance in the owner's words: came / didn't come / not marked yet.
const STATUSES = {
  completed: 'completed', came: 'completed', attended: 'completed', showed_up: 'completed',
  no_show: 'no_show', noshow: 'no_show', didnt_come: 'no_show', did_not_come: 'no_show', missed: 'no_show',
  confirmed: 'confirmed', not_marked: 'confirmed', reset: 'confirmed'
}

async function updateBookingStatus(business, { booking_id, status }) {
  const s = STATUSES[String(status || '').toLowerCase().replace(/['’]/g, '').replace(/[\s-]+/g, '_')]
  if (!s) return { error: 'status must be came (completed), no_show, or confirmed (not marked yet).' }
  const a = await owner.findBooking(business, booking_id)
  if (!a || a.status === 'blocked') return { error: 'No booking with that id.' }
  if (a.status === 'cancelled') return { error: 'That booking is cancelled.' }
  await updateAppointment(business.businessId, a.startTime, a.appointmentId, { status: s })
  trace.event('db', `Owner marked a booking ${s.replace('_', '-')}`, { service: a.serviceName, when: fmtLocal(a.startTime, tzOf(business)) })
  return { updated: true, ...owner.view(business, { ...a, status: s }) }
}

// "Collect the rest" after a deposit: a PayPal link sent to the customer's inbox.
async function requestBalance(business, { booking_id, confirm }) {
  const a = await owner.findBooking(business, booking_id)
  if (!a || a.status === 'blocked') return { error: 'No booking with that id.' }
  const cur = a.currency || currencyOf(business)
  const balance = round2((a.totalAmount || 0) - (a.amountPaid || 0))
  if (balance <= 0) return { error: 'Nothing left to pay on this booking.' }
  if (a.seeded) return { error: 'This is a made-up demo booking, so there is no real customer to send a PayPal link to.' }
  const customer = a.customerId ? await getCustomer(a.customerId) : null
  if (!require('../services/demoInbox').customerInbox(customer)) return { error: 'This customer has no Flow inbox (a walk-in you added), so there is nowhere to send the PayPal link.' }
  const provider = require('../services/payments').getPaymentProvider(business)
  if (!provider.isConfigured(business)) return { error: 'PayPal isn\'t connected on this server yet, so no payment link can be made.' }
  if (!confirm) return quote([`send ${a.customerName || 'the customer'} a PayPal link (to their inbox) for the remaining ${formatMoney(balance, cur)} (${a.serviceName}, ${fmtLocal(a.startTime, tzOf(business))})`])
  const { requestBalancePayment } = require('./paymentFlow')
  const r = await requestBalancePayment({ business, appointment: a, customer, serviceName: a.serviceName || 'your booking', balance })
  return { sent: true, balance: formatMoney(balance, cur), payment_link: r.paymentUrl, sent_to: `${customer.name || a.customerName || 'the customer'}'s inbox` }
}

async function removeStaff(business, { staff_name, confirm }) {
  const s = findStaff(business, staff_name)
  if (!s) return { error: `No staff member called ${staff_name}.` }
  const upcoming = (await getAppointmentsForBusiness(business.businessId, new Date().toISOString(), dayjs().add(90, 'day').toISOString()))
    .filter(a => a.unitId === s.staffId && a.status === 'confirmed')
  const changes = [`remove ${s.name}`, upcoming.length ? `${upcoming.length === 1 ? `1 upcoming booking with ${s.name} stays booked; move it` : `${upcoming.length} upcoming bookings with ${s.name} stay booked; move them`} first with reschedule_booking` : 'no upcoming bookings with them']
  if (!confirm) return quote(changes)
  const config = { ...business.config, staff: (business.config.staff || []).filter(x => x.staffId !== s.staffId) }
  await updateBusiness(business.businessId, { config })
  business.config = config
  trace.event('setup', `Owner removed staff member ${s.name}`)
  return { removed: true, changes, setup: setupView(business) }
}

async function updateBusinessInfo(business, { name, address, phone, assistant_tone }) {
  const updates = {}
  const changes = []
  if (name) { updates.name = String(name).trim().slice(0, 80); changes.push(`name: ${updates.name}`) }
  if (phone) { updates.ownerPhone = String(phone).trim().slice(0, 30); changes.push(`phone: ${updates.ownerPhone}`) }
  if (address) { updates.location = { ...(business.location || {}), address: String(address).trim().slice(0, 160) }; changes.push(`address: ${updates.location.address}`) }
  if (assistant_tone) {
    updates.config = { ...business.config, ai_config: { ...(business.config.ai_config || {}), tone: String(assistant_tone).trim().slice(0, 120) } }
    changes.push(`assistant tone: ${updates.config.ai_config.tone}`)
  }
  if (!changes.length) return { error: 'Nothing to change: name, address, phone or assistant_tone.' }
  await updateBusiness(business.businessId, updates)
  Object.assign(business, updates)
  trace.event('setup', 'Owner updated the business details', { changed: changes.length })
  return { updated: true, changes }
}

async function listKnowledge(business) {
  const docs = await require('../services/rag').listDocuments(business.businessId)
  return { documents: docs.map(d => ({ file: d.file, kind: d.kind, ...(d.pages ? { pages: d.pages } : {}), added: d.addedAt, preview: d.preview })), faq_text: business.config.faq || null }
}

// The answer a customer asking this would get from the documents, with its sources:
// lets the owner (or their AI) check the knowledge base.
async function askKnowledge(business, { question }) {
  const q = String(question || '').trim()
  if (q.length < 3) return { error: 'Ask a question a customer might ask, e.g. "Is there parking?"' }
  const r = await require('../services/rag').ask(business.businessId, q, { businessName: business.name })
  if (!r) return { question: q, answer: null, sources: [], message: 'Nothing in the knowledge base yet. Add something with add_knowledge.' }
  if (!r.answer) return { question: q, answer: null, sources: [], message: `The ${r.documents} document${r.documents === 1 ? '' : 's'} don't cover this. Add something that does with add_knowledge.` }
  return { question: q, answer: r.answer, sources: r.sources.map(s => ({ from: s.file, quote: s.quote, ...(s.page ? { page: s.page } : {}) })), message: 'Customers asking this get this answer, read from your documents by Claude.' }
}

// Remove one document by its name. Quotes first, like every deletion.
async function removeKnowledge(business, { file, confirm }) {
  const docs = await require('../services/rag').listDocuments(business.businessId)
  const want = String(file || '').trim().toLowerCase()
  const doc = docs.find(d => d.file.toLowerCase() === want) || docs.find(d => want && d.file.toLowerCase().includes(want))
  if (!doc) return { error: `No document called "${file}". It has: ${docs.map(d => d.file).join(', ') || 'nothing yet'}.` }
  if (!confirm) return quote([`remove "${doc.file}" from the knowledge base`])
  await require('../services/rag').removeDocument(business.businessId, doc.sourceHash)
  trace.event('knowledge', `Owner removed "${doc.file}" from the knowledge base`)
  return { removed: true, file: doc.file }
}

async function addKnowledge(business, { title, text }) {
  const t = String(text || '').trim()
  if (t.length < 10) return { error: 'Add a bit more detail (at least a sentence).' }
  const { ingestDocument } = require('../services/rag')
  const name = `${String(title || 'Owner note').replace(/[^\w &-]/g, '').trim().slice(0, 60) || 'Owner note'}.txt`
  const r = await ingestDocument(business.businessId, Buffer.from(t.slice(0, 20000), 'utf8'), name, 'text/plain')
  if (r.error) return { error: r.error }
  if (r.added) trace.event('knowledge', `Owner added "${name}" to the knowledge base (stored in Claude's Files API)`)
  return { added: !!r.added, file: name, already: !!r.skipped }
}

async function clearKnowledge(business, { confirm }) {
  const now = await listKnowledge(business)
  if (!now.documents.length) return { error: 'The knowledge base is already empty.' }
  if (!confirm) return quote([`delete ${now.documents.length} document${now.documents.length === 1 ? '' : 's'} from the knowledge base: ${now.documents.map(d => d.file).join(', ')}`])
  const deleted = await require('../services/rag').clearBusinessKnowledge(business.businessId)
  trace.event('knowledge', `Owner cleared the knowledge base (${deleted} document${deleted === 1 ? '' : 's'})`)
  return { cleared: true, documents_deleted: deleted }
}

// Connecting PayPal happens on PayPal's own pages, so this returns the link to
// open. In the sandbox demo, the demo account (Flow's own sandbox account,
// demo/templates demoPaypal) can be used instead.
async function paypalConnect(business, { use_demo_account }) {
  if (use_demo_account) {
    const { demoPaypal, demoPaypalAvailable } = require('../demo/templates')
    if (!demoPaypalAvailable()) return { error: 'The demo PayPal account isn\'t available on this server.' }
    const updates = { ...demoPaypal(), paypalConnectedAt: new Date().toISOString() }
    await updateBusiness(business.businessId, updates)
    trace.event('paypal', 'Owner connected the demo PayPal sandbox account')
    return { connected: true, account: updates.paypalEmail || "Flow's demo sandbox account", sandbox: true }
  }
  if (!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)) return { error: 'PayPal isn\'t set up on this server yet.' }
  const paypal = require('../services/payments/paypal')
  let url
  try {
    ({ url } = await paypal.createOnboardingLink({ businessId: business.businessId, returnUrl: `${process.env.DASHBOARD_URL}/dashboard/payments?paypal=return` }))
  } catch (err) {
    // PayPal only lets approved partners onboard other merchants (403 NOT_AUTHORIZED).
    if (err.status === 403 || err.code === 'NOT_AUTHORIZED') return { error: 'Connecting your own PayPal account needs PayPal partner access, which this demo\'s PayPal app doesn\'t have yet. Use the demo sandbox account instead: payments, refunds, invoices and memberships all work there.', use_demo_account: true }
    throw err
  }
  return { open_this_link: url, message: 'Open this link in a browser to sign in to PayPal and connect the business account. Flow finishes the connection when PayPal sends the owner back.' }
}

module.exports = { createManualBooking, addBooking, moveBooking, updateBookingStatus, requestBalance, removeStaff, updateBusinessInfo, listKnowledge, addKnowledge, clearKnowledge, askKnowledge, removeKnowledge, paypalConnect }
