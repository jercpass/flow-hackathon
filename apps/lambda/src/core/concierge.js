// @ts-check
'use strict'

// ─── Flow concierge: one assistant, many businesses ────────────────────────
// The customer side of the demo talks to Flow itself, not to one salon's bot.
// "Book me a haircut" has to answer two real questions first:
//   1. WHICH place? — John's usual (from real past visits) or the nearest that
//      offers the service.
//   2. WHERE is John? — the persona's home, or the browser's location if it's in
//      the demo city.
// This module builds the business catalog for a session (with distance and visit
// history), the concierge system prompt, and the business resolution every
// booking tool goes through (they all take business_name in this mode).

const { getBusiness } = require('../services/dynamo/businesses')
const { getAppointmentsForBusiness } = require('../services/dynamo/appointments')
const { formatMoney } = require('../utils/money')
const { dayjs, fmtLocal } = require('../utils/time')
const { CITY, TIMEZONE } = require('../demo/templates')

const KM_PER_MILE = 1.609344

function distanceKm(a, b) {
  const R = 6371
  const rad = x => (x * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function miles(km) {
  return Math.round((km / KM_PER_MILE) * 10) / 10
}

function inCity(point) {
  return distanceKm(CITY.center, point) <= CITY.radiusKm
}

// The session's businesses, freshest from the DB. A salon that isn't set up
// yet (guided demo, before the AI setup) has nothing to book, so it's left out.
async function loadCatalog(businessIds) {
  const list = await Promise.all(businessIds.map(id => getBusiness(id)))
  return list.filter(b => b && (b.config?.services || []).some(s => s.active !== false))
}

// John's past visits per business: count, last visit, usual staff, last service.
async function visitHistory(catalog, customerId, now = Date.now()) {
  const from = new Date(now - 400 * 86_400_000).toISOString()
  const to = new Date(now).toISOString()
  const out = {}
  await Promise.all(catalog.map(async b => {
    const past = (await getAppointmentsForBusiness(b.businessId, from, to))
      .filter(a => a.customerId === customerId && a.status !== 'cancelled' && a.status !== 'blocked')
      .sort((x, y) => y.startTime.localeCompare(x.startTime))
    if (!past.length) return
    const counts = {}
    for (const a of past) if (a.unitId) counts[a.unitId] = (counts[a.unitId] || 0) + 1
    const usualId = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0]
    const staff = (b.config.staff || []).find(s => s.staffId === usualId)
    const last = past[0]
    out[b.businessId] = {
      visits: past.length,
      lastVisit: dayjs(last.startTime).tz(b.timezone || TIMEZONE).format('MMM D'),
      lastService: last.serviceName || (b.config.services || []).find(s => s.serviceId === last.serviceId)?.name || null,
      usualStaff: staff?.name || null
    }
  }))
  return out
}

const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

// Working days as short ranges: all 7 → "daily", mon..sat → "Mon–Sat",
// mon,tue,thu → "Mon, Tue, Thu".
function daysText(workingDays) {
  const on = WEEK.filter(d => (workingDays || []).includes(d))
  if (on.length === 7) return 'daily'
  const cap = d => d[0].toUpperCase() + d.slice(1)
  const runs = []
  for (const d of on) {
    const last = runs[runs.length - 1]
    if (last && WEEK.indexOf(d) === WEEK.indexOf(last[last.length - 1]) + 1) last.push(d)
    else runs.push([d])
  }
  return runs.map(r => (r.length >= 3 ? `${cap(r[0])}–${cap(r[r.length - 1])}` : r.map(cap).join(', '))).join(', ')
}

function hoursText(b) {
  const a = b.config.availability || {}
  return a.open ? `${daysText(a.workingDays)} ${fmtHour(a.open)}–${fmtHour(a.close)}` : ''
}

function fmtHour(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  const suffix = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`
}

// One business as the concierge (and the Nearby panel) sees it.
// The tones an owner can pick in Settings → Assistant. Anything else (an old or
// hand-made value) is ignored, so the owner's field can't add text to the prompt.
const TONES = ['friendly and concise', 'professional', 'casual', 'formal']
const toneOf = b => (TONES.includes(b.config?.ai_config?.tone) ? b.config.ai_config.tone : null)

function describe(b, location, history) {
  const km = b.location ? distanceKm(location, b.location) : null
  return {
    name: b.name,
    tone: toneOf(b),
    category: b.category || b.type,
    neighborhood: b.location?.neighborhood || null,
    address: b.location?.address || null,
    lat: b.location?.lat ?? null,
    lng: b.location?.lng ?? null,
    distanceMi: km == null ? null : miles(km),
    hours: hoursText(b),
    services: (b.config.services || []).filter(s => s.active).map(s => ({ name: s.name, price: formatMoney(s.price, 'USD'), minutes: s.duration })),
    staff: (b.config.staff || []).map(s => s.name),
    ...((b.config.memberships || []).some(p => p.active !== false) ? { memberships: require('./memberships').offers(b) } : {}),
    ...(history ? { visits: history.visits, lastVisit: history.lastVisit, lastService: history.lastService, usualStaff: history.usualStaff } : { visits: 0 })
  }
}

// What a customer might say → the kinds of business that fit. The demo city has
// salons, a barber and a spa; a judge can add the others (core/addedBusiness).
const CATEGORY_WORDS = {
  salon: /salon|hair|cut|colou?r|balayage|blowout|style/i,
  barber: /barber|fade|beard|shave|men'?s cut/i,
  spa: /spa|massage|facial|relax/i,
  massage: /massage|deep tissue|swedish|bodywork|relax/i,
  nails: /nail|mani|pedi|gel|acrylic/i,
  fitness: /fitness|gym|train|workout|class|yoga|pilates|exercise/i,
  tattoo: /tattoo|piercing|ink/i,
  pets: /pet|dog|cat|groom/i
}

/**
 * search_businesses: filter by category / free text, nearest first; the caller
 * (the AI) sees distance and John's history for each.
 */
function search(catalog, location, history, { category, query } = {}) {
  let list = catalog.map(b => ({ b, d: describe(b, location, history[b.businessId]) }))
  // An AI often passes what the customer wants as the category ("massage"): search for it instead.
  if (category && !list.some(x => (x.d.category || '').toLowerCase() === String(category).toLowerCase())) {
    query = query || category
    category = undefined
  }
  if (category) list = list.filter(x => (x.d.category || '').toLowerCase() === String(category).toLowerCase())
  if (query) {
    const q = String(query).toLowerCase()
    const cats = Object.entries(CATEGORY_WORDS).filter(([, re]) => re.test(q)).map(([c]) => c)
    list = list.filter(x =>
      x.d.name.toLowerCase().includes(q) ||
      x.d.services.some(s => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())) ||
      cats.includes(x.d.category) ||
      (x.d.neighborhood || '').toLowerCase().includes(q))
  }
  return list.sort((x, y) => (x.d.distanceMi ?? 99) - (y.d.distanceMi ?? 99)).map(x => x.d)
}

// Exact name, then loose contains / first-word match ("willow", "the spa").
function resolveBusiness(catalog, name) {
  const n = String(name || '').toLowerCase().replace(/^the\s+/, '').trim()
  if (!n) return null
  return catalog.find(b => b.name.toLowerCase() === n)
    || catalog.find(b => b.name.toLowerCase().includes(n) || n.includes(b.name.toLowerCase()))
    || catalog.find(b => n.includes(b.name.toLowerCase().split(/[\s&.]+/)[0]))
    || catalog.find(b => (b.category || '') === n)
    || null
}

function businessInfo(b, location, history) {
  return {
    ...describe(b, location, history),
    policies: b.config.policies?.cancellation || null,
    faq: b.config.faq || null
  }
}

// The business's own documents (knowledge base on Claude's Files API, see
// services/rag): Claude reads them all and answers, quoting its sources.
// Businesses without documents cost nothing; if it fails or the documents don't
// cover it, there's no answer and the assistant uses the FAQ/policy fields.
async function searchDocuments(b, question) {
  const trace = require('../services/trace')
  const t0 = Date.now()
  try {
    const r = await require('../services/rag').ask(b.businessId, String(question).slice(0, 300), { businessName: b.name })
    if (!r) return null
    const by = require('../utils/modelName').modelName(r.model)
    // Not named like "token": the trace hides those fields as secrets.
    const usage = r.usage ? { read: (r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0), from_cache: r.usage.cache_read_input_tokens || 0 } : {}
    trace.event('knowledge', r.answer
      ? `${by} read ${b.name}'s ${r.documents} document${r.documents === 1 ? '' : 's'} and answered, quoting ${r.sources.length} source${r.sources.length === 1 ? '' : 's'}`
      : `${by} read ${b.name}'s documents: they don't cover this`, { question: String(question).slice(0, 120), ...(r.sources[0] ? { from: r.sources[0].file } : {}), ...usage }, Date.now() - t0)
    return r.answer ? { answer: r.answer, sources: r.sources.slice(0, 3).map(s => ({ from: s.file, quote: s.quote, ...(s.page ? { page: s.page } : {}) })) } : null
  } catch (err) {
    trace.event('knowledge', `Couldn't read ${b.name}'s documents right now; answered from the FAQ`, { reason: String(err.message).slice(0, 80) })
    return null
  }
}

