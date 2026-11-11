'use strict'

// ─── AI setup assistant ──────────────────────────────────────────────────────
// Turns a plain-language description (or a menu photo) into a booking-engine
// config. The AI does the REASONING (extract structure from free text); the
// advisor recommendations are RULE-BASED (deterministic, zero cost). Booking
// config and knowledge base are kept separate — this only produces config.

const { randomUUID: uuid } = require('crypto')
const ai = require('./ai')
const log = require('../utils/logger')

const SYSTEM = `You configure a booking system for a small business from its description, its documents (price list, team, policies) or a menu photo.
Output ONLY a JSON object, no prose, matching exactly:
{
  "services": [
    { "name": str, "price": number (in the business's currency, 0 if free or varies), "duration": number (minutes),
      "unitType": "person"|"resource"|"queue",
      "paymentMode": "none"|"deposit_fixed"|"deposit_percent"|"full_prepaid",
      "depositPercent": number (only for deposit_percent, e.g. 25),
      "depositAmount": number (only for deposit_fixed),
      "resourceCount": number (only for unitType "resource", e.g. 8 stations) }
  ],
  "staff": [ { "name": str, "services": [service names this person does] } ],
  "availability": { "open": "HH:MM", "close": "HH:MM", "workingDays": ["mon".."sun"] },
  "policies": {
    "cancellation": str (one or two sentences, faithful to the documents; "" if none),
    "reschedule": str ("" if none),
    "refundTiers": [ { "hoursBefore": number, "refundPct": number } ]   // widest window first; include a 0% tier at 0 hours if late cancellations get nothing
  },
  "memberships": [   // monthly memberships and prepaid packs the documents offer; [] if none
    { "name": str, "kind": "monthly"|"pack", "price": number (a month, or once for a pack),
      "covers": [ { "service": service name, "uses": number (per month, or in total for a pack) } ],
      "discountPercent": number (member discount, 0 if none), "discountServices": [service names the discount applies to],
      "validDays": number (packs only, e.g. 180 for 6 months) }
  ],
  "ai_config": { "tone": str }
}
Rules:
- unitType "person" = booked with a staff member (stylist, doctor). "resource" = shared units (room, chair, table). "queue" = walk-in token.
- paymentMode: every service with a price is paid when booking: "deposit_percent"/"deposit_fixed" if the documents mention a deposit, otherwise "full_prepaid". "none" only for free services (price 0). There is no paying at the visit.
- Staff "services" must use the exact service names from "services". If the documents don't say, list every person service.
- Default hours 09:00-18:00, Mon-Sat if unspecified. "Every day" means all seven days.
- Memberships and packs only if the documents offer them; never invent one.
- Stay faithful to the description and documents; never invent services, staff, prices or refund terms.`

/**
 * @param {{ type?: string, description?: string, documents?: { title: string, text: string }[], imageBase64?: string, mimeType?: string }} input
 */
async function generateConfig({ type, description, documents = [], imageBase64, mimeType }) {
  const parts = []
  if (imageBase64) parts.push({ data: imageBase64, mimeType: mimeType || 'image/jpeg' })
  const docs = documents.filter(d => d && d.text).map(d => `--- ${d.title} ---\n${String(d.text).slice(0, 6000)}`).join('\n\n')
  parts.push({ text: `Business type: ${type || 'general'}\n\nDescription:\n${description || '(read the menu/photo above)'}${docs ? `\n\nDocuments:\n${docs}` : ''}` })

  const { text } = await ai.generate({ system: SYSTEM, parts, json: true, maxTokens: 2500 })
  return normalize(parseJson(text))
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('setup AI returned no JSON')
  return JSON.parse(m[0])
}

// Loose name match for "Color & Gloss" vs "Colour and gloss" vs "Color + Gloss":
// lower case, filler words dropped, colour → color, then equal or one inside
// the other.
const FILLER = new Set(['and', 'the', 'a', 'with', 'n'])
const norm = s => String(s || '').toLowerCase().replace(/colour/g, 'color').split(/[^a-z0-9]+/).filter(w => w && !FILLER.has(w)).join('')
function sameName(a, b) {
  const x = norm(a), y = norm(b)
  if (!x || !y) return false
  return x === y || (Math.min(x.length, y.length) > 3 && (x.includes(y) || y.includes(x)))
}

