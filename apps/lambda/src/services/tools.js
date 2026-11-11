// @ts-check
'use strict'

// ─── Booking tools ────────────────────────────────────────────────────────────
// The actions the assistant can take — list services, check availability, book,
// queue tokens, cancellations. Shared by every channel's assistant (aiRouter: web chat,
// Flow Voice, Telegram, Alexa, MCP). Kept separate from aiRouter so callers that
// only need the tools don't load the AI provider.

const { randomUUID: uuid } = require('crypto')
const { getAvailability, createBooking, whyNotBookable } = require('../core/engine')
const { getNextQueueToken, priceForUnit, getFreeUnitsForSlot } = require('../core/units')
const redis = require('./redis')
const { resolveAmountDue } = require('../core/paymentModes')
const { requestPayment } = require('../core/paymentFlow')
const { getAppointmentsForBusiness, updateAppointment, createAppointment } = require('./dynamo/appointments')
const { updateCustomer } = require('./dynamo/customers')
const { getPaymentProvider } = require('./payments')
const { quoteRefund, refundAppointment } = require('../core/refunds')
const bookingMail = require('../core/bookingMail')
const { currencyOf, formatMoney } = require('../utils/money')
const { toUtcIso, fmtLocal, tzOf, localDate } = require('../utils/time')
const trace = require('./trace')
const log = require('../utils/logger')

// Can this conversation receive a pay link? Web chat and Telegram get it in the tool
// result (rendered as a button); a voice device or MCP client gets it in the inbox.
function canDeliverPayLink(ctx) {
  if (showsPayButton(ctx)) return true
  // A voice device can't show a button: the link goes to their Flow inbox instead.
  if (ctx.channel === 'speaker' && require('./demoInbox').customerInbox(ctx.customer)) return true
  // An MCP client gets the link in the tool result (and in their inbox).
  if (ctx.channel === 'mcp') return true
  return false
}

// Tools that change something (book, cancel, move, invoice). A failed AI turn is
// only retried on the backup model if none of these ran; lookups are safe to redo.
const SIDE_EFFECT_TOOLS = new Set(['book_appointment', 'get_queue_token', 'cancel_booking', 'reschedule_booking', 'add_booking_note', 'join_membership', 'cancel_membership', 'send_my_invoice', 'request_refund', 'pay_balance', 'my_saved_paypal'])
function hasSideEffects(name) { return SIDE_EFFECT_TOOLS.has(name) }

// Channels that render paymentUrl from the tool result as a Pay button.
function showsPayButton(ctx) {
  return ctx.channel === 'web' || ctx.channel === 'telegram'
}

const TOOLS = [
  {
    name: 'list_services',
    description: 'List all services this business offers with prices and durations. Use when the customer asks what is available.',
    parameters: {},
    required: []
  },
  {
    name: 'check_availability',
    description: 'Check available time slots for a service on a specific date. Optionally for a specific staff member.',
    parameters: {
      service_name: { type: 'string', description: 'Name of the service' },
      date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      staff_name: { type: 'string', description: 'Optional — check only this staff member\'s availability' }
    },
    required: ['service_name', 'date']
  },
  {
    name: 'list_staff',
    description: 'List the staff members who provide a service (or all staff). Use when the customer asks who is available or wants to choose a person.',
    parameters: {
      service_name: { type: 'string', description: 'Optional — only staff who provide this service' }
    },
    required: []
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment. Use as soon as the customer picks or confirms a free time (picking it is the confirmation; don\'t ask again first). For paid services: if the customer has PayPal saved, this first returns a quote (needsConfirm) — tell them the amount and ask; only after they say yes, call again with the same details plus confirm=true and the quoted amount, and it pays in one step. Otherwise a PayPal link is sent.',
    parameters: {
      service_name: { type: 'string', description: 'Name of the service to book' },
      start_time: { type: 'string', description: 'Start time exactly as returned by check_availability (slot.start), or local business time as YYYY-MM-DDTHH:mm' },
      customer_name: { type: 'string', description: 'Customer name if they provided it' },
      staff_name: { type: 'string', description: 'Optional — the staff member the customer chose' },
      confirm: { type: 'boolean', description: 'true only after the customer agreed to pay the quoted amount with their saved PayPal' },
      amount: { type: 'number', description: 'With confirm: the amount the customer agreed to, exactly as quoted' },
      pay_with: { type: 'string', enum: ['saved', 'link'], description: 'Optional: "link" if the customer would rather approve the payment on PayPal than use their saved PayPal' },
      notes: { type: 'string', description: 'Optional — anything the business should know, from a typed message, a voice note, a photo or a document: allergies, sensitivities, care or accessibility needs, a reference style. Say where it came from, e.g. "From a doctor\'s note (PDF): allergic to ammonia". Never include card or ID numbers.' },
      photo_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: ids of reference photos the customer sent in this chat ("photo id ph_..."), so the business sees the picture itself on the booking' },
    },
    required: ['service_name', 'start_time']
  },
  {
    name: 'get_queue_token',
    description: 'Get the next queue token for a token/queue-based service. Returns token number, position, and estimated wait.',
    parameters: {
      service_name: { type: 'string', description: 'Name of the queue service' }
    },
    required: ['service_name']
  },
  {
    name: 'get_my_bookings',
    description: 'Get the customer\'s upcoming appointments.',
    parameters: {},
    required: []
  },
  {
    name: 'cancel_booking',
    description: 'Cancel an existing booking for the customer. ALWAYS call first WITHOUT confirm: it returns the refund the cancellation policy gives right now. Tell the customer that exact amount and ask them to confirm; only after they say yes, call again with confirm=true — that cancels and sends the refund automatically.',
    parameters: {
      service_name: { type: 'string', description: 'Service name to cancel (optional — omit if customer didn\'t specify)' },
      date: { type: 'string', description: 'Date of the booking to cancel in YYYY-MM-DD (optional)' },
      confirm: { type: 'boolean', description: 'true only after the customer agreed to the quoted refund' }
    },
    required: []
  },
  {
    name: 'reschedule_booking',
    description: 'Move an existing booking to a new time, and/or to another staff member. Use when the customer wants to change when, or with whom, their appointment is. Keeps the payment.',
    parameters: {
      new_time: { type: 'string', description: 'The new start time: a slot.start from check_availability, or local business time as YYYY-MM-DDTHH:mm' },
      service_name: { type: 'string', description: 'Which booking to move, if the customer has more than one (optional)' },
      date: { type: 'string', description: 'Date of the booking to move (YYYY-MM-DD), if the customer has more than one (optional)' },
      staff_name: { type: 'string', description: 'Move it to this staff member (optional; they must do the service and be free then)' }
    },
    required: ['new_time']
  },
  {
    name: 'pay_balance',
    description: 'Pay the rest of a deposit booking now (what is still owed after the deposit) with PayPal. If the customer has PayPal saved, this first returns a quote: ask them, and only after they say yes call again with confirm=true and the quoted amount. Otherwise it returns a PayPal link, also sent to the customer\'s Flow inbox; nothing is charged until they approve it in PayPal.',
    parameters: {
      service_name: { type: 'string', description: 'Which booking, if the customer has more than one with something left to pay (optional)' },
      date: { type: 'string', description: 'Date of the booking in YYYY-MM-DD (optional)' },
      confirm: { type: 'boolean', description: 'true only after the customer agreed to pay the quoted amount with their saved PayPal' },
      amount: { type: 'number', description: 'With confirm: the amount the customer agreed to, exactly as quoted' },
      pay_with: { type: 'string', enum: ['saved', 'link'], description: 'Optional: "link" to approve on PayPal instead of using the saved PayPal' }
    },
    required: []
  },
  {
    // MCP only (getTools): a payment above the AI allowance waits for the customer's click in Flow.
    name: 'check_approval',
    description: 'Check a payment that is waiting for the customer to approve it in Flow (book_appointment or pay_balance returned needsApproval with an approval_id). Returns pending, approved (with the booking), declined or expired. You cannot approve it yourself; only the customer can, in their Flow.',
    parameters: { approval_id: { type: 'string', description: 'The approval_id from the needsApproval result' } },
    required: ['approval_id']
  },
  {
    name: 'my_saved_paypal',
    description: 'See or remove the PayPal the customer saved for one-step booking, or get a link to change it to another PayPal account. To remove: call with action="remove" first (returns what happens), ask the customer, then again with confirm=true. To change: action="change" returns a PayPal link (nothing is charged).',
    parameters: {
      action: { type: 'string', enum: ['show', 'remove', 'change'], description: 'show (default), remove, or change' },
      confirm: { type: 'boolean', description: 'remove only: true after the customer agreed' }
    },
    required: []
  },
  {
    name: 'add_booking_note',
    description: 'Save something the business should know on the customer\'s EXISTING upcoming booking (allergy, care or accessibility need, reference style, what a photo, document or voice note said). The owner sees it on the booking and gets an alert. For a new booking, pass it as notes to book_appointment instead. Only tell the customer it is noted after this returns saved.',
    parameters: {
      note: { type: 'string', description: 'The note, saying where it came from, e.g. "From a doctor\'s note (PDF): allergic to ammonia, use ammonia-free colour"' },
      service_name: { type: 'string', description: 'Which booking, if the customer has more than one (optional)' },
      date: { type: 'string', description: 'Date of the booking in YYYY-MM-DD (optional)' },
      photo_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: ids of reference photos the customer sent in this chat ("photo id ph_..."), so the business sees the picture itself on the booking' },
    },
    required: ['note']
  },
  {
    name: 'request_refund',
    description: 'Ask the business for money back on a PayPal-paid booking WITHOUT cancelling it (unhappy with the service, waited too long, charged wrong), up to 60 days after the visit. Nothing is refunded by this: the business decides and the answer goes to the customer\'s Flow inbox. To cancel an upcoming booking, use cancel_booking instead (it refunds by the policy).',
    parameters: {
      reason: { type: 'string', description: 'Why, in the customer\'s words' },
      amount: { type: 'number', description: 'How much to ask for (optional; everything not refunded yet if left out)' },
      service_name: { type: 'string', description: 'Which booking, if they have more than one (optional)' },
      date: { type: 'string', description: 'Date of the booking in YYYY-MM-DD (optional)' }
    },
    required: ['reason']
  }
]

function resolveServiceByName(business, name) {
  const services = business.config.services.filter(s => s.active)
  const lower = (name || '').toLowerCase()
  return services.find(s => s.name.toLowerCase() === lower)
    || services.find(s => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()))
    || null
}

