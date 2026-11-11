// @ts-check
'use strict'

// ─── Guided demo: set the salon up with AI ────────────────────────────────────
// A guided session starts with Willow & Co. not set up.
// The judge sends the prefilled description and sample documents to the same
// AI setup the real product uses, reviews the draft, then creates the salon.
// The FAQ and policy then go into the knowledge base the assistant answers from.
//
// Never breaks: if the AI is busy or returns nothing usable, the ready-made
// Willow config is offered instead; if the knowledge base can't be built, the
// documents are kept as the salon's plain FAQ so questions still get answers.
//
// IDs are matched to the template by name (Haircut → svc-haircut, Ana →
// staff-ana) so John's seeded visits still mean "Haircut with Ana" and "book my
// usual" keeps working, whatever IDs the AI draft came with.

const { store } = require('../services/demoStore')
const trace = require('../services/trace')
const { DESCRIPTION, DOCS, docFile } = require('../demo/setupDocs')
const { CATALOG } = require('../demo/templates')
const log = require('../utils/logger')

const DRAFT_SK = 'SETUP#draft'

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

function template() {
  return CATALOG.find(c => c.slug === 'willow').build().config
}

/** The documents panel: what each file is and what it's used for. */
function docsList() {
  return DOCS.map(({ id, title, filename, kind, use, summary, text }) => ({ id, title, filename, kind, use, summary, text }))
}

async function state(session) {
  const draft = await store().getKey(`S#${session.sid}`, DRAFT_SK)
  const setupDone = session.setupDone !== false
  // Once set up (here or from the owner's own AI), the page shows the live salon.
  let salon = null
  if (setupDone) {
    const biz = await require('../services/dynamo/businesses').getBusiness(session.businessId)
    if (biz) salon = summarize(biz.config)
  }
  return {
    mode: session.mode || 'explore',
    setupDone,
    setupSource: session.setupSource || null,
    knowledge: session.knowledge || null,
    description: DESCRIPTION,
    docs: docsList(),
    draft: draft?.draft ? { ...summarize(draft.draft), from: draft.from || 'ai' } : null,
    salon
  }
}

/**
 * Ask the AI for a draft from the description and the chosen documents.
 * @param {any} session
 * @param {{ description?: string, docIds?: string[] }} input
 */
async function generate(session, { description, docIds } = {}) {
  const demo = require('./demoSession')
  await demo.checkSetupLimit(session.sid)
  const chosen = DOCS.filter(d => (docIds || DOCS.map(x => x.id)).includes(d.id))
  // The FAQ is knowledge, not configuration: it isn't sent to the setup AI.
  const documents = chosen.filter(d => d.use !== 'knowledge').map(d => ({ title: d.title, text: d.text }))
  const text = String(description || DESCRIPTION).slice(0, 1500)

  return trace.run(`sess:${session.sid}`, async () => {
    trace.event('setup', `AI is drafting the salon from the description and ${documents.length} document${documents.length === 1 ? '' : 's'}`, { documents: documents.map(d => d.title).join(', ') || 'none' })
    const { generateConfig } = require('../services/setupAi')
    let draft
    try {
      draft = reconcile(await generateConfig({ type: 'salon', description: text, documents }))
    } catch (err) {
      log.warn('demo_setup_generate_failed', { sid: session.sid, err: err.message })
      trace.event('setup', 'The AI could not draft it right now: offered the ready-made salon', { reason: require('../utils/retry').isTransient(err) ? 'AI provider busy' : 'unusable answer' })
      throw fail('AI_UNAVAILABLE', 'The AI is busy right now. You can try again, or use the ready-made salon.')
    }
    if (!draft.services.length) {
      trace.event('setup', 'The AI found no services: offered the ready-made salon')
      throw fail('AI_UNAVAILABLE', "The AI couldn't find any services in that. Add the price list, or use the ready-made salon.")
    }
    await store().putKey(`S#${session.sid}`, DRAFT_SK, { draft }, session.expiresAt)
    const view = summarize(draft)
    trace.event('setup', `Draft ready: ${view.services.length} services, ${view.staff.length} staff${view.refundTiers.length ? `, ${view.refundTiers.length} refund rules` : ''}`, {
      services: view.services.map(s => `${s.name} $${s.price}`).join(', '),
      refunds: view.refundTiers.map(t => `${t.hoursBefore}h+ ${t.refundPct}%`).join(', ') || 'none found'
    })
    return { draft: view }
  })
}

