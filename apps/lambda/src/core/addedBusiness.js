// @ts-check
'use strict'

// ─── A business the judge adds (phase 2) ────────
// "+ Add a business": a name, a kind and a pin on the map, which must be within
// RADIUS_MILES of John's home so it's always "nearby" for John's search, voice and
// chat. The visitor's real location is never used: John's home is the persona's.
// Then it's set up by Flow's AI (a description and price list → a draft the
// judge approves) or by the judge's own AI over MCP (create_business). Once set
// up it joins John's city, because everything reads the session's businessIds.
// Lives and dies with the session.

const { randomUUID: uuid } = require('crypto')
const { store } = require('../services/demoStore')
const trace = require('../services/trace')
const { PERSONA, TIMEZONE, demoPaypal } = require('../demo/templates')
const { distanceKm, miles } = require('./concierge')
const log = require('../utils/logger')

const RADIUS_MILES = 3
const MAX_ADDED = 2
const KM_PER_MILE = 1.609344

// The kinds a judge can pick: the id is the business's category (icons, search).
const KINDS = {
  salon: 'Hair salon', barber: 'Barber shop', spa: 'Day spa', nails: 'Nail studio', massage: 'Massage studio',
  fitness: 'Fitness studio', tattoo: 'Tattoo studio', pets: 'Pet grooming', other: 'Other'
}

// Neighbourhood centres around John's home, to label a pin without a geocoding service.
const NEIGHBORHOODS = [
  ['Travis Heights', 30.2459, -97.7414], ['South Congress', 30.2486, -97.7497], ['Bouldin Creek', 30.2530, -97.7570],
  ['Zilker', 30.2627, -97.7676], ['Downtown', 30.2672, -97.7431], ['Rainey Street', 30.2590, -97.7390],
  ['East Austin', 30.2652, -97.7305], ['Holly', 30.2550, -97.7250], ['Riverside', 30.2390, -97.7250],
  ['South Lamar', 30.2450, -97.7700], ['Dawson', 30.2330, -97.7600], ['St. Edward\'s', 30.2290, -97.7540],
  ['Galindo', 30.2290, -97.7700], ['Montopolis', 30.2320, -97.7000]
].map(([name, lat, lng]) => ({ name, lat, lng }))

const draftKey = businessId => `SETUP#draft#${businessId}`
const home = () => ({ lat: PERSONA.home.lat, lng: PERSONA.home.lng })

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/** What the add page needs: John's home, the circle, the kinds, and whether another can be added. */
function options(session) {
  return {
    home: { ...home(), label: PERSONA.home.label },
    radiusMiles: RADIUS_MILES,
    kinds: Object.entries(KINDS).map(([id, label]) => ({ id, label })),
    added: (session.addedBusinessIds || []).length,
    max: MAX_ADDED
  }
}

/** Is this spot inside the circle? Returns its distance and nearest neighbourhood. */
function place(point) {
  const lat = Number(point?.lat), lng = Number(point?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: 'Pick a spot on the map.' }
  const mi = distanceKm(home(), { lat, lng }) / KM_PER_MILE
  if (mi > RADIUS_MILES + 0.01) return { error: `That's ${miles(mi * KM_PER_MILE)} miles from the customer's home. Pick a spot inside the ${RADIUS_MILES}-mile circle.` }
  const near = NEIGHBORHOODS.map(n => ({ n, d: distanceKm(n, { lat, lng }) })).sort((a, b) => a.d - b.d)[0].n
  return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, neighborhood: near.name, miles: miles(mi * KM_PER_MILE) }
}

/** A random spot inside the circle ("Pick a spot for me"); uniform over the area, not bunched in the middle. */
function randomSpot(rand = Math.random) {
  const r = RADIUS_MILES * 0.9 * Math.sqrt(rand()) * KM_PER_MILE / 6371
  const t = 2 * Math.PI * rand()
  const h = home()
  const lat = h.lat + (r * Math.cos(t) * 180) / Math.PI
  const lng = h.lng + (r * Math.sin(t) * 180) / Math.PI / Math.cos((h.lat * Math.PI) / 180)
  return place({ lat, lng })
}

/**
 * Create the business, not set up yet. Customers don't see it until it has services.
 * @param {any} session
 * @param {{ name?: string, kind?: string, lat?: number, lng?: number }} input
 */
