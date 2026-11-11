// @ts-check
'use strict'

// ─── Change the setup by asking (owner MCP tools) ─────────────────────────────
// "Make Color & Gloss $130", "Ben does colour too", "closed Sundays", "full
// refund up to 24 hours before". Each tool changes ONE business's config and
// returns the whole setup in plain words. Anything that changes what customers
// pay or get back (prices, deposits, how it's paid, refund rules, removing a
// service) quotes first and only applies with confirm=true, like refunds.

const { randomUUID: uuid } = require('crypto')
const { updateBusiness } = require('../services/dynamo/businesses')
const { sameName, normalizePolicies } = require('../services/setupAi')
const { formatMoney } = require('../utils/money')
const trace = require('../services/trace')

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_NAME = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' }
const PAYMENT = { full: 'full_prepaid', deposit: 'deposit', none: 'none' }

const active = business => (business.config.services || []).filter(s => s.active !== false)

function findService(business, name) {
  const list = active(business)
  return list.find(s => s.name.toLowerCase() === String(name || '').toLowerCase()) || list.find(s => sameName(s.name, name)) || null
}

function payText(s) {
  if (s.paymentMode === 'full_prepaid') return 'paid in full when booking'
  if (s.paymentMode === 'deposit_percent') return `${s.depositPercent}% deposit when booking`
  if (s.paymentMode === 'deposit_fixed') return `${formatMoney(s.depositAmount || 0)} deposit when booking`
  return 'free'
}

function daysText(days = []) {
  if (days.length === 7) return 'every day'
  return DAYS.filter(d => days.includes(d)).map(d => DAY_NAME[d]).join(', ')
}

function refundText(tiers = []) {
  const sorted = [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore)
  const smallest = sorted.filter(t => t.hoursBefore > 0).pop()?.hoursBefore || 0
  return sorted.map(t => `${t.hoursBefore > 0 ? `${t.hoursBefore}+ hours before` : `under ${smallest} hours`}: ${t.refundPct === 100 ? 'full refund' : t.refundPct === 0 ? 'no refund' : `${t.refundPct}% back`}`)
}

/** The whole setup in plain words (what every tool returns). */
function setupView(business) {
  const c = business.config || {}
  const byId = Object.fromEntries(active(business).map(s => [s.serviceId, s.name]))   // removed services aren't "done" by anyone
  return {
    services: active(business).map(s => ({ name: s.name, minutes: s.duration, price: formatMoney(s.price), payment: payText(s) })),
    staff: (c.staff || []).map(p => ({ name: p.name, does: (p.services || []).map(id => byId[id]).filter(Boolean) })),
    hours: c.availability ? `${c.availability.open}–${c.availability.close}, ${daysText(c.availability.workingDays)}` : 'not set',
    refunds: refundText(c.policies?.refundTiers || []),
    cancellation_policy: c.policies?.cancellation || ''
  }
}

async function save(business, config, what) {
  await updateBusiness(business.businessId, { config })
  business.config = config
  trace.event('setup', what)
  return setupView(business)
}

const quote = (changes, message) => ({ needs_confirmation: true, changes, message: message || 'Tell the owner exactly these changes; if they agree, call again with the same arguments and confirm=true.' })

// Price / payment arguments → service fields, with validation. Returns { fields, error }.
function moneyFields(current, { price, payment, deposit_percent, deposit_amount }) {
  const f = {}
  if (price !== undefined) {
    const p = Number(price)
    if (!Number.isFinite(p) || p < 0 || p > 10000) return { error: 'Price must be between $0 and $10,000.' }
    f.price = Math.round(p * 100) / 100
  }
  let kind = payment !== undefined ? PAYMENT[String(payment).toLowerCase()] : undefined
  if (payment !== undefined && !kind) return { error: 'payment must be "full", "deposit" or "none".' }
  if (!kind && (deposit_percent !== undefined || deposit_amount !== undefined)) kind = 'deposit'
  if (kind === 'deposit') {
    if (deposit_percent !== undefined) {
      const d = Number(deposit_percent)
      if (!Number.isFinite(d) || d < 1 || d > 100) return { error: 'deposit_percent must be 1–100.' }
      Object.assign(f, { paymentMode: 'deposit_percent', depositPercent: Math.round(d), depositAmount: undefined })
    } else if (deposit_amount !== undefined) {
      const d = Number(deposit_amount)
      const price2 = f.price ?? current?.price ?? 0
      if (!Number.isFinite(d) || d <= 0 || d > price2) return { error: 'deposit_amount must be more than $0 and not more than the price.' }
      Object.assign(f, { paymentMode: 'deposit_fixed', depositAmount: Math.round(d * 100) / 100, depositPercent: undefined })
    } else if (!['deposit_percent', 'deposit_fixed'].includes(current?.paymentMode)) {
      return { error: 'Say how big the deposit is: deposit_percent or deposit_amount.' }
    }
  } else if (kind) {
    // No paying at the visit: "none" is only for a free service.
    if (kind === 'none' && Number(f.price ?? current?.price ?? 0) > 0) return { error: 'A service with a price is paid when booking, in full or as a deposit, so the people who book turn up. Use payment "full" or "deposit", or set the price to 0 for a free service.' }
    Object.assign(f, { paymentMode: kind, depositPercent: undefined, depositAmount: undefined })
  }
  return { fields: f }
}