/**
 * Create the salon from the stored draft (made by our AI on the setup page, or
 * by the owner's own AI over MCP), or from the ready-made template.
 * @param {any} session
 * @param {{ source?: 'ai'|'mcp'|'template' }} input
 */
async function apply(session, { source = 'ai' } = {}) {
  const { getBusiness, updateBusiness } = require('../services/dynamo/businesses')
  const redis = require('../services/redis')
  const tpl = template()
  const notes = []

  let config
  if (source === 'template') {
    config = { services: tpl.services, staff: tpl.staff, resources: [], availability: tpl.availability, policies: tpl.policies, ai_config: tpl.ai_config, memberships: tpl.memberships }
  } else {
    const saved = await store().getKey(`S#${session.sid}`, DRAFT_SK)
    if (!saved?.draft) throw fail('NO_DRAFT', 'Generate a draft first, or use the ready-made salon.')
    config = saved.draft
    if (!config.policies?.refundTiers?.length) {
      // Refunds are worked out by code from these tiers, so they can't be empty.
      config = { ...config, policies: { ...tpl.policies, ...(config.policies?.cancellation ? { cancellation: config.policies.cancellation } : {}) } }
      notes.push('No refund rules were found in the documents, so the standard ones were used (48h+ full, 24h+ half).')
    }
  }

  const biz = await getBusiness(session.businessId)
  const firstSetup = biz && biz.setupDone === false
  if (!biz) throw fail('SESSION_DATA_MISSING', 'Session data missing — please start a new session')
  biz.config = {
    ...biz.config,
    services:     config.services,
    staff:        config.staff,
    resources:    config.resources || [],
    availability: config.availability,
    policies:     config.policies,
    memberships:  config.memberships || [],
    ai_config:    { ...biz.config.ai_config, ...config.ai_config }
  }
  await updateBusiness(session.businessId, { config: biz.config, setupDone: true })
  await redis.invalidateBusiness(session.businessId).catch(() => {})
  await store().updateSession(session.sid, { setupDone: true, setupSource: source })
  await store().deleteKey(`S#${session.sid}`, DRAFT_SK).catch(() => {})
  // Other customers' bookings, so the owner side isn't empty once it's set up (demo/seedBookings).
  if (firstSetup) await require('../demo/seedBookings').seedOthers({ ...biz, businessId: session.businessId }, { sid: session.sid }).catch(() => 0)

  const view = summarize(biz.config)
  await trace.run(`sess:${session.sid}`, async () => {
    trace.event('setup', source === 'template' ? `${biz.name} created from the ready-made salon` : source === 'mcp' ? `${biz.name} created by the owner's own AI (MCP)` : `${biz.name} created from the AI draft`, {
      services: view.services.length, staff: view.staff.length, refunds: view.refundTiers.map(t => `${t.hoursBefore}h+ ${t.refundPct}%`).join(', ')
    })
  })
  return { applied: true, source, config: view, notes }
}

const PAY_MODE = { full: 'full_prepaid', none: 'none' }   // "none" with a price becomes full (setupAi.normalize)

/**
 * What an owner's own AI sends over MCP (create_salon / create_business), checked
 * the same way as our AI's draft (setupAi.normalize). Used for Willow and for
 * businesses a judge adds (core/addedBusiness).
 */
function draftFromInput(input) {
  const { normalize } = require('../services/setupAi')
  return normalize({
    services: (input.services || []).map(s => {
      const pay = String(s?.payment || '').toLowerCase()
      const mode = pay === 'deposit' ? (s.deposit_amount !== undefined && s.deposit_percent === undefined ? 'deposit_fixed' : 'deposit_percent') : (PAY_MODE[pay] || 'full_prepaid')
      return { name: s?.name, price: s?.price, duration: s?.minutes, unitType: 'person', paymentMode: mode, depositPercent: s?.deposit_percent, depositAmount: s?.deposit_amount }
    }),
    staff: (input.staff || []).map(p => ({ name: p?.name, services: p?.services || [] })),
    memberships: (input.memberships || []).map(p => ({
      name: p?.name, kind: p?.kind, price: p?.price, validDays: p?.valid_days,
      covers: (p?.covers || []).map(c => ({ service: c?.service_name ?? c?.service, uses: c?.uses })),
      discountPercent: p?.discount_percent, discountServices: p?.discount_services || []
    })),
    availability: input.hours ? { open: input.hours.open, close: input.hours.close, workingDays: input.hours.days } : undefined,
    policies: {
      cancellation: input.cancellation_text || '',
      reschedule: input.reschedule_text || '',
      refundTiers: (input.refund_rules || []).map(r => ({ hoursBefore: r?.hours_before, refundPct: r?.refund_percent }))
    }
  })
}