// Turn the AI draft into a valid business.config: assign IDs, fill engine
// defaults (durationMode is REQUIRED or slots break), expand resourceCount into
// a resource pool, attach staff to the services they do, and clean the policy.
function normalize(draft) {
  const services = (draft.services || []).filter(s => s && s.name).map(s => {
    // Priced services are paid when booking (no paying at the visit); "none" = free.
    const asked = ['none', 'deposit_fixed', 'deposit_percent', 'full_prepaid'].includes(s.paymentMode) ? s.paymentMode : 'full_prepaid'
    const paymentMode = asked === 'none' && Number(s.price) > 0 ? 'full_prepaid' : asked
    return {
      serviceId:      uuid(),
      name:           String(s.name).slice(0, 80),
      price:          Math.max(0, Number(s.price) || 0),
      duration:       Math.min(600, Math.max(5, Number(s.duration) || 30)),
      durationMode:   'fixed',
      bufferAfterMins: 0,
      unitType:       ['person', 'resource', 'queue'].includes(s.unitType) ? s.unitType : 'person',
      paymentMode,
      ...(paymentMode === 'deposit_percent' ? { depositPercent: Math.min(100, Math.max(1, Number(s.depositPercent) || 25)) } : {}),
      ...(paymentMode === 'deposit_fixed' ? { depositAmount: Math.max(0, Number(s.depositAmount) || 0) } : {}),
      active:         true
    }
  })

  const maxResources = Math.max(0, ...(draft.services || [])
    .filter(s => s && s.unitType === 'resource')
    .map(s => Number(s.resourceCount) || 0))
  const resources = Array.from({ length: maxResources }, (_, i) => ({ resourceId: uuid(), name: `Unit ${i + 1}` }))

  // Staff may come as names (older prompt) or { name, services: [names] }.
  const personServices = services.filter(s => s.unitType === 'person')
  const staff = (draft.staff || []).filter(Boolean).map(p => {
    const name = typeof p === 'string' ? p : p.name
    const wanted = typeof p === 'string' ? [] : (p.services || [])
    const ids = wanted.map(w => (personServices.find(s => norm(s.name) === norm(w)) || personServices.find(s => sameName(s.name, w)))?.serviceId).filter(Boolean)
    return { staffId: uuid(), name: String(name || 'Staff').slice(0, 40), services: ids.length ? [...new Set(ids)] : personServices.map(s => s.serviceId) }
  }).filter(p => p.name)

  const a = draft.availability || {}
  const hhmm = v => (/^\d{1,2}:\d{2}$/.test(String(v || '')) ? String(v).padStart(5, '0') : null)
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  const days = Array.isArray(a.workingDays) ? a.workingDays.map(d => String(d).slice(0, 3).toLowerCase()).filter(d => DAYS.includes(d)) : []
  const availability = {
    open:           hhmm(a.open) || '09:00',
    close:          hhmm(a.close) || '18:00',
    workingDays:    days.length ? [...new Set(days)] : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    minNoticeHours: 1,
    advanceDays:    30
  }

  return {
    services,
    resources,
    staff,
    availability,
    policies: normalizePolicies(draft.policies),
    memberships: normalizeMemberships(draft.memberships, services),
    ai_config: { tone: draft.ai_config?.tone || 'friendly and concise', human_active: false }
  }
}

// Memberships and packs: services by name → ids; numbers clamped. A plan that
// covers nothing and gives no discount is dropped.
function normalizeMemberships(list, services) {
  const byName = n => (services.find(s => norm(s.name) === norm(n)) || services.find(s => sameName(s.name, n)))?.serviceId
  return (Array.isArray(list) ? list : []).filter(p => p && p.name).map(p => {
    const kind = String(p.kind || '').toLowerCase().startsWith('pack') ? 'pack' : 'monthly'
    const covers = (p.covers || []).map(c => ({ serviceId: byName(c?.service), uses: Math.min(100, Math.max(1, Math.round(Number(c?.uses) || 1))) })).filter(c => c.serviceId)
    const discountPercent = Math.min(90, Math.max(0, Math.round(Number(p.discountPercent) || 0)))
    const discountServiceIds = discountPercent ? (p.discountServices || []).map(byName).filter(Boolean) : []
    return {
      planId: `plan-${uuid().slice(0, 8)}`, name: String(p.name).slice(0, 60), kind,
      price: Math.max(0, Math.round((Number(p.price) || 0) * 100) / 100), covers, discountPercent, discountServiceIds,
      ...(kind === 'pack' ? { validDays: Math.min(730, Math.max(7, Math.round(Number(p.validDays) || 180))) } : {}),
      active: true
    }
  }).filter(p => p.price > 0 && (p.covers.length || p.discountPercent))
}

// Refund tiers: numbers only, widest window first, one tier per window, and a
// 0% tail so a late cancellation never gets an invented refund.
function normalizePolicies(p) {
  if (!p || typeof p !== 'object') return null
  const seen = new Set()
  const tiers = (Array.isArray(p.refundTiers) ? p.refundTiers : [])
    .map(t => ({ hoursBefore: Math.max(0, Math.round(Number(t?.hoursBefore))), refundPct: Math.min(100, Math.max(0, Math.round(Number(t?.refundPct)))) }))
    .filter(t => Number.isFinite(t.hoursBefore) && Number.isFinite(t.refundPct) && !seen.has(t.hoursBefore) && seen.add(t.hoursBefore))
    .sort((x, y) => y.hoursBefore - x.hoursBefore)
  if (tiers.length && tiers[tiers.length - 1].hoursBefore > 0) tiers.push({ hoursBefore: 0, refundPct: 0 })
  return {
    cancellation: String(p.cancellation || '').slice(0, 600),
    reschedule:   String(p.reschedule || '').slice(0, 600),
    refundTiers:  tiers
  }
}

// ── Advisor (rule-based, zero AI cost) ───────────────────────────────────────

const NO_SHOW_TYPES = ['salon', 'clinic', 'doctor', 'turf', 'sport', 'yoga', 'fitness', 'spa', 'dental', 'restaurant']

function getRecommendations(business) {
  const recs = []
  const services = business.config?.services || []
  const typeStr = (business.type || '').toLowerCase()

  const noShowProne = NO_SHOW_TYPES.some(t => typeStr.includes(t))
  const hasFreeBookable = services.some(s => (!s.paymentMode || s.paymentMode === 'none') && s.unitType !== 'queue')
  if (noShowProne && hasFreeBookable) {
    recs.push({
      id: 'deposit',
      title: 'Cut no-shows with a small deposit',
      body: 'Businesses like yours lose bookings to no-shows. Asking for a small deposit means customers almost always turn up — and it is collected automatically.',
      action: 'enable_deposit'
    })
  }

  return recs
}

module.exports = { generateConfig, normalize, normalizePolicies, sameName, getRecommendations }