function buildPrompt({ customer, location, catalog, history, now = Date.now() }) {
  const local = dayjs(now).tz(TIMEZONE)
  const lines = catalog
    .map(b => describe(b, location, history[b.businessId]))
    .sort((x, y) => (x.distanceMi ?? 99) - (y.distanceMi ?? 99))
    .map(d => {
      const svcs = d.services.map(s => `${s.name} ${s.price}/${s.minutes}min`).join(', ')
      const hist = d.visits
        ? ` ${customer.name.split(' ')[0]} has been here ${d.visits} times${d.usualStaff ? `, usually with ${d.usualStaff}` : ''} (last: ${d.lastService || 'visit'} on ${d.lastVisit}).`
        : ''
      const plans = d.memberships?.length ? ` Memberships & packs: ${d.memberships.map(p => `${p.name} ${p.price} (${p.includes}${p.discount ? `; ${p.discount}` : ''})`).join('; ')}.` : ''
      return `- ${d.name} (${d.category}, ${d.neighborhood}, ${d.distanceMi} mi; ${d.hours}) — ${svcs}.${plans}${hist}${d.tone ? ` Tone: ${d.tone}.` : ''}`
    })
  const first = customer.name.split(' ')[0]
  return [
    `You are Flow, an AI booking assistant helping ${customer.name} book appointments in ${CITY.name}, TX. You can only book at the businesses listed below.`,
    // Only the date here: a prompt that changes every minute can't be cached. The
    // exact time travels with each message (timeNote, below).
    `Today is ${local.format('dddd, MMMM D, YYYY')} (${TIMEZONE}); the current time is given with each message. ${first}'s location: ${location.label || 'their location'}.`,
    // Weekday → date as a lookup, not arithmetic: "Saturday" once came out as November 1
    // when it was October 31. Changes once a day, like the date above, so caching holds.
    `The coming days: ${[1, 2, 3, 4, 5, 6, 7].map(i => local.add(i, 'day').format('ddd MMM D')).join(', ')}. Use these dates for weekday names (and "tomorrow"); never work them out.`,
    `\nBusinesses (distance from ${first}):\n${lines.join('\n')}`,
    `\nHow to help:`,
    `- If ${first} asks for a kind of service and has a usual place for it, ask first, briefly: e.g. "Your usual — Willow & Co. with Ana?" Ask one question at a time.`,
    `- If there's no usual place for that service, suggest the 2–3 nearest that offer it (name, price, distance) and let ${first} choose. Use search_businesses when unsure.`,
    `- Always pass business_name (exact name) to list_services, check_availability, list_staff and book_appointment.`,
    `- Stay with what ${first} asked for: the same business, service and person as the conversation so far. Never switch to another business or a similar-sounding name on your own (e.g. "Marco" is not "Marcus"); if a name isn't at that business, say so and ask.`,
    `- When ${first} asks what a place offers, or about packs, bundles, memberships, deals or saving on regular visits, mention its memberships and packs and that they're paid with PayPal (a monthly subscription, or one payment for a pack). When ${first} picks one, call join_membership: it returns a PayPal button. Bookings a membership or pack covers cost nothing; book_appointment works that out itself, so never promise a discount or a free booking yourself.`,
    `- Check availability before proposing times. Say times in the "local" form the tool returns, never UTC.`,
    // Without this the AI sometimes asked "Shall I book it?" after the customer had already
    // picked the time, an extra round trip before the payment question.
    `- When ${first} picks a time (e.g. "3 PM please") and it's free, that is the confirmation: call book_appointment straight away. Don't ask "Shall I book it?" first. If it returns a quote (needsConfirm), its question is the only one to ask.`,
    `- Paid services are paid from ${first}'s PayPal, linked once at the start (bookings, the rest of a deposit, packs and memberships alike). If a payment tool returns needsConnect, PayPal isn't linked yet: nothing was booked or charged; tell ${first} to connect it once with the Connect PayPal button below your message (by voice: the link is in their Flow inbox). Never offer or paste a PayPal checkout link yourself. Only if a tool itself returns a PayPal link (PayPal wants to confirm that one on its page): tell ${first} to tap the PayPal button; the slot is held for 10 minutes and it is NOT booked yet ("held for you until you pay"), until the chat shows the payment went through.`,
    customer.savedPaypal?.vaultId && customer.aiAllowance?.on
      ? `- ${first} signed an AI spending mandate (up to ${customer.aiAllowance.perBooking} a booking, ${customer.aiAllowance.perMonth} a month${customer.aiAllowance.categories?.length ? `, at ${require('./allowance').placesText(customer.aiAllowance.categories)} only` : ''}${customer.aiAllowance.expiresAt ? `, until ${String(customer.aiAllowance.expiresAt).slice(0, 10)}` : ''}) for their saved PayPal. Within it, book_appointment and pay_balance pay at once: just say it's booked and paid under the mandate. Above it, they return a quote (needsConfirm) with the reason: ask, and only after a clear yes call again with confirm=true and that amount. You can't change the allowance; ${first} does that in Profile.`
      : customer.savedPaypal?.vaultId
      ? `- ${first} has PayPal saved, so book_appointment and pay_balance first return a quote (needsConfirm). Ask ${first} the question it gives, with the exact amount; only after a clear yes, call again with confirm=true and that amount: it pays in one step and the booking is confirmed. join_membership works the same way (quote, then confirm=true with the amount); a monthly membership then renews from the same PayPal. my_saved_paypal shows, changes or removes it.`
      : `- ${first} hasn't linked PayPal yet: any payment returns needsConnect. Ask them to connect it once (Connect PayPal); after that every booking, pack and membership pays with a yes.`,
    `- Anything the business should know (allergies, sensitivities, care or accessibility needs, a reference style), whether ${first} typed it, said it in a voice note, or sent it as a photo or document, goes on the booking: as notes in book_appointment, or with add_booking_note if the booking already exists. Say where it came from (e.g. "From a doctor's note (PDF): ..."). Only say it's noted after the tool saved it. A photo comes with a photo id: pass it in photo_ids so the business sees the picture itself; only say the photo is on the booking when the tool returns photosAttached, otherwise say you noted a description of it.`,
    `- To cancel: call cancel_booking without confirm, tell ${first} the exact refund it quotes, and only confirm after they agree.`,
    `- For questions about a business (parking, products, what to do before an appointment, policies, hours), call business_info with business_name and the customer's question; answer from what it returns. fromDocuments is the answer from the business's own documents, with the document it came from; you may name it ("their FAQ says…"). Never invent prices, staff or policies.`,
    // The history keeps only the replies, not the tool calls behind them, so the model
    // once took its own FAQ answer for a guess and "corrected my earlier answer" a turn later.
    `- Your earlier replies in this conversation were already checked with the tools at the time (the calls just aren't shown). Don't look them up again unless asked, and never take back or "correct" an earlier answer unless a tool now returns something different.`,
    // Haiku once answered parking and a patch-test rule from general knowledge beside
    // the lookup, then took it back. Nothing about a place is said before its lookup.
    `- Say nothing about a business's parking, products, prep or rules until business_info has returned: no guesses, not even "usually". If ${first} doesn't name the place ("before my appointment"), it's the place of their next booking (get_my_bookings), then business_info.`,
    `- Reply in the language ${first} writes or speaks in (Spanish, Hindi, anything), even though the business details below are in English. Keep business names, prices and times exact.`,
    // The owner's Settings → Assistant → Tone, per business.
    `- Each business line ends with the Tone its owner chose. While helping with a business, write in that tone (professional, formal, casual, or friendly and concise); before a business is picked, be friendly and concise.`,
    `- Keep replies short. No tables.`,
    `- Write every time the same way: the hour, a space, then AM or PM in capitals, with minutes only when they aren't :00. For example 9 AM, 2 PM, 10:30 AM, 4:15 PM. Never "2pm", "2:00 PM", "14:00" or "two in the afternoon", and never a time without AM or PM. Days the same way every time: "Monday, October 26".`
  ].join('\n')
}