async function create(session, { name, kind, lat, lng } = {}) {
  const added = session.addedBusinessIds || []
  if (added.length >= MAX_ADDED) return { error: `This demo allows ${MAX_ADDED} added businesses per session.` }
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (clean.length < 2) return { error: 'Give the business a name.' }
  if (!KINDS[kind || '']) return { error: `Pick what kind of business it is: ${Object.values(KINDS).join(', ')}.` }
  const spot = place({ lat, lng })
  if (spot.error) return spot

  const { saveBusiness } = require('../services/dynamo/businesses')
  const businessId = `${session.businessId}-own-${uuid().slice(0, 8)}`
  const business = {
    businessId, name: clean, type: kind, category: kind, status: 'active', timezone: TIMEZONE, channels: {},
    ...demoPaypal(), ownerInbox: true, ownerPhone: null, demoSessionId: session.sid, createdVia: 'demo',
    addedByJudge: true, setupDone: false,
    location: { lat: spot.lat, lng: spot.lng, neighborhood: spot.neighborhood, address: `Near ${spot.neighborhood}, Austin, TX` },
    config: {
      currency: 'USD', ai_config: { tone: 'warm and concise', human_active: false },
      services: [], staff: [], resources: [], memberships: [], policies: null,
      availability: { open: '09:00', close: '18:00', workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], minNoticeHours: 1, advanceDays: 30 }
    }
  }
  await saveBusiness(business)
  await store().updateSession(session.sid, {
    businessIds: [...(session.businessIds || [session.businessId]), businessId],
    addedBusinessIds: [...added, businessId]
  })
  await trace.run(`sess:${session.sid}`, async () => trace.event('setup', `Added ${clean}: ${KINDS[kind].toLowerCase()}, ${spot.miles} mi from the customer's home (near ${spot.neighborhood})`, { set_up: 'not yet' }))
  await require('../services/demoInbox').storeMessage(session.sid, {
    role: 'owner', to: `${clean} (owner)`, from: 'Flow demo', kind: 'welcome', businessId,
    subject: `You added ${clean}`,
    text: `${clean} is on the map ${spot.miles} miles from the customer's home, near ${spot.neighborhood}.\n\nSet it up next: describe it to Flow's AI, or connect your own AI with this business's owner link. Customers can book it as soon as it has services.`
  }).catch(err => log.warn('added_business_welcome_failed', { err: err.message }))
  return { created: true, businessId, name: clean, kind, location: business.location, miles: spot.miles }
}

/** An added business of this session, or null. */
async function find(session, businessId) {
  if (!(session.addedBusinessIds || []).includes(businessId)) return null
  return require('../services/dynamo/businesses').getBusiness(businessId)
}

/** The setup page: the business, whether it's set up, and any draft waiting for approval. */
async function state(session, businessId) {
  const biz = await find(session, businessId)
  if (!biz) return { error: 'That business wasn\'t added in this session.' }
  const { summarize } = require('./demoSetup')
  const saved = await store().getKey(`S#${session.sid}`, draftKey(businessId))
  return {
    business: { businessId, name: biz.name, kind: biz.category, kindLabel: KINDS[biz.category] || biz.category, location: biz.location },
    setupDone: biz.setupDone !== false,
    draft: saved?.draft ? { ...summarize(saved.draft), from: saved.from || 'ai', notes: saved.notes || [] } : null,
    live: biz.setupDone !== false ? summarize(biz.config) : null
  }
}

/**
 * Flow's AI drafts the setup from what the judge wrote (a description, a price list).
 * @param {any} session
 * @param {string} businessId
 * @param {{ description?: string }} input
 */
async function draft(session, businessId, { description } = {}) {
  const biz = await find(session, businessId)
  if (!biz) return { error: 'That business wasn\'t added in this session.' }
  if (biz.setupDone !== false) return { error: `${biz.name} is already set up. Change it from Services, Staff and Policies, or ask your AI.` }
  const text = String(description || '').trim().slice(0, 4000)
  if (text.length < 20) return { error: 'Describe the business: what it offers with prices and how long each takes, who works there, opening hours, and the cancellation policy.' }
  await require('./demoSession').checkSetupLimit(session.sid)
  return trace.run(`sess:${session.sid}`, async () => {
    trace.event('setup', `AI is drafting ${biz.name} (${KINDS[biz.category] || biz.category}) from the owner's description`)
    let out
    try {
      out = fitForBooking(await require('../services/setupAi').generateConfig({ type: KINDS[biz.category] || biz.category, description: `${biz.name}. ${text}` }))
    } catch (err) {
      log.warn('added_business_draft_failed', { sid: session.sid, err: err.message })
      return { error: 'The AI is busy right now. Try again in a moment, or set it up from your own AI.' }
    }
    if (!out.draft.services.length) return { error: 'The AI found no services in that. Add what you offer, with prices and how long each takes.' }
    await store().putKey(`S#${session.sid}`, draftKey(businessId), { draft: out.draft, from: 'ai', notes: out.notes }, session.expiresAt)
    const view = require('./demoSetup').summarize(out.draft)
    trace.event('setup', `Draft ready for ${biz.name}: ${view.services.length} services, ${view.staff.length} staff`, { services: view.services.map(s => `${s.name} $${s.price}`).join(', ') })
    return { draft: { ...view, from: 'ai', notes: out.notes } }
  })
}