const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

function describeChange(before, after) {
  const out = []
  if (before.name !== after.name) out.push(`name: ${before.name} → ${after.name}`)
  if (before.price !== after.price) out.push(`price: ${formatMoney(before.price)} → ${formatMoney(after.price)}`)
  if (before.duration !== after.duration) out.push(`length: ${before.duration} → ${after.duration} min`)
  if (payText(before) !== payText(after)) out.push(`payment: ${payText(before)} → ${payText(after)}`)
  return out
}

async function updateService(business, { service_name, new_name, price, minutes, payment, deposit_percent, deposit_amount, confirm }) {
  const svc = findService(business, service_name)
  if (!svc) return { error: `No service called "${service_name}". Services: ${active(business).map(s => s.name).join(', ') || 'none yet'}.` }
  const m = moneyFields(svc, { price, payment, deposit_percent, deposit_amount })
  if (m.error) return { error: m.error }
  const next = clean({ ...svc, ...m.fields })
  if (new_name) next.name = String(new_name).trim().slice(0, 80)
  if (minutes !== undefined) {
    const d = Math.round(Number(minutes))
    if (!Number.isFinite(d) || d < 5 || d > 600) return { error: 'minutes must be 5–600.' }
    next.duration = d
  }
  const changes = describeChange(svc, next)
  if (!changes.length) return { error: 'Nothing to change: say the new price, length, name or how it is paid.' }
  const money = svc.price !== next.price || payText(svc) !== payText(next)
  if (money && !confirm) return quote(changes)
  const config = { ...business.config, services: business.config.services.map(s => (s.serviceId === svc.serviceId ? next : s)) }
  return { updated: true, changes, setup: await save(business, config, `Owner changed ${svc.name}: ${changes.join('; ')}`) }
}

async function addService(business, { name, minutes, price, payment = 'full', deposit_percent, deposit_amount, staff_names, confirm }) {
  const n = String(name || '').trim().slice(0, 80)
  if (!n) return { error: 'What is the new service called?' }
  if (findService(business, n)) return { error: `There is already a service called "${findService(business, n).name}". Use update_service to change it.` }
  const d = Math.round(Number(minutes))
  if (!Number.isFinite(d) || d < 5 || d > 600) return { error: 'minutes must be 5–600.' }
  if (price === undefined) return { error: 'What does it cost?' }
  const m = moneyFields(null, { price, payment, deposit_percent, deposit_amount })
  if (m.error) return { error: m.error }
  const svc = clean({ serviceId: uuid(), name: n, duration: d, durationMode: 'fixed', bufferAfterMins: 0, unitType: 'person', active: true, paymentMode: 'full_prepaid', ...m.fields })
  const staff = business.config.staff || []
  const who = Array.isArray(staff_names) && staff_names.length ? staff.filter(p => staff_names.some(x => sameName(p.name, x))) : staff
  if (Array.isArray(staff_names) && staff_names.length && !who.length) return { error: `No staff called ${staff_names.join(', ')}. Staff: ${staff.map(p => p.name).join(', ')}.` }
  const changes = [`new service: ${n}, ${d} min, ${formatMoney(svc.price)}, ${payText(svc)}`, `done by: ${who.map(p => p.name).join(', ') || 'nobody yet'}`]
  if (!confirm) return quote(changes)
  const config = {
    ...business.config,
    services: [...(business.config.services || []), svc],
    staff: staff.map(p => (who.includes(p) ? { ...p, services: [...new Set([...(p.services || []), svc.serviceId])] } : p))
  }
  return { added: true, changes, setup: await save(business, config, `Owner added ${n} (${formatMoney(svc.price)})`) }
}