function resolveStaffByName(business, name) {
  if (!name) return null
  const staff = business.config.staff || []
  const lower = name.toLowerCase()
  return staff.find(s => s.name.toLowerCase() === lower)
    || staff.find(s => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()))
    || null
}

// Every tool call — from chat, voice, or MCP — goes through here, so the
// "Under the hood" timeline shows each one with its outcome and duration.
async function executeTool(name, args, ctx) {
  // The business this call is about, for the timeline's per-business view: the
  // one named (concierge) or the one in context. Calls across businesses stay untagged.
  const business = ctx?.catalog
    ? (args?.business_name ? require('../core/concierge').resolveBusiness(ctx.catalog, args.business_name) : null)
    : ctx?.business
  // Reference photos: only ones this session's customer sent can go on a booking
  // (services/photos); the tools below get the checked list.
  if (PHOTO_TOOLS.has(name) && args?.photo_ids) {
    args = { ...args, photo_ids: ctx?.demoSid ? await require('./photos').owned(ctx.demoSid, args.photo_ids) : [] }
  }
  return trace.run(ctx?.traceScope, () => trace.forBusiness(business, () =>
    trace.span('tool', `Tool: ${name}`, async () => withPhotos(args, await runTool(name, args, ctx)), r => summarizeTool(args, r))))
}

const PHOTO_TOOLS = new Set(['book_appointment', 'add_booking_note'])
// Tell the AI how many photos really went on the booking, so it only says
// "your photo is on the booking" when it is (it once claimed so with none).
function withPhotos(args, r) {
  const n = Array.isArray(args?.photo_ids) ? args.photo_ids.length : 0
  if (!n || !r || r.error || r.needsConfirm || !(r.booked || r.paymentUrl || r.saved)) return r
  return { ...r, photosAttached: n, message: `${r.message || ''}${r.message ? ' ' : ''}The reference photo${n === 1 ? ' is' : 's are'} on the booking${r.booked || r.saved ? '' : ' once it is paid'}, for the business to see.` }
}

// Paying by PayPal link instead of the saved PayPal is the customer's choice, not
// the AI's: in a demo session a link is only made once the saved-PayPal quote for
// that payment was shown (the AI once skipped straight to a link on Telegram).
const QUOTE_TTL_MS = 30 * 60 * 1000
const quoteKey = (ctx, what) => (ctx?.demoSid ? [`S#${ctx.demoSid}`, `QUOTE#${what}`] : null)
async function markQuoted(ctx, what) {
  const k = quoteKey(ctx, what)
  if (k) await require('./demoStore').store().putKey(k[0], k[1], { at: Date.now() }, Date.now() + QUOTE_TTL_MS).catch(() => {})
}
async function quotedBefore(ctx, what) {
  const k = quoteKey(ctx, what)
  if (!k) return true
  return !!(await require('./demoStore').store().getKey(k[0], k[1]).catch(() => null))
}
// Link PayPal once, pay everywhere: with no saved
// PayPal, a demo payment never becomes a checkout link. The customer connects once
// (Log in with PayPal, which saves it too); every payment after goes through with a yes.
function needsConnect(ctx, business, customer) {
  const savedPaypal = require('../core/savedPaypal')
  return !!ctx?.demoSid && !savedPaypal.usable(business, customer) && savedPaypal.canSave(business)
}
async function connectFirst(ctx, business, customer, what) {
  let connectUrl = null
  const session = await require('../core/demoSession').getActiveSession(ctx.demoSid).catch(() => null)
  if (session) connectUrl = (await require('../core/paypalLogin').start(session).catch(() => null))?.url || null
  // A speaker can't show a button, and an AI app may not: the link waits in the Flow inbox too.
  if (connectUrl && (ctx.channel === 'speaker' || ctx.channel === 'mcp') && require('./demoInbox').customerInbox(customer)) {
    await require('./notify').notifyCustomer({ business, customer, channel: 'inbox', kind: 'payment_link', subject: 'Connect your PayPal', text: `Connect your PayPal once, and every booking, pack and membership pays from it (you still say yes to each amount).\n${connectUrl}` }).catch(() => {})
  }
  const where = ctx.channel === 'speaker' ? 'the link is in their Flow inbox'
    : ctx.channel === 'mcp' ? (connectUrl ? `this link: ${connectUrl}` : 'on their Flow page')
      : 'the Connect PayPal button below'
  return {
    booked: false, paymentRequired: true, needsConnect: true, connectUrl,
    message: `Nothing was booked or charged: PayPal isn't connected yet. Tell the customer to connect their PayPal once (${where}); after that ${what} and every later payment goes through with a yes. Don't offer a PayPal checkout link.`
  }
}

/** The saved PayPal to use, or null for a PayPal link (asked for after the quote, or none saved). */
async function savedFor(ctx, args, business, customer, what) {
  const saved = require('../core/savedPaypal').usable(business, customer)
  if (!saved || args.pay_with !== 'link') return saved
  return (await quotedBefore(ctx, what)) ? null : saved
}

// Saved PayPal: what the AI reads back before charging (money rule: quote, then confirm).
function savedQuote({ svc, kind, amount, currency, discountPercent, when, account, changed, overAllowance }) {
  const money = formatMoney(amount, currency) + (discountPercent ? ` (${discountPercent}% member discount)` : '')
  return {
    booked: false, paymentRequired: true, needsConfirm: true, savedPaypal: account,
    amount, currency, service: svc.name, when, paymentMode: svc.paymentMode, ...(overAllowance ? { overAllowance } : {}),
    message: `${changed ? 'The price changed, so nothing was charged. ' : ''}${overAllowance ? `This is ${overAllowance}, so it needs the customer's yes. ` : ''}The customer has PayPal saved (${account}). Ask: "Pay ${kind} of ${money} now with your saved PayPal to book ${svc.name} for ${when}?" Only after they say yes, call book_appointment again with the same details plus confirm=true and amount=${amount}. If they'd rather approve it on PayPal, call with pay_with="link".`
  }
}

// After a one-step payment with the saved PayPal: the booking outcome in words.
function paidWithSavedResult({ pay, svc, currency, account, allowance }) {
  const r = pay.result || {}
  const money = formatMoney(r.amount ?? pay.amountDue, currency)
  if (r.status === 'confirmed') {
    const under = allowance ? ` Paid by your AI under your allowance: ${formatMoney(allowance.left, currency)} of ${formatMoney(allowance.perMonth, currency)} left this month.` : ''
    return {
      booked: true, paidWithSaved: true, savedPaypal: account, service: svc.name, startTime: r.startTime, when: r.when,
      amount: r.amount ?? pay.amountDue, currency, orderId: pay.orderId, ...(allowance ? { paidUnder: 'allowance', allowanceLeft: allowance.left } : {}),
      message: `Booked and paid: ${money} with your saved PayPal (${account}). ${svc.name} on ${r.when}. The receipt is in your Flow inbox.${under}`
    }
  }
  if (r.status === 'pending') return { booked: false, paidWithSaved: true, message: 'PayPal is still processing the payment. The booking confirms as soon as it clears; you will get a message.' }
  if (r.status === 'refunded') return { booked: false, paidWithSaved: true, refunded: true, error: `The booking couldn't be made, so the ${money} was refunded in full to your PayPal. Offer another time.` }
  return { booked: false, error: `The saved PayPal payment didn't complete (${r.status || 'unknown'}). Nothing was booked. Try again, or use pay_with="link".` }
}

// This customer's live booking of this service at this time, if there is one.
async function sameBooking(business, customer, svc, startIso) {
  const t = new Date(startIso).getTime()
  if (!Number.isFinite(t) || !customer?.customerId) return null
  const near = await getAppointmentsForBusiness(business.businessId, new Date(t - 60_000).toISOString(), new Date(t + 60_000).toISOString())
  return near.find(a => a.customerId === customer.customerId && a.serviceId === svc.serviceId && a.status !== 'cancelled'
    && Math.abs(new Date(a.startTime).getTime() - t) < 60_000) || null
}

function alreadyBookedResult(business, svc, a) {
  const currency = a.currency || currencyOf(business)
  const when = fmtLocal(a.startTime, tzOf(business))
  const paid = Number(a.amountPaid || 0)
  return {
    booked: true, alreadyBooked: true, service: svc.name, startTime: a.startTime, when, amountPaid: paid, currency,
    message: `Already booked: ${svc.name} on ${when}${paid > 0 ? `, paid ${formatMoney(paid, currency)}` : ''}. Nothing new was booked or charged.`
  }
}

// A payment the AI made under the allowance: it counts toward this month, and the
// customer hears about it in their inbox (they didn't say yes to this one).
async function allowancePaid({ business, customer, r, amount, allowance, what, existing = 0, paymentMandate = null }) {
  try {
    await require('../core/allowance').record({ businessId: business.businessId, startTime: r.startTime, appointmentId: r.appointmentId, amount, existing, paymentMandateId: paymentMandate?.id || null, mandateId: allowance.mandateId || null })
    await require('./notify').notifyCustomer({
      business, customer, channel: 'inbox', kind: 'allowance_payment',
      subject: `Your AI paid ${formatMoney(amount, currencyOf(business))} at ${business.name}`,
      text: `Your AI paid ${formatMoney(amount, currencyOf(business))} for ${what} at ${business.name} with your saved PayPal, under the allowance you set (up to ${formatMoney(allowance.perBooking)} a booking, ${formatMoney(allowance.perMonth)} a month). ${formatMoney(allowance.left)} is left this month.\n\nRefunds follow ${business.name}'s cancellation policy as usual. Change or turn off the allowance in Profile.`
    })
  } catch (err) {
    log.warn('allowance_record_failed', { err: err.message })
  }
}

function cleanNotes(notes) {
  const s = typeof notes === 'string' ? notes.trim().slice(0, 500) : ''
  return s || null
}

function summarizeTool(args, r) {
  if (Array.isArray(r)) return { args: {}, result: { items: r.length } }
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined && o[k] !== null).map(k => [k, o[k]]))
  return {
    args: pick(args, ['business_name', 'service_name', 'date', 'start_time', 'staff_name', 'confirm', 'amount', 'pay_with', 'photo_ids', 'notes', 'note', 'category', 'query', 'reason']),
    result: {
      ...pick(r, ['available', 'booked', 'paymentRequired', 'amount', 'currency', 'simulated', 'needsConfirmation',
        'refundAmount', 'refundPct', 'cancelled', 'refunded', 'rescheduled', 'saved', 'requested', 'photosAttached', 'error']),
      ...(Array.isArray(r?.slots) ? { slots: r.slots.length } : {}),
      ...(Array.isArray(r?.services) ? { services: r.services.length } : {}),
      ...(r?.paymentUrl ? { paypalLink: true } : {})
    }
  }
}