/**
 * The judge's own AI sends the setup over MCP (create_business): the same checks.
 * Without confirm it stores the draft and returns it to show the owner; with confirm it creates it.
 */
async function createFromConfig(session, business, input = {}) {
  if (business.setupDone !== false) return { error: `${business.name} is already set up. Change it with update_service, add_service, remove_service, update_staff, set_hours or set_refund_policy.` }
  if (Array.isArray(input.services) && input.services.length) {
    const out = fitForBooking(require('./demoSetup').draftFromInput(input))
    if (!out.draft.services.length) return { error: 'No usable services in that: each needs a name, minutes and price.' }
    await store().putKey(`S#${session.sid}`, draftKey(business.businessId), { draft: out.draft, from: 'mcp', notes: out.notes }, session.expiresAt)
    const view = require('./demoSetup').summarize(out.draft)
    await trace.run(`sess:${session.sid}`, async () => trace.event('setup', `The owner's own AI drafted ${business.name}: ${view.services.length} services, ${view.staff.length} staff`, { services: view.services.map(s => `${s.name} $${s.price}`).join(', ') }))
    if (!input.confirm) {
      return { needs_confirmation: true, draft: view, notes: out.notes, message: 'Show the owner this draft (services with minutes, price and how it is paid; who does what; hours; refund rules). If they agree, call create_business again with confirm=true (the data can be left out then). The draft is also on their Flow setup page.' }
    }
  } else if (!input.confirm) {
    return { error: 'Send the services (name, minutes, price, payment), staff, hours and refund_rules the owner told you.' }
  }
  const r = await apply(session, business.businessId)
  return r.error ? r : { created: true, business: r.config, notes: r.notes, next: 'Customers can book it now. Offer the owner changes (prices, staff, hours, refund rules).' }
}

/** Create it from the stored draft (made by Flow's AI or the owner's own AI). */
async function apply(session, businessId) {
  const biz = await find(session, businessId)
  if (!biz) return { error: 'That business wasn\'t added in this session.' }
  if (biz.setupDone !== false) return { error: `${biz.name} is already set up.` }
  const saved = await store().getKey(`S#${session.sid}`, draftKey(businessId))
  if (!saved?.draft) return { error: 'Make a draft first.' }
  const { updateBusiness } = require('../services/dynamo/businesses')
  const d = saved.draft
  const config = { ...biz.config, services: d.services, staff: d.staff, resources: [], availability: d.availability, policies: d.policies, memberships: d.memberships || [], ai_config: { ...biz.config.ai_config, ...d.ai_config } }
  await updateBusiness(businessId, { config, setupDone: true })
  await require('../services/redis').invalidateBusiness(businessId).catch(() => {})
  await store().deleteKey(`S#${session.sid}`, draftKey(businessId)).catch(() => {})
  const view = require('./demoSetup').summarize(config)
  await trace.run(`sess:${session.sid}`, async () => trace.event('setup', `${biz.name} is set up (${saved.from === 'mcp' ? "by the owner's own AI" : "from Flow's AI draft"}): the customer can book it now`, { services: view.services.length, staff: view.staff.length }))
  return { applied: true, source: saved.from || 'ai', config: view, notes: saved.notes || [] }
}

// Make a draft bookable: everything is booked with a staff member, somebody does
// every service, and refunds have rules (they're worked out by code from them).
function fitForBooking(d) {
  const notes = []
  const services = d.services.map(s => (s.unitType === 'person' ? s : { ...s, unitType: 'person' }))
  let staff = d.staff.filter(p => p.services?.length)
  if (!staff.length) {
    staff = [{ staffId: uuid(), name: 'Owner', services: services.map(s => s.serviceId) }]
    notes.push('No staff were named, so "Owner" does every service. Rename or add people on the Staff page.')
  }
  const covered = new Set(staff.flatMap(p => p.services))
  const orphans = services.filter(s => !covered.has(s.serviceId))
  if (orphans.length) {
    staff = staff.map((p, i) => (i === 0 ? { ...p, services: [...p.services, ...orphans.map(s => s.serviceId)] } : p))
    notes.push(`${orphans.map(s => s.name).join(', ')} had nobody to do ${orphans.length === 1 ? 'it' : 'them'}, so ${staff[0].name} does ${orphans.length === 1 ? 'it' : 'them'}.`)
  }
  let policies = d.policies
  if (!policies?.refundTiers?.length) {
    const tpl = require('./demoSetup').template().policies
    policies = { ...tpl, ...(policies?.cancellation ? { cancellation: policies.cancellation } : {}) }
    notes.push('No refund rules were given, so the standard ones are used (48h+ full refund, 24h+ half). Change them on the Policies page.')
  }
  return { draft: { ...d, services, staff, resources: [], policies }, notes }
}

module.exports = { KINDS, RADIUS_MILES, MAX_ADDED, options, place, randomSpot, create, find, state, draft, createFromConfig, apply }