async function removeService(business, { service_name, confirm }) {
  const svc = findService(business, service_name)
  if (!svc) return { error: `No service called "${service_name}".` }
  const changes = [`stop offering ${svc.name} (bookings already made stay as they are)`]
  if (!confirm) return quote(changes)
  // Kept but switched off, so past bookings still show their service.
  const config = { ...business.config, services: business.config.services.map(s => (s.serviceId === svc.serviceId ? { ...s, active: false } : s)) }
  return { removed: true, changes, setup: await save(business, config, `Owner removed ${svc.name}`) }
}

async function updateStaff(business, { staff_name, services, add_services, remove_services, new_name }) {
  const name = String(staff_name || '').trim()
  if (!name) return { error: 'Which staff member?' }
  const staff = business.config.staff || []
  let person = staff.find(p => sameName(p.name, name))
  const created = !person
  if (!person) person = { staffId: uuid(), name: name.slice(0, 40), services: [] }
  const ids = names => {
    const out = []
    for (const n of names || []) {
      const s = findService(business, n)
      if (!s) return { error: `No service called "${n}". Services: ${active(business).map(x => x.name).join(', ')}.` }
      out.push(s.serviceId)
    }
    return { ids: out }
  }
  let next = [...(person.services || [])]
  if (Array.isArray(services)) { const r = ids(services); if (r.error) return r; next = r.ids }
  if (Array.isArray(add_services)) { const r = ids(add_services); if (r.error) return r; next = [...new Set([...next, ...r.ids])] }
  if (Array.isArray(remove_services)) { const r = ids(remove_services); if (r.error) return r; next = next.filter(id => !r.ids.includes(id)) }
  if (created && !next.length) next = active(business).map(s => s.serviceId)
  const updated = { ...person, services: next, ...(new_name ? { name: String(new_name).trim().slice(0, 40) } : {}) }
  const config = { ...business.config, staff: created ? [...staff, updated] : staff.map(p => (p.staffId === person.staffId ? updated : p)) }
  const view = await save(business, config, created ? `Owner added staff member ${updated.name}` : `Owner changed ${person.name}'s services`)
  return { updated: true, created, person: view.staff.find(p => p.name === updated.name), setup: view }
}

async function setHours(business, { open, close, days }) {
  const a = business.config.availability || {}
  const hhmm = v => (/^\d{1,2}:\d{2}$/.test(String(v || '')) ? String(v).padStart(5, '0') : null)
  const o = open !== undefined ? hhmm(open) : a.open
  const c = close !== undefined ? hhmm(close) : a.close
  if (!o || !c) return { error: 'Times must be HH:MM, e.g. 09:00 and 18:00.' }
  if (o >= c) return { error: 'Opening time must be before closing time.' }
  let d = a.workingDays || []
  if (days !== undefined) {
    d = (Array.isArray(days) ? days : [days]).map(x => String(x).slice(0, 3).toLowerCase()).filter(x => DAYS.includes(x))
    if (!d.length) return { error: 'days must list mon, tue, wed, thu, fri, sat or sun.' }
  }
  const availability = { ...a, open: o, close: c, workingDays: DAYS.filter(x => d.includes(x)) }
  const config = { ...business.config, availability }
  return { updated: true, setup: await save(business, config, `Owner set hours: ${o}–${c}, ${daysText(availability.workingDays)}`) }
}

async function setRefundPolicy(business, { rules, text, confirm }) {
  if (!Array.isArray(rules) || !rules.length) return { error: 'Give the refund rules, e.g. [{hours_before: 24, refund_percent: 100}].' }
  const p = normalizePolicies({
    refundTiers: rules.map(r => ({ hoursBefore: r?.hours_before, refundPct: r?.refund_percent })),
    cancellation: text || '',
    reschedule: business.config.policies?.reschedule || ''
  })
  if (!p || !p.refundTiers.length) return { error: 'Those rules did not make sense: each needs hours_before and refund_percent.' }
  if (!p.cancellation) p.cancellation = refundText(p.refundTiers).map(s => s[0].toUpperCase() + s.slice(1)).join('. ') + '.'
  const changes = [`refunds: ${refundText(p.refundTiers).join('; ')}`, `was: ${refundText(business.config.policies?.refundTiers || []).join('; ') || 'none'}`]
  if (!confirm) return quote(changes)
  const config = { ...business.config, policies: { ...(business.config.policies || {}), ...p } }
  return { updated: true, changes, setup: await save(business, config, `Owner changed the refund rules: ${refundText(p.refundTiers).join('; ')}`) }
}

module.exports = { setupView, updateService, addService, removeService, updateStaff, setHours, setRefundPolicy, findService }