async function runTool(name, args, ctx) {
  // City-wide concierge: pick the business this call is about (or handle it).
  if (ctx?.catalog) {
    const routed = await routeConcierge(name, args || {}, ctx)
    if (routed.result !== undefined) return routed.result
    ctx = routed.ctx
  }
  const { business, customer } = ctx
  // Times the AI passes may be local ("2026-10-18T15:00") — normalise to UTC ISO
  // in the business's timezone so they match the slot grid exactly.
  if (args && typeof args.start_time === 'string') args = { ...args, start_time: toUtcIso(args.start_time, tzOf(business)) || args.start_time }
  if (args && typeof args.new_time === 'string') args = { ...args, new_time: toUtcIso(args.new_time, tzOf(business)) || args.new_time }

  switch (name) {
    case 'list_services': {
      const services = business.config.services.filter(s => s.active).map(s => ({
        name: s.name,
        price: s.price ? formatMoney(s.price, currencyOf(business)) : 'varies',
        duration: s.duration ? `${s.duration} min` : 'varies',
        type: s.unitType
      }))
      // Memberships and packs are part of "what do you offer".
      const plans = require('../core/memberships').offers(business)
      return plans.length ? { services, memberships_and_packs: plans, note: 'Mention the memberships and packs too; they are paid with PayPal (join_membership).' } : services
    }

    case 'check_availability': {
      const svc = resolveServiceByName(business, args.service_name)
      if (!svc) return { error: `No service matching "${args.service_name}".` }
      if (svc.unitType === 'queue') {
        return { type: 'queue', ...(await getNextQueueToken(business, svc)) }
      }
      let staffId
      if (args.staff_name) {
        const member = resolveStaffByName(business, args.staff_name)
        if (!member) return { error: `No staff member named "${args.staff_name}".` }
        staffId = member.staffId
      }
      const slots = await getAvailability(business, svc.serviceId, args.date, staffId)
      if (!slots.length) return { available: false, message: args.staff_name ? `${args.staff_name} has no slots on this date.` : 'No slots available on this date.' }
      const tz = tzOf(business)
      return { available: true, date: args.date, timezone: tz, staff: args.staff_name || null,
        slots: slots.map(s => ({ start: s.start, local: fmtLocal(s.start, tz), spots: s.freeUnitCount })),
        note: 'Tell the customer the "local" times. Pass "start" back to book_appointment.' }
    }

    case 'list_staff': {
      let staff = business.config.staff || []
      if (args.service_name) {
        const svc = resolveServiceByName(business, args.service_name)
        if (svc) staff = staff.filter(s => s.services?.includes(svc.serviceId))
      }
      if (!staff.length) return { staff: [], message: 'No specific staff to choose from.' }
      return { staff: staff.map(s => ({
        name: s.name,
        // A removed service stays on the person's record (old bookings point at it) but isn't offered.
        services: (s.services || []).map(id => business.config.services.find(x => x.serviceId === id && x.active !== false)?.name).filter(Boolean)
      })) }
    }

    case 'book_appointment': {
      const svc = resolveServiceByName(business, args.service_name)
      if (!svc) return { error: `No service matching "${args.service_name}".` }

      const preferredUnitId = resolveStaffByName(business, args.staff_name)?.staffId
      if (args.staff_name && !preferredUnitId) return { error: `No staff member named "${args.staff_name}".` }
      // Hours, the past, and the named person: refused before any PayPal link or covered booking.
      const notBookable = await whyNotBookable(business, svc, args.start_time, preferredUnitId)
      if (notBookable) return { booked: false, error: notBookable }
      // A repeat of a booking that already went through (say the AI timed out after
      // paying and the customer asked again): report it, never book or charge twice.
      const existing = await sameBooking(business, customer, svc, args.start_time)
      if (existing) return alreadyBookedResult(business, svc, existing)

      // A paid service must have its amount defined in the panel. If it doesn't,
      // refuse the booking — never guess a price or pull one from an uploaded doc.
      let requiresPayment, amountDue
      try {
        ({ requiresPayment, amountDue } = resolveAmountDue(priceForUnit(svc, business, preferredUnitId)))
      } catch (err) {
        if (err.code === 'AMOUNT_NOT_CONFIGURED') {
          log.warn('tool_amount_not_configured', { businessId: business.businessId, serviceId: svc.serviceId })
          return { error: `The ${svc.name} price isn't set up yet, so I can't confirm a paid booking. Please ask the business to set the amount, or pick another service.` }
        }
        throw err
      }

      // Test-sandbox: simulate the outcome without creating a booking or charging.
      if (ctx.dryRun) {
        return requiresPayment
          ? { simulated: true, paymentRequired: true, amount: amountDue, currency: currencyOf(business), service: svc.name, message: `(Test) I'd send a payment link for ${formatMoney(amountDue, currencyOf(business))} to confirm your ${svc.name} booking — it confirms automatically once paid.` }
          : { simulated: true, booked: true, service: svc.name, message: `(Test) Your ${svc.name} booking would be confirmed. In real use this creates the appointment.` }
      }

      if (args.customer_name && !customer.name) {
        await updateCustomer(customer.customerId, { name: args.customer_name })
        customer.name = args.customer_name
      }

      // A membership or pack: a covered booking costs nothing, and members may get
      // a discount. core/memberships decides, never the AI.
      const memberships = require('../core/memberships')
      const member = requiresPayment ? await memberships.coverFor(customer, business, svc).catch(err => { log.warn('membership_check_failed', { err: err.message }); return null }) : null
      if (member?.covered) {
        try {
          const appt = await createBooking({
            business, serviceId: svc.serviceId, startIso: args.start_time, customer, paymentId: null,
            createdVia: ctx.channel || 'web', preferredUnitId, notes: cleanNotes(args.notes), photos: args.photo_ids,
            covered: { membershipId: member.membership.membershipId, planName: member.membership.planName }
          })
          const left = await memberships.useOne(customer.customerId, member.membership.membershipId, svc.serviceId)
          const period = member.membership.kind === 'pack' ? 'in the pack' : 'this month'
          const when = fmtLocal(appt.startTime, tzOf(business))
          trace.event('policy', `Covered by ${member.membership.planName}: no payment needed`, { service: svc.name, usesLeft: left })
          const notify = require('./notify')
          await notify.notifyOwner({ business, kind: 'new_booking', subject: `New booking: ${svc.name}, ${when} (${member.membership.planName})`, text: `${customer.name || 'A customer'} booked ${svc.name} for ${when}, covered by their ${member.membership.planName}.${appt.customerNotes ? `\nCustomer notes: ${appt.customerNotes}` : ''}` }).catch(() => {})
          await notify.notifyCustomer({ business, customer, channel: 'inbox', kind: 'confirmation', subject: `Booked: ${svc.name}, ${when}`, text: `Your ${svc.name} at ${business.name} is booked for ${when}. It's covered by your ${member.membership.planName}: nothing to pay. ${left} left ${period}.` }).catch(() => {})
          return {
            booked: true, coveredBy: member.membership.planName, usesLeft: left, service: svc.name, startTime: appt.startTime, endTime: appt.endTime, when,
            message: `Booked for ${when}, covered by ${member.membership.planName}: nothing to pay. ${left} ${svc.name}${left === 1 ? '' : 's'} left ${period}.`
          }
        } catch (err) {
          return { error: err.message }
        }
      }
      const discountPercent = member?.discountPercent || 0

      if (requiresPayment) {
        // The PayPal link needs a connected payment account and a channel that can
        // show or deliver it. If either is missing, don't hard-error at the caller:
        // promise a follow-up instead.
        const currency = currencyOf(business)
        const due = formatMoney(amountDue, currency)
        const providerReady = getPaymentProvider(business).isConfigured(business)
        if (!providerReady || !canDeliverPayLink(ctx)) {
          log.warn('tool_payment_unconfigured', { businessId: business.businessId, providerReady, channel: ctx.channel })
          // Demo: nobody will follow up, so say plainly that nothing happened.
          if (ctx.demoSid) {
            return {
              booked: false, paymentRequired: true, paymentLink: false, amount: amountDue,
              message: `Not booked: PayPal isn't connected on this demo server yet, so no payment link could be made and nothing was charged. Tell the customer that plainly; there is no PayPal button.`
            }
          }
          return {
            booked: false,
            paymentRequired: true,
            amount: amountDue,
            message: `Your ${svc.name} booking needs a payment of ${due} to confirm. Our team will send you a payment link shortly.`
          }
        }
        // Saved PayPal: quote the exact amount first; charge only on confirm with that amount.
        const savedPaypal = require('../core/savedPaypal')
        if (needsConnect(ctx, business, customer)) return connectFirst(ctx, business, customer, `this ${svc.name}`)
        const quoteFor = `book#${business.businessId}#${svc.serviceId}#${args.start_time}`
        const saved = await savedFor(ctx, args, business, customer, quoteFor)
        const kind = /^deposit/.test(svc.paymentMode) ? 'a deposit' : 'the full amount'
        // Within the AI spending allowance the customer set (core/allowance), it pays
        // without asking; otherwise quote and wait for a yes.
        const quoted = discountPercent ? Math.round(amountDue * (100 - discountPercent)) / 100 : amountDue
        let allowance = null
        // Over MCP the AI's own confirm doesn't count: above the allowance the
        // customer approves in their Flow (core/approvals).
        const approvals = require('../core/approvals')
        const aiConfirmed = args.confirm && Number.isFinite(Number(args.amount))
        if (saved && (!aiConfirmed || approvals.needsHumanApproval(ctx))) {
          const al = await require('../core/allowance').check({ customer, amount: quoted, businesses: ctx.catalog || [business], business })
          if (al.ok) allowance = al
          else if (approvals.needsHumanApproval(ctx)) {
            return approvals.request({ ctx, tool: 'book_appointment', args, amount: quoted, currency, what: `${svc.name}, ${fmtLocal(args.start_time, tzOf(business))}`, account: savedPaypal.masked(saved.email), business, customer })
          } else {
            await markQuoted(ctx, quoteFor)
            return savedQuote({ svc, kind, amount: quoted, currency, discountPercent, when: fmtLocal(args.start_time, tzOf(business)), account: savedPaypal.masked(saved.email), overAllowance: al.reason })
          }
        }
        // Demo fair-use: a few PayPal checkouts per session per hour.
        if (ctx.demoSid && await require('../core/demoSession').checkCheckoutLimit(ctx.demoSid)) {
          return { error: 'Demo limit: too many payment links this hour. Finish or cancel an existing booking, or try again later.' }
        }
        // Paying under the mandate: the exact payment is written down and signed first.
        const paymentMandate = allowance ? await require('../core/allowance').authorize({ customer, amount: quoted, currency, business, what: svc.name, startIso: args.start_time, channel: ctx.channel || null }) : null
        try {
          const pay = await requestPayment({
            business, serviceId: svc.serviceId, startIso: args.start_time,
            customer,
            channel: ctx.channel || 'web', preferredUnitId, notes: cleanNotes(args.notes), photos: args.photo_ids, discountPercent,
            ...(saved ? { useSaved: true, expectedAmount: allowance ? quoted : Number(args.amount), underAllowance: !!allowance, paymentMandate, clientMetadataId: require('../core/riskData').clientMetadataId(ctx) } : {})
          })
          if (paymentMandate) await require('../core/allowance').settle(paymentMandate, { status: pay.paidWithSaved && pay.result?.status === 'confirmed' ? 'paid' : 'not_charged', orderId: pay.orderId || null, appointmentId: pay.result?.appointmentId || null })
          if (pay.paidWithSaved && allowance && pay.result?.status === 'confirmed') await allowancePaid({ business, customer, r: pay.result, amount: pay.amountDue ?? quoted, allowance, what: svc.name, paymentMandate })
          if (pay.paidWithSaved) return paidWithSavedResult({ pay, svc, currency, account: savedPaypal.masked(saved.email), allowance })
          const charged = pay.amountDue ?? amountDue
          const dueNow = formatMoney(charged, currency) + (discountPercent ? ` (${discountPercent}% member discount)` : '')
          // The first PayPal payment also saves PayPal; say so (PayPal asks on its own page too).
          const savesPaypal = !saved && savedPaypal.canSave(business) && !customer.savedPaypal?.vaultId
          const saveLine = savesPaypal ? ' Paying also saves your PayPal for one-step booking next time (PayPal asks first; remove it any time in Profile).'
            : pay.savedNeedsApproval ? ' PayPal wants you to approve this one on PayPal.'
              : saved ? " Your saved PayPal didn't go through (nothing was charged), so use PayPal instead." : ''
          if (showsPayButton(ctx)) {
            // Web chat renders paymentUrl as a PayPal button under the reply.
            return {
              booked: false, paymentRequired: true, paymentMode: svc.paymentMode,
              amount: charged, ...(discountPercent ? { memberDiscount: `${discountPercent}%` } : {}), currency, service: svc.name, startTime: args.start_time,
              paymentUrl: pay.paymentUrl, orderId: pay.orderId, holdMinutes: 10, savesPaypal,
              message: `To confirm your ${svc.name} booking, please pay ${kind} of ${dueNow} with the PayPal button below. The slot is held for you for 10 minutes and confirms automatically once you pay.${saveLine}`
            }
          }
          if (ctx.channel === 'mcp') {
            return {
              booked: false, paymentRequired: true, paymentMode: svc.paymentMode,
              amount: charged, ...(discountPercent ? { memberDiscount: `${discountPercent}%` } : {}), currency, service: svc.name, startTime: args.start_time,
              paymentUrl: pay.paymentUrl, orderId: pay.orderId, holdMinutes: 10, sentToInbox: !!require('./demoInbox').customerInbox(customer), savesPaypal,
              message: `Not booked yet: pay ${kind} of ${dueNow} with PayPal to confirm. Show the customer this link (also in their Flow inbox): ${pay.paymentUrl} — the slot is held for 10 minutes.${saveLine}`
            }
          }
          if (ctx.channel === 'speaker') {
            // Voice: the link went to the customer's Flow inbox (and the app card).
            return {
              booked: false, paymentRequired: true, paymentMode: svc.paymentMode,
              amount: charged, ...(discountPercent ? { memberDiscount: `${discountPercent}%` } : {}), currency, service: svc.name, startTime: args.start_time,
              paymentUrl: pay.paymentUrl, orderId: pay.orderId, holdMinutes: 10, sentToInbox: true, savesPaypal,
              message: `To confirm, pay ${kind} of ${dueNow}. I've sent a secure PayPal link to your Flow inbox — the slot is held for 10 minutes and confirms as soon as you pay.${saveLine}`
            }
          }
          return {
            booked: false,
            paymentRequired: true,
            paymentMode: svc.paymentMode,
            amount: charged, ...(discountPercent ? { memberDiscount: `${discountPercent}%` } : {}),
            paymentUrl: pay.paymentUrl, orderId: pay.orderId,
            message: `To confirm your ${svc.name} booking, please pay ${kind} of ${dueNow} with PayPal: ${pay.paymentUrl} — the booking confirms automatically once you pay.`
          }
        } catch (err) {
          if (err.code === 'SLOT_UNAVAILABLE') {
            return { error: 'That time was just taken or is being held while another customer pays. Offer the next available slot.' }
          }
          if (err.code === 'PRICE_CHANGED') {
            // Nothing was charged: quote the real amount and ask again.
            const s = require('../core/savedPaypal').usable(business, customer)
            await markQuoted(ctx, `book#${business.businessId}#${svc.serviceId}#${args.start_time}`)
            return savedQuote({ svc, kind, amount: err.amount, currency, discountPercent, when: fmtLocal(args.start_time, tzOf(business)), account: require('../core/savedPaypal').masked(s?.email), changed: true })
          }
          log.error('tool_request_payment_failed', err, { businessId: business.businessId })
          return { error: 'Could not create the payment link. Please try again.' }
        }
      }

      try {
        const appt = await createBooking({
          business, serviceId: svc.serviceId, startIso: args.start_time,
          customer, paymentId: null, createdVia: ctx.channel || 'web', preferredUnitId, notes: cleanNotes(args.notes), photos: args.photo_ids
        })
        // A free service (nothing to pay): both sides still hear about it,
        // like a paid booking does once PayPal confirms it.
        const when = fmtLocal(appt.startTime, tzOf(business))
        const atVisit = Number(svc.price) > 0 ? ` ${formatMoney(svc.price, currencyOf(business))} to pay at the visit.` : ''
        const notify = require('./notify')
        await notify.notifyOwner({ business, kind: 'new_booking', subject: `New booking: ${svc.name}, ${when}`, text: `${customer.name || 'A customer'} booked ${svc.name} for ${when}.${atVisit}${appt.customerNotes ? `\nCustomer notes: ${appt.customerNotes}` : ''}` }).catch(() => {})
        await notify.notifyCustomer({ business, customer, channel: 'inbox', kind: 'confirmation', subject: `Booked: ${svc.name}, ${when}`, text: `Your ${svc.name} at ${business.name} is booked for ${when}.${atVisit}` }).catch(() => {})
        return { booked: true, service: svc.name, startTime: appt.startTime, endTime: appt.endTime, when, queueToken: appt.queueToken, message: `Booked for ${when}.${atVisit}` }
      } catch (err) {
        return { error: err.message }
      }
    }

    case 'get_queue_token': {
      const svc = resolveServiceByName(business, args.service_name)
      if (!svc) return { error: `No service matching "${args.service_name}".` }
      if (svc.unitType !== 'queue') return { error: 'This service does not use queue tokens.' }
      return await getNextQueueToken(business, svc)
    }

    case 'get_my_bookings': {
      const now = new Date().toISOString()
      const future = new Date(Date.now() + 30 * 86_400_000).toISOString()
      const all = await getAppointmentsForBusiness(business.businessId, now, future)
      const mine = all.filter(a => a.customerId === customer.customerId && a.status !== 'cancelled')
      if (!mine.length) return { bookings: [], message: 'No upcoming bookings.' }
      return { bookings: mine.map(a => ({
        service: a.serviceName || business.config.services.find(s => s.serviceId === a.serviceId)?.name || a.serviceId,
        startTime: a.startTime, status: a.status
      })) }
    }

    case 'pay_balance': {
      // The rest of a deposit booking: the same PayPal flow the owner's request_balance uses.
      const now = new Date().toISOString()
      const future = new Date(Date.now() + 60 * 86_400_000).toISOString()
      let owed = (await getAppointmentsForBusiness(business.businessId, now, future))
        .filter(a => a.customerId === customer.customerId && a.status === 'confirmed' && Number(a.totalAmount || 0) - Number(a.amountPaid || 0) > 0.001 && Number(a.amountPaid) > 0)
        .filter(a => !args.date || localDate(a.startTime, tzOf(business)) === args.date)
        .filter(a => !args.service_name || (a.serviceName || '').toLowerCase().includes(String(args.service_name).toLowerCase()))
      if (!owed.length) return { error: 'Nothing is left to pay on an upcoming booking here.' }
      if (owed.length > 1) return { message: 'More than one booking has something left to pay: which one?', bookings: owed.map(a => ({ service: a.serviceName, when: fmtLocal(a.startTime, tzOf(business)) })) }
      const a = owed[0]
      const cur = a.currency || currencyOf(business)
      const balance = Math.round((Number(a.totalAmount) - Number(a.amountPaid)) * 100) / 100
      if (ctx.dryRun) return { simulated: true, message: `(Test) I'd send a PayPal link for the remaining ${formatMoney(balance, cur)}.` }
      if (!getPaymentProvider(business).isConfigured(business)) return { error: "PayPal isn't connected on this server yet, so no payment link can be made." }
      const when = fmtLocal(a.startTime, tzOf(business))
      // Saved PayPal: quote first; pay only on confirm with exactly the quoted amount.
      const savedPaypal = require('../core/savedPaypal')
      if (needsConnect(ctx, business, customer)) return connectFirst(ctx, business, customer, `the rest of ${a.serviceName}`)
      const quoteFor = `balance#${a.appointmentId}`
      const saved = await savedFor(ctx, args, business, customer, quoteFor)
      const agreed = args.confirm && Math.abs(Number(args.amount) - balance) < 0.005
      // Over MCP, above the allowance, the customer approves in Flow (core/approvals).
      const approvals = require('../core/approvals')
      const human = approvals.needsHumanApproval(ctx)
      const al = saved && (!agreed || human) ? await require('../core/allowance').check({ customer, amount: balance, businesses: ctx.catalog || [business], business }) : null
      if (saved && human && !al?.ok) {
        return approvals.request({ ctx, tool: 'pay_balance', args, amount: balance, currency: cur, what: `the rest of ${a.serviceName} (${when})`, account: savedPaypal.masked(saved.email), business, customer })
      }
      if (saved && !agreed && !al?.ok) {
        await markQuoted(ctx, quoteFor)
        return {
          paymentRequired: true, needsConfirm: true, savedPaypal: savedPaypal.masked(saved.email), amount: balance, currency: cur, service: a.serviceName, when,
          message: `${args.confirm ? 'The amount left changed, so nothing was charged. ' : ''}${al?.reason ? `This is ${al.reason}, so it needs the customer's yes. ` : ''}The customer has PayPal saved (${savedPaypal.masked(saved.email)}). Ask: "Pay the remaining ${formatMoney(balance, cur)} for ${a.serviceName} (${when}) now with your saved PayPal?" Only after they say yes, call pay_balance again with confirm=true and amount=${balance}. For a PayPal link instead, pass pay_with="link".`
        }
      }
      if (ctx.demoSid && await require('../core/demoSession').checkCheckoutLimit(ctx.demoSid)) {
        return { error: 'Demo limit: too many payment links this hour. Try again later.' }
      }
      const { requestBalancePayment } = require('../core/paymentFlow')
      const underMandate = !!(saved && al?.ok)
      const paymentMandate = underMandate ? await require('../core/allowance').authorize({ customer, amount: balance, currency: cur, business, what: `the rest of ${a.serviceName}`, startIso: a.startTime, channel: ctx.channel || null }) : null
      const r = await requestBalancePayment({ business, appointment: a, customer, serviceName: a.serviceName || 'your booking', balance, useSaved: !!saved, underAllowance: underMandate, paymentMandate, clientMetadataId: require('../core/riskData').clientMetadataId(ctx) })
      if (paymentMandate) await require('../core/allowance').settle(paymentMandate, { status: r.paidWithSaved && r.result?.status === 'paid' ? 'paid' : 'not_charged', orderId: r.orderId || null, appointmentId: a.appointmentId })
      if (r.paidWithSaved) {
        const ok = r.result?.status === 'paid'
        const allowance = al?.ok ? al : null
        if (ok && allowance) await allowancePaid({ business, customer, r: { appointmentId: a.appointmentId, startTime: a.startTime }, amount: balance, allowance, what: `the rest of ${a.serviceName}`, existing: a.allowancePaid, paymentMandate })
        const under = allowance ? ` Paid by your AI under your allowance: ${formatMoney(allowance.left, cur)} of ${formatMoney(allowance.perMonth, cur)} left this month.` : ''
        return ok
          ? { paid: true, paidWithSaved: true, savedPaypal: savedPaypal.masked(saved.email), amount: balance, currency: cur, service: a.serviceName, when, ...(allowance ? { paidUnder: 'allowance', allowanceLeft: allowance.left } : {}), message: `Paid the remaining ${formatMoney(balance, cur)} with your saved PayPal (${savedPaypal.masked(saved.email)}). ${a.serviceName} on ${when} is now fully paid; the receipt is in your Flow inbox.${under}` }
          : { paid: false, message: r.result?.status === 'pending' ? 'PayPal is still processing it; you will get a message when it clears.' : `The payment didn't complete (${r.result?.status || 'unknown'}). Try again, or use pay_with="link".` }
      }
      return {
        paymentRequired: true, balance: formatMoney(balance, cur), amount: balance, currency: cur, service: a.serviceName, when,
        paymentUrl: r.paymentUrl, sentToInbox: !!require('./demoInbox').customerInbox(customer),
        message: `Pay the remaining ${formatMoney(balance, cur)} for your ${a.serviceName} (${when}) with PayPal: ${r.paymentUrl} (also in your Flow inbox). Nothing is charged until you approve it in PayPal.`
      }
    }

    case 'request_refund':
      return require('../core/refundRequests').request({ businesses: [business], customer, args, dryRun: ctx.dryRun })

    case 'my_saved_paypal': {
      const savedPaypal = require('../core/savedPaypal')
      if (args.action === 'remove') {
        if (ctx.dryRun) return { simulated: true, message: "(Test) I'd remove the saved PayPal." }
        return savedPaypal.remove({ customer, confirm: !!args.confirm })
      }
      if (args.action === 'change') {
        if (ctx.dryRun) return { simulated: true, message: "(Test) I'd give a PayPal link to save another account." }
        if (!savedPaypal.canSave(business)) return { error: "Saving PayPal isn't available here." }
        const r = await savedPaypal.startChange({ customer, returnTo: ctx.channel === 'web' ? 'profile' : null })
        return { changeUrl: r.approveUrl, message: r.message }
      }
      const v = savedPaypal.view(customer)
      // The allowance is shown, never changed here: only the customer sets it, in Profile.
      const al = await require('../core/allowance').view(customer, ctx.catalog || [business])
      const until = al.expiresAt ? `, ${al.expired ? 'ended' : 'until'} ${new Date(al.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Chicago' })}` : ''
      const alText = al.on ? ` AI spending mandate${al.mandateId ? ` ${al.mandateId}` : ''}: your AI may pay up to ${formatMoney(al.perBooking)} a booking and ${formatMoney(al.perMonth)} a month without asking, at ${al.places}${until} (${formatMoney(al.left)} left this month). Only you can change it, in Profile.` : ' No AI spending mandate is set, so every payment needs your yes.'
      return v.saved
        ? { ...v, allowance: al, message: `PayPal saved: ${v.account}. Bookings and balances can be paid in one step after you agree to the amount.${alText} You can change or remove the saved PayPal.` }
        : { ...v, message: 'No PayPal saved yet. Your next PayPal payment saves it (PayPal asks first).' }
    }

    case 'add_booking_note': {
      const note = cleanNotes(args.note)
      if (!note) return { error: 'What should the note say?' }
      const now = new Date().toISOString()
      const future = new Date(Date.now() + 60 * 86_400_000).toISOString()
      const mine = (await getAppointmentsForBusiness(business.businessId, now, future))
        .filter(a => a.customerId === customer.customerId && a.status !== 'cancelled' && a.status !== 'blocked')
        .filter(a => !args.date || a.startTime.startsWith(args.date))
        .filter(a => !args.service_name || (a.serviceName || '').toLowerCase().includes(String(args.service_name).toLowerCase()))
        .sort((x, y) => x.startTime.localeCompare(y.startTime))
      if (!mine.length) return { error: 'No upcoming booking to add it to. If they are booking now, pass it as notes to book_appointment.' }
      if (mine.length > 1 && !args.service_name && !args.date) {
        return { message: 'More than one upcoming booking — which one?', bookings: mine.map(a => ({ service: a.serviceName, when: fmtLocal(a.startTime, tzOf(business)) })) }
      }
      const appt = mine[0]
      if (ctx.dryRun) return { simulated: true, saved: false, message: `(Test) I'd add this note to your ${appt.serviceName}.` }
      // Earlier notes stay; the new one goes on the next line.
      const customerNotes = [appt.customerNotes, note].filter(Boolean).join('\n').slice(-1000)
      const photos = Array.isArray(args.photo_ids) && args.photo_ids.length ? [...new Set([...(appt.customerPhotos || []), ...args.photo_ids])].slice(-5) : null
      await updateAppointment(business.businessId, appt.startTime, appt.appointmentId, { customerNotes, ...(photos ? { customerPhotos: photos } : {}) })
      const when = fmtLocal(appt.startTime, tzOf(business))
      await require('./notify').notifyOwner({
        business, kind: 'booking_note',
        subject: `Note from ${customer.name || 'a customer'}: ${appt.serviceName}, ${when}`,
        text: `${customer.name || 'A customer'} added a note to their ${appt.serviceName} on ${when}:\n\n${note}\n\nIt's on the booking in your calendar.`
      }).catch(err => log.warn('booking_note_alert_failed', { err: err.message }))
      return { saved: true, service: appt.serviceName, when, note, message: `Saved on the ${appt.serviceName} booking (${when}). The owner can see it and was alerted.` }
    }

    case 'reschedule_booking': {
      const newIso = args.new_time
      if (!newIso) return { error: 'What new time would you like?' }

      const now = new Date().toISOString()
      const future = new Date(Date.now() + 60 * 86_400_000).toISOString()
      let mine = (await getAppointmentsForBusiness(business.businessId, now, future))
        .filter(a => a.customerId === customer.customerId && a.status !== 'cancelled' && a.status !== 'blocked')
      if (args.service_name) {
        const svc = resolveServiceByName(business, args.service_name)
        if (svc) mine = mine.filter(a => a.serviceId === svc.serviceId)
      }
      // The booking to move is identified by its own date ("my Tuesday haircut"), not the new one.
      if (args.date) mine = mine.filter(a => localDate(a.startTime, tzOf(business)) === args.date)
      mine.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
      // Never guess between two bookings: the customer says which.
      if (mine.length > 1 && !args.date) {
        return { rescheduled: false, message: 'More than one upcoming booking matches: which one? Pass date (YYYY-MM-DD) of the booking to move.', bookings: mine.map(a => ({ service: a.serviceName, when: fmtLocal(a.startTime, tzOf(business)) })) }
      }
      const appt = mine[0]
      if (!appt) return { error: 'I couldn\'t find an upcoming booking to move.' }

      // Moving to someone else: they must do the service (and be free, checked below).
      let wantedStaff = null
      if (args.staff_name) {
        wantedStaff = resolveStaffByName(business, args.staff_name)
        if (!wantedStaff) return { error: `No staff member named "${args.staff_name}".` }
      }

      const svc = business.config.services.find(s => s.serviceId === appt.serviceId)
      const duration = svc?.duration || 60
      const endIso = new Date(new Date(newIso).getTime() + duration * 60_000).toISOString()
      const label = appt.serviceName || svc?.name || 'your booking'

      if (ctx.dryRun) return { simulated: true, message: `(Test) I'd move ${label} to ${newIso}.` }

      // Internal: hold a free unit at the new time (prefer the same one), then
      // create the new appointment and cancel the old — the sort key embeds the
      // start time, so a move is a create-plus-cancel, not an in-place edit.
      let unitId = appt.unitId
      if (svc) {
        const notBookable = await whyNotBookable(business, svc, newIso, wantedStaff?.staffId)
        if (notBookable) return { rescheduled: false, error: notBookable }
      }
      if (svc && svc.unitType !== 'queue') {
        const free = await getFreeUnitsForSlot(business, svc, newIso, endIso)
        if (!free.length) return { error: 'Nothing is free at that time — want me to suggest another slot?' }
        unitId = wantedStaff && free.includes(wantedStaff.staffId) ? wantedStaff.staffId : free.includes(appt.unitId) ? appt.unitId : free[0]
        const locked = await redis.reserveSlot(business.businessId, newIso, unitId, customer.customerId)
        if (!locked) return { error: 'That new slot was just taken — try another?' }
      }

      // Keep paymentId/paymentProvider/amountPaid: a later cancel must still be able to refund it.
      // bookedVia keeps the first channel (a move isn't a new booking); movedBy shows on the calendar.
      const moved = { ...appt, appointmentId: uuid(), startTime: newIso, endTime: endIso, unitId, status: 'confirmed', createdVia: 'reschedule', bookedVia: appt.bookedVia || (['reschedule', 'owner_reschedule'].includes(appt.createdVia) ? null : appt.createdVia), movedBy: 'customer', rescheduledFrom: appt.appointmentId }
      await createAppointment(moved)
      // The payment and invoice now belong to the new booking (core/moved).
      await updateAppointment(business.businessId, appt.startTime, appt.appointmentId, require('../core/moved').movedAwayFields(moved.appointmentId, { cancelledBy: 'customer_reschedule', cancelledAt: new Date().toISOString() }))
      if (svc && svc.unitType !== 'queue') await redis.releaseSlot(business.businessId, appt.startTime, appt.unitId, customer.customerId).catch(() => {})
      await bookingMail.moved({ business, from: appt, to: moved, by: 'customer' })
      return { rescheduled: true, service: label, startTime: newIso, when: fmtLocal(newIso, tzOf(business)), staff: (business.config.staff || []).find(s => s.staffId === unitId)?.name || null }
    }

    case 'cancel_booking': {
      const now = new Date().toISOString()
      const future = new Date(Date.now() + 30 * 86_400_000).toISOString()
      const all = await getAppointmentsForBusiness(business.businessId, now, future)
      let mine = all.filter(a => a.customerId === customer.customerId && a.status !== 'cancelled')

      if (args.service_name) {
        const lower = args.service_name.toLowerCase()
        const svc = resolveServiceByName(business, args.service_name)
        mine = mine.filter(a => (svc && a.serviceId === svc.serviceId) || (a.serviceName || '').toLowerCase().includes(lower))
      }
      if (args.date) mine = mine.filter(a => a.startTime.startsWith(args.date))

      if (!mine.length) return { cancelled: false, message: 'No matching booking found.' }
      if (mine.length > 1) return { cancelled: false, message: 'Multiple bookings found. Please specify the date.', bookings: mine.map(a => ({ service: a.serviceName || a.serviceId, startTime: a.startTime })) }

      const target = mine[0]
      const hoursUntil = (new Date(target.startTime).getTime() - Date.now()) / 3_600_000
      const minHours = business.config.booking_rules?.cancellation_hours || 0
      if (hoursUntil < minHours) return { cancelled: false, message: `Cancellations require ${minHours} hours notice.` }

      const serviceLabel = target.serviceName || business.config.services.find(s => s.serviceId === target.serviceId)?.name
      const currency = target.currency || currencyOf(business)
      const quote = quoteRefund(target, business.config.policies?.refundTiers)
      const paid = Number(target.amountPaid) > 0
      if (paid) {
        trace.event('policy', `Refund policy: ${Math.max(0, Math.round(quote.hoursUntil))}h before start → ${quote.pct}%`, {
          tier: quote.tier ? `${quote.tier.hoursBefore}h+ = ${quote.tier.refundPct}%` : (quote.pct === 100 ? 'no tiers set → full refund' : 'inside the last window'),
          paid: quote.refundable, refund: quote.amount, currency
        })
      }

      // Step 1: quote. The AI reads this back and asks the customer to confirm.
      if (!args.confirm) {
        return {
          needsConfirmation: true, service: serviceLabel, startTime: target.startTime,
          amountPaid: paid ? Number(target.amountPaid) : 0, refundAmount: quote.amount, refundPct: quote.pct, currency,
          ...(target.membershipId ? { coveredBy: target.membershipPlan } : {}),
          message: paid
            ? `Cancelling now refunds ${formatMoney(quote.amount, currency)} of the ${formatMoney(quote.refundable, currency)} paid (${quote.pct}% under the cancellation policy). Ask the customer to confirm.`
            : target.membershipId
              ? `This booking is covered by ${target.membershipPlan || 'their membership'}, so cancelling gives the ${serviceLabel} back to it (no money moves). Ask the customer to confirm.`
              : 'Nothing was paid for this booking, so there is no refund. Ask the customer to confirm the cancellation.'
        }
      }
      if (ctx.dryRun) {
        return { simulated: true, cancelled: true, message: `(Test) I'd cancel ${serviceLabel} and refund ${formatMoney(quote.amount, currency)} automatically.` }
      }

      // Step 2: cancel, free the seat, then move the money back.
      await updateAppointment(business.businessId, target.startTime, target.appointmentId, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: 'customer' })
      if (target.unitId) await redis.releaseSlot(business.businessId, target.startTime, target.unitId).catch(() => {})
      if (target.membershipId) {
        const left = await require('../core/memberships').afterCancel(target).catch(() => null)
        await bookingMail.cancelled({ business, appointment: target, by: 'customer', refund: { kind: 'membership', usesLeft: left } })
        return { cancelled: true, service: serviceLabel, startTime: target.startTime, refunded: false, usesLeft: left, message: `Cancelled. The ${serviceLabel} went back to ${target.membershipPlan || 'the membership'}${left != null ? ` (${left} left)` : ''}.` }
      }

      let refund = { refunded: false, amount: 0 }
      if (quote.amount > 0) {
        try {
          refund = await refundAppointment({ business, appointment: target, amount: quote.amount, reason: `${quote.pct}% refund for cancelling ${serviceLabel}`, initiatedBy: 'customer', notify: false })
        } catch (err) {
          trace.event('paypal', 'Refund failed: the business will refund by hand', { reason: String(err.message).slice(0, 80) })
          await bookingMail.cancelled({ business, appointment: target, by: 'customer', refund: { kind: 'failed', amount: quote.amount, pct: quote.pct } })
          return { cancelled: true, service: serviceLabel, startTime: target.startTime, refundPending: true,
            message: `Cancelled. The ${formatMoney(quote.amount, currency)} refund didn't go through automatically — the business will process it manually.` }
        }
      }
      // One message to the customer and one to the business, saying what happened to the money.
      const kind = refund.refunded ? 'refunded' : refund.manual ? 'manual' : paid ? 'none' : 'unpaid'
      await bookingMail.cancelled({ business, appointment: target, by: 'customer', refund: { kind, amount: refund.refunded ? refund.amount : quote.amount, pct: quote.pct, invoiceStatus: refund.invoiceStatus } })
      return {
        cancelled: true, service: serviceLabel, startTime: target.startTime,
        refunded: refund.refunded, refundAmount: refund.amount, currency, refundStatus: refund.status,
        message: refund.refunded
          ? `Cancelled. ${formatMoney(refund.amount, currency)} is on its way back to your PayPal account (usually instant, can take a few days to show on a card).`
          : (refund.manual ? `Cancelled. The business will refund ${formatMoney(quote.amount, currency)} to you directly.` : 'Cancelled. No refund applies under the cancellation policy.')
      }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}

// ── Concierge mode (ctx.catalog): one assistant across a city of businesses ──
const BUSINESS_SCOPED = new Set(['list_services', 'check_availability', 'list_staff', 'book_appointment', 'get_queue_token'])
const ACROSS_BUSINESSES = new Set(['get_my_bookings', 'cancel_booking', 'reschedule_booking', 'add_booking_note', 'pay_balance'])
const CONCIERGE_TOOLS = [
  {
    name: 'search_businesses',
    description: 'Find businesses in the city by category or what the customer wants (e.g. "haircut", "massage", "beard trim"). Returns nearest first with distance, prices, hours and the customer\'s visit history (visits, usual staff).',
    parameters: {
      category: { type: 'string', description: 'Optional: salon, barber or spa' },
      query: { type: 'string', description: 'Optional: service or business name, e.g. "haircut", "massage", "Willow"' }
    },
    required: []
  },
  {
    name: 'business_info',
    description: 'Details for one business: address, hours, staff, services, cancellation/refund policy and FAQ (parking, what to bring). Pass the customer question to also search the business documents (FAQ, policies).',
    parameters: {
      business_name: { type: 'string', description: 'Exact business name' },
      question: { type: 'string', description: 'Optional: what the customer asked, in their words, e.g. "is there parking?"' }
    },
    required: ['business_name']
  },
  {
    name: 'list_memberships',
    description: 'Memberships and packs a business offers (or every business, if none is named): what each includes, the price, the member discount, and how it is paid (PayPal monthly subscription, or one PayPal payment for a pack).',
    parameters: { business_name: { type: 'string', description: 'Optional: exact business name' } },
    required: []
  },
  {
    name: 'join_membership',
    description: 'Join a membership or buy a pack once the customer has chosen one, paid from their saved PayPal. Without confirm it returns the price to read back; only after they say yes, call again with confirm=true and that amount. A monthly membership is then charged to the same saved PayPal each month. If PayPal isn\'t connected yet it says so: ask them to connect it once.',
    parameters: {
      business_name: { type: 'string', description: 'Exact business name' },
      plan_name: { type: 'string', description: 'The plan, e.g. "Willow Monthly"' },
      confirm: { type: 'boolean', description: 'true only after the customer agreed to pay the quoted amount with their saved PayPal' },
      amount: { type: 'number', description: 'With confirm: the amount the customer agreed to, exactly as quoted' }
    },
    required: ['business_name', 'plan_name']
  },
  {
    name: 'my_memberships',
    description: "The customer's memberships and packs: uses left, renewal or expiry date, discount.",
    parameters: {},
    required: []
  },
  {
    name: 'cancel_membership',
    description: 'Cancel a monthly membership. Call WITHOUT confirm first: it says what happens (PayPal stops billing; uses already paid for last until the end of the month). Only after the customer agrees, call with confirm=true.',
    parameters: { business_name: { type: 'string' }, plan_name: { type: 'string', description: 'Optional' }, confirm: { type: 'boolean' } },
    required: ['business_name']
  },
  {
    name: 'get_my_payments',
    description: 'The customer\'s payments and refunds across every business: what they paid, what was refunded and its status.',
    parameters: {},
    required: []
  },
  {
    name: 'get_my_history',
    description: 'The customer\'s past visits across every business (where, what, with whom, when).',
    parameters: {},
    required: []
  },
  {
    name: 'get_my_invoices',
    description: 'The customer\'s PayPal invoices across every business: invoice number, business, service, amount, status (paid, partly paid, refunded) and the link to view it on PayPal. Use when they ask for an invoice, a receipt or a bill.',
    parameters: {},
    required: []
  },
  {
    name: 'send_my_invoice',
    description: 'Send the receipt PDF for one paid booking (their latest, unless they say which) to the customer\'s Flow inbox, with the PayPal invoice link when the payment has one. Only ever to their own inbox. Tell them exactly what the result says was sent.',
    parameters: {
      business_name: { type: 'string', description: 'Optional: which business' },
      service_name: { type: 'string', description: 'Optional: which service' },
      date: { type: 'string', description: 'Optional: the booking date, YYYY-MM-DD' }
    },
    required: []
  }
]

function getTools(ctx) {
  let tools = TOOLS
  // Approvals in Flow only happen over MCP (core/approvals).
  if (ctx?.channel !== 'mcp') tools = tools.filter(t => t.name !== 'check_approval')
  if (ctx?.catalog) {
    tools = tools.map(t => {
      if (!BUSINESS_SCOPED.has(t.name) && !ACROSS_BUSINESSES.has(t.name) && t.name !== 'request_refund') return t
      const scoped = BUSINESS_SCOPED.has(t.name)
      return {
        ...t,
        parameters: { business_name: { type: 'string', description: scoped ? 'Exact name of the business (from the list or search_businesses)' : 'Optional: the business, if the customer has bookings at several' }, ...t.parameters },
        required: scoped ? [...new Set(['business_name', ...(t.required || [])])] : (t.required || [])
      }
    })
    tools = [...CONCIERGE_TOOLS, ...tools]
  }
  return tools
}

// Returns { result } when handled here, or { ctx } with ctx.business set to the
// business the call is about.
async function routeConcierge(name, args, ctx) {
  const concierge = require('../core/concierge')
  const { catalog, customer } = ctx
  const location = ctx.customerLocation
  const history = () => concierge.visitHistory(catalog, customer.customerId)

  if (name === 'check_approval') return { result: await require('../core/approvals').statusFor(ctx, args.approval_id) }
  if (name === 'search_businesses') {
    const results = concierge.search(catalog, location, await history(), args)
    return { result: results.length ? { results, from: location.label } : { results: [], message: 'Nothing matches in the demo city — try salon, barber or spa.' } }
  }
  if (name === 'list_memberships' || name === 'join_membership' || name === 'my_memberships' || name === 'cancel_membership') {
    const memberships = require('../core/memberships')
    if (name === 'my_memberships') {
      const list = await memberships.forCustomer(customer.customerId, catalog)
      return { result: list.length ? { memberships: list } : { memberships: [], message: 'No memberships or packs yet.' } }
    }
    const b = args.business_name ? concierge.resolveBusiness(catalog, args.business_name) : null
    if (args.business_name && !b) return { result: { error: `No business called "${args.business_name}" here.` } }
    if (name === 'list_memberships') {
      const list = (b ? [b] : catalog).map(x => ({ business: x.name, plans: memberships.offers(x) })).filter(x => x.plans.length)
      return { result: list.length ? { offers: list } : { offers: [], message: b ? `${b.name} has no memberships or packs.` : 'No memberships or packs in the city yet.' } }
    }
    if (!b) return { result: { error: 'Which business? Pass business_name.' } }
    if (name === 'cancel_membership') return { result: await memberships.cancel({ business: b, customerId: customer.customerId, planName: args.plan_name, confirm: !!args.confirm }) }
    const savedPaypal = require('../core/savedPaypal')
    if (needsConnect(ctx, b, customer)) return { result: { ...(await connectFirst(ctx, b, customer, `the ${args.plan_name || 'plan'}`)), membership: true } }
    const saved = savedPaypal.usable(b, customer)
    if (saved) {
      const plan = memberships.findPlan(b, args.plan_name)
      if (!plan) return { result: { error: memberships.plans(b).length ? `${b.name} has no plan called "${args.plan_name}". Plans: ${memberships.plans(b).map(p => p.name).join(', ')}.` : `${b.name} doesn't offer memberships or packs.` } }
      const currency = currencyOf(b)
      const account = savedPaypal.masked(saved.email)
      const monthly = plan.kind !== 'pack'
      const what = `${plan.name} at ${b.name}${monthly ? ', then monthly' : ''}`
      const agreed = args.confirm && Math.abs(Number(args.amount) - plan.price) < 0.005
      const approvals = require('../core/approvals')
      // Over MCP the AI's own yes doesn't count: the customer approves in their Flow.
      if (approvals.needsHumanApproval(ctx)) return { result: await approvals.request({ ctx, tool: 'join_membership', args, amount: plan.price, currency, what, account, business: b, customer }) }
      if (!agreed) {
        return { result: {
          membership: true, paymentRequired: true, needsConfirm: true, savedPaypal: account, amount: plan.price, currency, service: plan.name, plan: memberships.planView(b, plan),
          message: `${args.confirm ? 'The price changed, so nothing was charged. ' : ''}Ask: "Pay ${formatMoney(plan.price, currency)} now with your saved PayPal (${account}) to ${monthly ? `join ${plan.name}? It renews monthly from the same PayPal; cancel any time by asking.` : `buy ${plan.name}?`}" Only after they say yes, call join_membership again with confirm=true and amount=${plan.price}.`
        } }
      }
      try {
        const r = await memberships.joinWithSaved({ business: b, customer, planName: plan.name, channel: ctx.channel, vaultId: saved.vaultId, amount: args.amount, clientMetadataId: require('../core/riskData').clientMetadataId(ctx) })
        if (r.paid) {
          return { result: {
            membership: true, paid: true, paidWithSaved: true, joined: true, kind: r.kind, savedPaypal: account, amount: plan.price, currency, service: plan.name, plan: r.plan,
            message: `Paid ${formatMoney(plan.price, currency)} with the saved PayPal (${account}). ${plan.name} is active now${monthly ? ' and renews monthly from the same PayPal (cancel any time by asking)' : ''}. The receipt is in the Flow inbox.`
          } }
        }
        if (r.paymentUrl) {
          return { result: { membership: true, paymentRequired: true, paymentUrl: r.paymentUrl, paymentKind: r.kind === 'pack' ? 'pack' : 'subscription', amount: plan.price, currency, plan: r.plan, message: `PayPal wants to confirm this one on its own page: ${formatMoney(plan.price, currency)} for ${plan.name}. Use the PayPal button.` } }
        }
        return { result: { error: `${plan.name} didn't go through (${r.status || 'unknown'}); nothing more was charged.` } }
      } catch (err) {
        if (['NO_PLAN', 'ALREADY', 'PRICE_CHANGED', 'PAY_FAILED'].includes(err.code)) return { result: { error: err.message } }
        throw err
      }
    }
    // A business paid into its own PayPal account (not the demo's): its own PayPal page, as before.
    try {
      const r = await memberships.join({ business: b, customer, planName: args.plan_name, channel: ctx.channel })
      // A speaker can't show a button and an MCP client may not render one: the link goes to their inbox too.
      if ((ctx.channel === 'speaker' || ctx.channel === 'mcp') && require('./demoInbox').customerInbox(customer)) {
        await require('./notify').notifyCustomer({ business: b, customer, channel: 'inbox', kind: 'payment_link', subject: `${r.kind === 'pack' ? 'Buy' : 'Join'} ${r.plan.name} at ${b.name}`, text: `${r.message.replace(' with the PayPal button below', ' with PayPal')}\n${r.paymentUrl}` }).catch(() => {})
      }
      return { result: { ...r, membership: true, paymentKind: r.kind === 'pack' ? 'pack' : 'subscription', ...(ctx.channel === 'speaker' ? { sentToInbox: true, message: r.message.replace(' with the PayPal button below', ': the PayPal link is in your Flow inbox') } : {}) } }
    } catch (err) {
      if (['NO_PLAN', 'ALREADY', 'PAYPAL_UNAVAILABLE'].includes(err.code)) return { result: { error: err.message } }
      throw err
    }
  }

  if (name === 'get_my_payments' || name === 'get_my_history') {
    const now = new Date().toISOString()
    const rows = []
    for (const b of catalog) {
      const all = (await getAppointmentsForBusiness(b.businessId, new Date(Date.now() - 400 * 86_400_000).toISOString(), new Date(Date.now() + 60 * 86_400_000).toISOString()))
        .filter(a => a.customerId === customer.customerId && a.status !== 'blocked')
      // A moved booking keeps its payment on the new one; the old, closed one isn't a second payment.
      const movedAway = new Set(all.map(a => a.rescheduledFrom).filter(Boolean))
      for (const a of all.filter(x => !movedAway.has(x.appointmentId))) rows.push({ b, a })
    }
    rows.sort((x, y) => y.a.startTime.localeCompare(x.a.startTime))
    if (name === 'get_my_history') {
      const past = rows.filter(({ a }) => a.startTime < now && a.status !== 'cancelled')
      return { result: { visits: past.map(({ b, a }) => ({
        business: b.name, service: a.serviceName || a.serviceId, when: fmtLocal(a.startTime, tzOf(b)),
        staff: (b.config.staff || []).find(s => s.staffId === a.unitId)?.name || null
      })), message: past.length ? undefined : 'No past visits yet.' } }
    }
    // Seeded demo history is visits only: it was never charged.
    const paid = rows.filter(({ a }) => !a.seeded && (Number(a.amountPaid) > 0 || Number(a.refundAmount) > 0))
    const cur = 'USD'
    return { result: {
      payments: paid.map(({ b, a }) => ({
        business: b.name, service: a.serviceName || a.serviceId, when: fmtLocal(a.startTime, tzOf(b)), status: a.status,
        paid: formatMoney(a.amountPaid || 0, a.currency || cur),
        refunded: a.refundAmount ? formatMoney(a.refundAmount, a.currency || cur) : null,
        refund_status: a.refundStatus || null,
        paid_with: a.paymentProvider === 'paypal' && a.paymentId ? 'PayPal' : a.membershipId ? 'membership' : 'at the business',
        ...(a.status === 'cancelled' && !(a.paymentProvider === 'paypal' && a.paymentId) && Number(a.amountPaid) > Number(a.refundAmount || 0) ? { refund: 'paid at the business, so the business refunds it directly' } : {}),
        ...(a.refundRequest ? { refund_request: require('../core/refundRequests').statusText(a, a.currency || cur) } : {})
      })),
      total_paid: formatMoney(paid.reduce((n, { a }) => n + Number(a.amountPaid || 0), 0), cur),
      total_refunded: formatMoney(paid.reduce((n, { a }) => n + Number(a.refundAmount || 0), 0), cur),
      message: paid.length ? undefined : 'No payments yet.'
    } }
  }

  // Invoices: the customer's own paid bookings only.
  if (name === 'get_my_invoices' || name === 'send_my_invoice') {
    const invoices = require('../core/invoices')
    const rows = []
    for (const b of catalog) {
      const mine = (await getAppointmentsForBusiness(b.businessId, new Date(Date.now() - 400 * 86_400_000).toISOString(), new Date(Date.now() + 60 * 86_400_000).toISOString()))
        .filter(a => a.customerId === customer.customerId && !a.seeded && Number(a.amountPaid) > 0)
      for (const a of mine) rows.push({ b, a })
    }
    rows.sort((x, y) => y.a.startTime.localeCompare(x.a.startTime))
    if (name === 'get_my_invoices') {
      return { result: {
        invoices: rows.map(({ b, a }) => {
          const { problem, customer: _c, ...v } = invoices.view(b, a)
          return { ...v, view_on_paypal: a.invoiceUrl || null }
        }),
        message: rows.length ? 'Say "send me my invoice" to get the receipt PDF in your inbox.' : 'No paid bookings yet, so there are no invoices.'
      } }
    }
    let pick = rows
    if (args.business_name) {
      const b = concierge.resolveBusiness(catalog, args.business_name)
      pick = pick.filter(x => x.b.businessId === b?.businessId)
    }
    if (args.service_name) pick = pick.filter(x => (x.a.serviceName || '').toLowerCase().includes(String(args.service_name).toLowerCase()))
    if (args.date) pick = pick.filter(x => x.a.startTime.startsWith(args.date))
    if (!pick.length) return { result: { sent: false, error: 'I couldn\'t find a paid booking matching that.' } }
    if (!require('./demoInbox').customerInbox(customer)) return { result: { sent: false, error: 'There\'s no Flow inbox on your profile to send it to.' } }
    const { b, a } = pick[0]
    if (ctx.dryRun) return { result: { simulated: true, message: `(Test) I'd send the receipt for ${a.serviceName} at ${b.name} to your inbox.` } }
    const r = await invoices.sendReceipt({ business: b, appointment: a, customer })
    return { result: r.sent
      ? { sent: true, to: 'your Flow inbox', business: b.name, service: a.serviceName, invoice: a.invoiceNumber || null, message: a.invoiceNumber ? `Sent the receipt PDF and the link to PayPal invoice ${a.invoiceNumber} to your Flow inbox.` : 'Sent the receipt PDF to your Flow inbox. This payment doesn\'t have a PayPal invoice yet, so there\'s no invoice link.' }
      : { sent: false, error: r.error || 'It didn\'t go out just now.' } }
  }

  if (name === 'business_info') {
    const b = concierge.resolveBusiness(catalog, args.business_name)
    if (!b) return { result: { error: `No business called "${args.business_name}" here. Use search_businesses.` } }
    const h = await history()
    const info = concierge.businessInfo(b, location, h[b.businessId])
    const fromDocuments = args.question ? await concierge.searchDocuments(b, args.question) : null
    return { result: fromDocuments ? { ...info, fromDocuments } : info }
  }

  if (args.business_name) {
    const b = concierge.resolveBusiness(catalog, args.business_name)
    if (!b) return { result: { error: `No business called "${args.business_name}" here. Use search_businesses to find one.` } }
    return { ctx: { ...ctx, business: b } }
  }
  // Refund requests look back 60 days too (a visit that already happened), across every business.
  if (name === 'request_refund') {
    const b = args.business_name ? concierge.resolveBusiness(catalog, args.business_name) : null
    if (args.business_name && !b) return { result: { error: `No business called "${args.business_name}" here.` } }
    return { result: await require('../core/refundRequests').request({ businesses: b ? [b] : catalog, customer, args, dryRun: ctx.dryRun }) }
  }
  if (BUSINESS_SCOPED.has(name)) return { result: { error: 'Which business? Pass business_name (use search_businesses if unsure).' } }

  if (ACROSS_BUSINESSES.has(name)) {
    // Look across every business for the customer's upcoming bookings.
    const now = new Date().toISOString()
    const future = new Date(Date.now() + 60 * 86_400_000).toISOString()
    const found = []
    for (const b of catalog) {
      const mine = (await getAppointmentsForBusiness(b.businessId, now, future))
        .filter(a => a.customerId === customer.customerId && a.status !== 'cancelled' && a.status !== 'blocked')
        .filter(a => !args.date || a.startTime.startsWith(args.date))
        .filter(a => !args.service_name || (a.serviceName || '').toLowerCase().includes(String(args.service_name).toLowerCase()))
      for (const a of mine) found.push({ b, a })
    }
    if (name === 'get_my_bookings') {
      if (!found.length) return { result: { bookings: [], message: 'No upcoming bookings.' } }
      return { result: { bookings: found.map(({ b, a }) => ({
        business: b.name, service: a.serviceName || a.serviceId, when: fmtLocal(a.startTime, tzOf(b)),
        startTime: a.startTime, status: a.status, paid: a.amountPaid || 0,
        ...(a.refundRequest ? { refund_request: require('../core/refundRequests').statusText(a, a.currency || 'USD') } : {})
      })) } }
    }
    const places = [...new Set(found.map(x => x.b))]
    if (!places.length) {
      return { result: name === 'add_booking_note'
        ? { error: 'No upcoming booking to add it to, so nothing was saved. If they are booking now, pass it as notes to book_appointment.' }
        : { message: 'No matching upcoming booking found.' } }
    }
    if (places.length > 1) {
      return { result: { message: 'Bookings at more than one place — which one?', bookings: found.map(({ b, a }) => ({ business: b.name, service: a.serviceName, when: fmtLocal(a.startTime, tzOf(b)) })) } }
    }
    return { ctx: { ...ctx, business: places[0] } }
  }
  return { ctx }
}

module.exports = { TOOLS, getTools, resolveServiceByName, executeTool, hasSideEffects }