/**
 * The owner's own AI read the documents and sends the salon (MCP create_salon).
 * Same checks as the page: setupAi.normalize, then template IDs by name. Without
 * confirm it only stores the draft (the setup page shows it live) and returns
 * the summary for the owner to approve; with confirm it creates the salon.
 * @param {any} session
 * @param {{ services?: any[], staff?: any[], hours?: any, refund_rules?: any[], cancellation_text?: string, reschedule_text?: string, confirm?: boolean }} input
 */
async function createFromConfig(session, input = {}) {
  if (session.setupDone !== false) {
    return { error: 'The salon is already set up. Change it with update_service, add_service, remove_service, update_staff, set_hours or set_refund_policy.' }
  }
  const hasData = Array.isArray(input.services) && input.services.length > 0
  if (hasData) {
    const draft = reconcile(draftFromInput(input))
    if (!draft.services.length) return { error: 'No usable services in that: each needs a name, minutes and price.' }
    await store().putKey(`S#${session.sid}`, DRAFT_SK, { draft, from: 'mcp' }, session.expiresAt)
    const view = summarize(draft)
    await trace.run(`sess:${session.sid}`, async () => trace.event('setup', `The owner's own AI drafted the salon: ${view.services.length} services, ${view.staff.length} staff, ${view.refundTiers.length} refund rules, ${view.memberships.length} memberships/packs`, {
      services: view.services.map(s => `${s.name} $${s.price}`).join(', ')
    }))
    if (!input.confirm) {
      return {
        needs_confirmation: true,
        draft: view,
        message: 'Show the owner this draft (services with minutes, price and how it is paid; who does what; hours; refund rules). If they agree, call create_salon again with confirm=true (the data can be left out then). The draft is also shown on their Flow setup page.'
      }
    }
  } else if (!input.confirm) {
    return { error: 'Send the services (name, minutes, price, payment), staff, hours and refund_rules you read from the documents.' }
  }
  const out = await apply(session, { source: 'mcp' })
  return { created: true, salon: out.config, notes: out.notes, next: 'Call learn_documents to add the FAQ and policy to the knowledge base, then offer the owner changes.' }
}

/**
 * Before teaching: what each chosen document becomes in Claude's Files API
 * ("PDF, 1 page → saved as text, about 400 tokens") and the exact text, so the
 * owner sees it before saving. Stores nothing.
 * @param {any} session
 * @param {{ docIds?: string[] }} input
 */
async function learnPreview(session, { docIds } = {}) {
  const chosen = DOCS.filter(d => d.use !== 'setup' && (docIds || DOCS.map(x => x.id)).includes(d.id))
  if (!chosen.length) throw fail('NO_DOCS', 'Pick the FAQ or the policy to add to the knowledge base.')
  const { describe } = require('../services/rag')
  const out = []
  for (const d of chosen) {
    const file = await docFile(d.id)
    if (file) out.push({ id: d.id, title: d.title, ...(await describe(file.buffer, file.filename, file.contentType)) })
  }
  return { documents: out }
}

/**
 * Teach the assistant: store the knowledge documents in Claude's Files API for
 * the session's salon (services/rag). Falls back to a plain FAQ if Claude isn't
 * available.
 * @param {any} session
 * @param {{ docIds?: string[] }} input
 */