/** The exact local time, sent with the message so the system prompt stays cacheable. */
function timeNote(now = new Date()) {
  const { dayjs } = require('../utils/time')
  return `Local time now: ${dayjs(now).tz(TIMEZONE).format('dddd, MMMM D, h:mm A')} (${TIMEZONE}).`
}

// Everything a customer-side channel (web chat, voice, MCP) needs for one turn:
// every business in the session, John's location and visit history, and the
// concierge system prompt.
// onlyBusinessId: a store's own channel (its Telegram bot) books that store only.
async function sessionContext(session, business, customer, channel, { onlyBusinessId = null } = {}) {
  const { PERSONA } = require('../demo/templates')
  const ids = session.businessIds || [session.businessId]
  const catalog = await loadCatalog(onlyBusinessId && ids.includes(onlyBusinessId) ? [onlyBusinessId] : ids)
  // Always John's made-up home: a test location, never the visitor's real one.
  const customerLocation = { ...PERSONA.home, source: 'persona' }
  const visits = await visitHistory(catalog, customer.customerId)
  const systemPrompt = buildPrompt({ customer, location: customerLocation, catalog, history: visits })
  // The customer's name reaches the AI only as a token (services/pii, PRIVACY_TOKENS.md).
  const pii = await require('../services/pii').vaultFor(session, customer.name).catch(() => null)
  return { business, customer, channel, traceScope: `sess:${session.sid}`, demoSid: session.sid, catalog, customerLocation, systemPrompt, timeNote: timeNote(), pii }
}

module.exports = { sessionContext, distanceKm, miles, inCity, loadCatalog, visitHistory, describe, search, resolveBusiness, businessInfo, searchDocuments, buildPrompt, fmtLocal, daysText }