async function learn(session, { docIds } = {}) {
  const demo = require('./demoSession')
  await demo.checkSetupLimit(session.sid)
  const chosen = DOCS.filter(d => d.use !== 'setup' && (docIds || DOCS.map(x => x.id)).includes(d.id))
  if (!chosen.length) throw fail('NO_DOCS', 'Pick the FAQ or the policy to add to the knowledge base.')
  const { ingestDocument } = require('../services/rag')

  return trace.run(`sess:${session.sid}`, async () => {
    const learned = []
    let fallback = false
    for (const d of chosen) {
      const file = await docFile(d.id)
      if (!file) continue
      try {
        const t0 = Date.now()
        const r = await ingestDocument(session.businessId, file.buffer, file.filename, file.contentType)
        if (r.error) throw new Error(r.error)
        learned.push({ id: d.id, title: d.title, stored: true, already: !!r.skipped, ...(r.pages ? { pages: r.pages } : {}) })
        trace.event('knowledge', r.skipped ? `${d.title} is already in the knowledge base` : `Stored ${d.title} in Claude's Files API: Claude reads it whole when a customer asks`, { file: file.filename, type: d.kind === 'pdf' ? `PDF${r.pages ? `, ${r.pages} page${r.pages === 1 ? '' : 's'}` : ''}` : 'text' }, Date.now() - t0)
      } catch (err) {
        log.warn('demo_learn_failed', { sid: session.sid, doc: d.id, err: err.message })
        fallback = true
        learned.push({ id: d.id, title: d.title, stored: false, fallback: true })
      }
    }

    if (fallback) {
      // Keep the answers available without the Files API: the documents become the
      // salon's FAQ text, which business_info always returns.
      const { getBusiness, updateBusiness } = require('../services/dynamo/businesses')
      const biz = await getBusiness(session.businessId)
      if (biz) {
        const faq = chosen.map(d => d.text).join('\n\n').slice(0, 4000)
        await updateBusiness(session.businessId, { config: { ...biz.config, faq } })
        await require('../services/redis').invalidateBusiness(session.businessId).catch(() => {})
      }
      trace.event('knowledge', 'Claude\'s Files API unavailable right now: kept the documents as the salon\'s FAQ instead')
    }

    const prev = session.knowledge?.docs || []
    const docs = [...prev.filter(p => !learned.some(l => l.id === p.id)), ...learned]
    const knowledge = { docs, documents: docs.filter(d => d.stored).length, fallback: fallback || !!session.knowledge?.fallback }
    await store().updateSession(session.sid, { knowledge })
    return knowledge
  })
}

// Use the template's IDs for anything the template also has (by name), so the
// seeded history keeps pointing at the right service and stylist.
function reconcile(draft) {
  const tpl = template()
  const used = new Set()
  const { sameName } = require('../services/setupAi')
  const match = (list, idKey, name) => {
    const hit = list.find(x => !used.has(x[idKey]) && sameName(x.name, name))
    if (hit) used.add(hit[idKey])
    return hit?.[idKey]
  }
  const svcIds = {}
  const services = draft.services.map(s => {
    const id = match(tpl.services, 'serviceId', s.name) || s.serviceId
    svcIds[s.serviceId] = id
    return { ...s, serviceId: id }
  })
  const staff = draft.staff.map(p => ({
    ...p,
    staffId: match(tpl.staff, 'staffId', p.name) || p.staffId,
    services: p.services.map(id => svcIds[id] || id)
  }))
  const memberships = (draft.memberships || []).map(m => ({
    ...m,
    planId: match(tpl.memberships || [], 'planId', m.name) || m.planId,
    covers: (m.covers || []).map(c => ({ ...c, serviceId: svcIds[c.serviceId] || c.serviceId })),
    discountServiceIds: (m.discountServiceIds || []).map(id => svcIds[id] || id)
  }))
  return { ...draft, services, staff, memberships }
}

// What the review card shows: names instead of IDs.
function summarize(config) {
  const services = (config.services || []).map(s => ({
    name: s.name, price: s.price, duration: s.duration, paymentMode: s.paymentMode,
    depositPercent: s.depositPercent || null, depositAmount: s.depositAmount || null
  }))
  const byId = Object.fromEntries((config.services || []).map(s => [s.serviceId, s.name]))
  return {
    services,
    staff: (config.staff || []).map(p => ({ name: p.name, services: (p.services || []).map(id => byId[id]).filter(Boolean) })),
    hours: config.availability ? { open: config.availability.open, close: config.availability.close, workingDays: config.availability.workingDays } : null,
    cancellation: config.policies?.cancellation || '',
    refundTiers: config.policies?.refundTiers || [],
    memberships: (config.memberships || []).map(p => require('./memberships').planView({ config }, p))
  }
}

module.exports = { docsList, state, generate, apply, createFromConfig, learnPreview, learn, reconcile, summarize, draftFromInput, template }
