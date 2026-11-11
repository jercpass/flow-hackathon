// @ts-check
'use strict'

// ─── Memberships and packs ───────
// A plan on the business (config.memberships) gives a customer *uses* of
// services, plus an optional member discount on other services:
//   • monthly membership: uses every month, charged to the customer's saved
//     PayPal each month (billing 'saved_paypal'; older ones: PayPal Subscriptions)
//   • pack: uses in total, valid N days, one payment from the saved PayPal
// Link PayPal once, pay everywhere.
// What's covered, uses left and the discount are worked out here, in code; the
// AI only offers and explains. A customer's memberships live on the customer
// record; each plan's members on the business record (both wiped with a demo
// session). The PayPal billing plan is created the first time someone joins.

const { randomUUID: uuid } = require('crypto')
const { getCustomer, updateCustomer } = require('../services/dynamo/customers')
const { getBusiness, updateBusiness } = require('../services/dynamo/businesses')
const { sameName } = require('../services/setupAi')
const { formatMoney, round2, currencyOf } = require('../utils/money')
const { dayjs, fmtLocal, tzOf } = require('../utils/time')
const trace = require('../services/trace')
const log = require('../utils/logger')

const fail = (code, message) => Object.assign(new Error(message), { code })
const plural = (n, word) => `${n} ${word}${n === 1 || /s$/i.test(word) ? '' : 's'}`

// ── Plans ────────────────────────────────────────────────────────────────────

function plans(business) {
  return (business.config?.memberships || []).filter(p => p.active !== false)
}

function findPlan(business, name, { includeInactive = false } = {}) {
  const list = includeInactive ? (business.config?.memberships || []) : plans(business)
  if (!name && list.length === 1) return list[0]
  return list.find(p => p.name.toLowerCase() === String(name || '').toLowerCase()) || list.find(p => sameName(p.name, name)) || null
}

const svcName = (business, id) => (business.config?.services || []).find(s => s.serviceId === id)?.name || 'service'

function coversText(business, covers) {
  return (covers || []).map(c => plural(c.uses, svcName(business, c.serviceId))).join(', ')
}

function discountText(business, p) {
  if (!p.discountPercent) return null
  const on = (p.discountServiceIds || []).map(id => svcName(business, id))
  return `${p.discountPercent}% off ${on.length ? on.join(', ') : 'other services'}`
}

/** A plan in plain words (what the assistant, MCP and pages show). */
function planView(business, p) {
  const pack = p.kind === 'pack'
  return {
    name: p.name,
    kind: pack ? 'pack' : 'monthly membership',
    price: pack ? `${formatMoney(p.price)} once` : `${formatMoney(p.price)} a month`,
    includes: pack ? `${coversText(business, p.covers)}, to use within ${p.validDays || 180} days` : `${coversText(business, p.covers)} every month`,
    discount: discountText(business, p),
    paid_with: pack ? 'PayPal, one payment' : 'PayPal, billed monthly; cancel any time',
    ...(p.active === false ? { paused: true } : {})
  }
}

function offers(business) {
  return plans(business).map(p => planView(business, p))
}

// ── A customer's memberships ─────────────────────────────────────────────────

function freshUses(covers) {
  return Object.fromEntries((covers || []).map(c => [c.serviceId, c.uses]))
}

// Roll monthly periods forward, expire packs, end cancelled memberships.
// Returns the memberships still in force at this business (mutates the list).
function inForce(customer, businessId, now = Date.now()) {
  let changed = false
  const list = (customer.memberships || []).filter(m => m.businessId === businessId)
  for (const m of list) {
    // Charged by Flow from the saved PayPal: the next month starts only once it's paid
    // (renewDue); until then it covers nothing.
    if (m.status === 'active' && m.kind === 'monthly' && m.billing === 'saved_paypal') {
      if (now >= Date.parse(m.periodEnd)) { m.status = 'renewal_due'; changed = true }
      continue
    }
    if (m.status === 'active' && m.kind === 'monthly') {
      while (now >= Date.parse(m.periodEnd)) {
        m.periodStart = m.periodEnd
        m.periodEnd = dayjs(m.periodEnd).add(1, 'month').toISOString()
        m.uses = freshUses(m.covers)
        changed = true
      }
    }
    if (m.status === 'active' && m.kind === 'pack' && now >= Date.parse(m.periodEnd)) { m.status = 'expired'; changed = true }
    if (m.status === 'cancelled' && m.activeUntil && now >= Date.parse(m.activeUntil)) { m.status = 'ended'; changed = true }
  }
  const live = list.filter(m => m.status === 'active' || (m.status === 'cancelled' && Date.parse(m.activeUntil) > now))
  return { live, changed }
}

function membershipView(business, m) {
  const tz = tzOf(business)
  return {
    business: business.name, plan: m.planName, kind: m.kind === 'pack' ? 'pack' : 'monthly membership', status: m.status,
    uses_left: (m.covers || []).map(c => plural(m.uses?.[c.serviceId] ?? 0, svcName(business, c.serviceId))).join(', ') + (m.kind === 'pack' ? '' : ' this month'),
    discount: discountText(business, m),
    ...(m.kind === 'pack'
      ? { valid_until: fmtLocal(m.periodEnd, tz) }
      : m.status === 'cancelled' ? { ends: fmtLocal(m.activeUntil, tz), renews: false } : { renews: fmtLocal(m.periodEnd, tz), price: `${formatMoney(m.price)} a month` })
  }
}

/** What a customer's memberships give them for one service right now. */
async function coverFor(customerOrId, business, svc) {
  const customer = typeof customerOrId === 'string' ? await getCustomer(customerOrId) : await getCustomer(customerOrId.customerId)
  if (!customer?.memberships?.length) return null
  await renewDue(customer, business)
  const { live, changed } = inForce(customer, business.businessId)
  if (changed) await updateCustomer(customer.customerId, { memberships: customer.memberships })
  const covering = live.filter(m => (m.uses?.[svc.serviceId] || 0) > 0).sort((a, b) => (a.kind === 'monthly' ? -1 : 1))
  if (covering.length) {
    const m = covering[0]
    return { covered: true, membership: m, usesLeft: m.uses[svc.serviceId] - 1 }
  }
  const discounts = live.filter(m => m.discountPercent && (!(m.discountServiceIds || []).length || m.discountServiceIds.includes(svc.serviceId)))
  if (discounts.length) {
    const m = discounts.sort((a, b) => b.discountPercent - a.discountPercent)[0]
    return { covered: false, discountPercent: m.discountPercent, membership: m }
  }
  return null
}

async function changeUses(customerId, membershipId, serviceId, delta) {
  const customer = await getCustomer(customerId)
  const m = (customer?.memberships || []).find(x => x.membershipId === membershipId)
  if (!m) return null
  const max = (m.covers || []).find(c => c.serviceId === serviceId)?.uses ?? 0
  m.uses = { ...(m.uses || {}), [serviceId]: Math.max(0, Math.min(max, (m.uses?.[serviceId] || 0) + delta)) }
  await updateCustomer(customerId, { memberships: customer.memberships })
  return m.uses[serviceId]
}
const useOne = (customerId, membershipId, serviceId) => changeUses(customerId, membershipId, serviceId, -1)

/** A covered booking that's cancelled gives its use back (no money moved). */
async function afterCancel(appointment) {
  if (!appointment?.membershipId || !appointment.customerId) return null
  const left = await changeUses(appointment.customerId, appointment.membershipId, appointment.serviceId, +1)
  trace.event('policy', `Membership use given back: ${appointment.serviceName} (covered booking cancelled)`, { usesLeft: left })
  return left
}

// ── Joining (PayPal) ─────────────────────────────────────────────────────────

function returnUrls(business, customer, membershipId, channel) {
  const api = String(process.env.API_URL || '').replace(/\/$/, '')
  const q = `bid=${encodeURIComponent(business.businessId)}&cid=${encodeURIComponent(customer.customerId)}&mid=${membershipId}&ch=${encodeURIComponent(channel || 'web')}`
  return { returnUrl: `${api}/pay/paypal/membership/return?${q}`, cancelUrl: `${api}/pay/paypal/membership/cancel?${q}` }
}

// The PayPal billing plan behind a monthly membership: made on first join, and
// again after a price change (existing members keep the price they joined at).
async function ensurePayPalPlan(business, plan) {
  if (plan.paypalPlanId && plan.paypalPrice === plan.price) return plan.paypalPlanId
  const paypal = require('../services/payments/paypal')
  const { productId, planId } = await paypal.createMembershipPlan({ name: plan.name, price: plan.price, currency: currencyOf(business), businessName: business.name, requestId: `${plan.planId}_${String(plan.price).replace('.', '_')}` })
  const fresh = await getBusiness(business.businessId)
  const config = { ...fresh.config, memberships: (fresh.config.memberships || []).map(p => (p.planId === plan.planId ? { ...p, paypalProductId: productId, paypalPlanId: planId, paypalPrice: plan.price } : p)) }
  await updateBusiness(business.businessId, { config })
  business.config = config
  return planId
}

/**
 * Start joining: a pending membership and the PayPal link to approve it.
 * @returns {Promise<{ paymentUrl: string, kind: string, plan: any, amount: number, currency: string, message: string }>}
 */
async function join({ business, customer, planName, channel }) {
  const plan = findPlan(business, planName)
  if (!plan) throw fail('NO_PLAN', plans(business).length ? `${business.name} has no plan called "${planName}". Plans: ${plans(business).map(p => p.name).join(', ')}.` : `${business.name} doesn't offer memberships or packs.`)
  const fresh = await getCustomer(customer.customerId) || customer
  const { live } = inForce(fresh, business.businessId)
  if (live.some(m => m.planId === plan.planId && m.status === 'active')) throw fail('ALREADY', `Already a member of ${plan.name}.`)
  const paypal = require('../services/payments/paypal')
  if (!paypal.isConfigured(business)) throw fail('PAYPAL_UNAVAILABLE', `PayPal isn't connected on this demo server yet, so ${plan.name} can't be bought right now. Nothing was charged.`)

  const membershipId = uuid().replace(/-/g, '').slice(0, 10)
  const currency = currencyOf(business)
  const urls = returnUrls(business, customer, membershipId, channel)
  const base = {
    membershipId, businessId: business.businessId, businessName: business.name, planId: plan.planId, planName: plan.name,
    kind: plan.kind === 'pack' ? 'pack' : 'monthly', price: plan.price, currency, covers: plan.covers || [],
    discountPercent: plan.discountPercent || 0, discountServiceIds: plan.discountServiceIds || [], validDays: plan.validDays || null,
    status: 'pending', channel: channel || 'web', createdAt: new Date().toISOString(), traceScope: trace.currentScope()
  }
  let pending, paymentUrl
  if (base.kind === 'monthly') {
    const planId = await ensurePayPalPlan(business, plan)
    const sub = await paypal.createSubscription({ planId, customId: `${business.businessId}|${customer.customerId}|${membershipId}`, businessName: business.name, ...urls })
    pending = { ...base, provider: 'paypal', subscriptionId: sub.subscriptionId }
    paymentUrl = sub.approveUrl
  } else {
    const co = await paypal.createCheckout({ referenceId: `mbr_${membershipId}`, amount: plan.price, currency, description: `${plan.name}: ${business.name}`, business, ...urls })
    pending = { ...base, provider: 'paypal', orderId: co.providerOrderId }
    paymentUrl = co.approveUrl
  }
  const others = (fresh.memberships || []).filter(m => !(m.planId === plan.planId && m.businessId === business.businessId && m.status === 'pending'))
  await updateCustomer(customer.customerId, { memberships: [...others, pending] })
  trace.event('policy', `${customer.name || 'Customer'} started joining ${plan.name} (${base.kind === 'pack' ? 'pack' : 'monthly membership'})`, { price: planView(business, plan).price })
  return {
    paymentUrl, kind: base.kind, amount: plan.price, currency, plan: planView(business, plan),
    message: base.kind === 'pack'
      ? `Pay ${formatMoney(plan.price)} once with the PayPal button below to get ${plan.name}.`
      : `Subscribe for ${formatMoney(plan.price)} a month with the PayPal button below. PayPal bills monthly; cancel any time by asking.`
  }
}

/**
 * Join (or buy a pack) with the customer's saved PayPal: no PayPal page. The caller
 * has quoted the price and the customer said yes; `amount` is what they agreed to.
 * If PayPal wants the buyer this time, its page is returned for this one payment.
 */
async function joinWithSaved({ business, customer, planName, channel, vaultId, amount, clientMetadataId = null }) {
  const plan = findPlan(business, planName)
  if (!plan) throw fail('NO_PLAN', plans(business).length ? `${business.name} has no plan called "${planName}". Plans: ${plans(business).map(p => p.name).join(', ')}.` : `${business.name} doesn't offer memberships or packs.`)
  const fresh = await getCustomer(customer.customerId) || customer
  const { live } = inForce(fresh, business.businessId)
  if (live.some(m => m.planId === plan.planId && m.status === 'active')) throw fail('ALREADY', `Already a member of ${plan.name}.`)
  if (!(Math.abs(Number(amount) - plan.price) < 0.005)) throw fail('PRICE_CHANGED', `${plan.name} is ${formatMoney(plan.price)}, so nothing was charged.`)
  const paypal = require('../services/payments/paypal')
  const membershipId = uuid().replace(/-/g, '').slice(0, 10)
  const currency = currencyOf(business)
  const kind = plan.kind === 'pack' ? 'pack' : 'monthly'
  const base = {
    membershipId, businessId: business.businessId, businessName: business.name, planId: plan.planId, planName: plan.name,
    kind, price: plan.price, currency, covers: plan.covers || [], billing: 'saved_paypal',
    discountPercent: plan.discountPercent || 0, discountServiceIds: plan.discountServiceIds || [], validDays: plan.validDays || null,
    provider: 'paypal', status: 'pending', channel: channel || 'web', createdAt: new Date().toISOString(), traceScope: trace.currentScope()
  }
  const charge = await paypal.chargeSaved({ referenceId: `mbr_${membershipId}`, amount: plan.price, currency, description: `${plan.name}: ${business.name}`, business, vaultId, clientMetadataId, ...returnUrls(business, customer, membershipId, channel) })
  const others = (fresh.memberships || []).filter(m => !(m.planId === plan.planId && m.businessId === business.businessId && m.status === 'pending'))
  if (charge.captured?.captureStatus === 'COMPLETED') {
    const pending = { ...base, orderId: charge.providerOrderId, captureId: charge.captured.captureId, amountPaid: charge.captured.amount ?? plan.price, currency: charge.captured.currency || currency }
    await updateCustomer(customer.customerId, { memberships: [...others, pending] })
    const r = await activate({ businessId: business.businessId, customerId: customer.customerId, membershipId, source: 'saved_paypal' })
    return { ...r, paid: r.status === 'active', kind, amount: plan.price, currency, plan: planView(business, plan) }
  }
  if (charge.approveUrl) {
    await updateCustomer(customer.customerId, { memberships: [...others, { ...base, orderId: charge.providerOrderId }] })
    return { paid: false, savedNeedsApproval: true, paymentUrl: charge.approveUrl, kind, amount: plan.price, currency, plan: planView(business, plan) }
  }
  throw fail('PAY_FAILED', `PayPal didn't take the payment for ${plan.name}, so nothing changed.`)
}

/**
 * A saved-PayPal monthly membership past its month: charge the next month from the
 * saved PayPal, then start it. If that fails it's past due (covers nothing) and the
 * customer is told. Runs when the membership is next used or looked at.
 */
async function renewDue(customer, business, now = Date.now()) {
  const due = (customer?.memberships || []).filter(m => m.businessId === business.businessId && m.billing === 'saved_paypal' && m.kind === 'monthly'
    && (m.status === 'renewal_due' || (m.status === 'active' && now >= Date.parse(m.periodEnd))))
  if (!due.length) return false
  const paypal = require('../services/payments/paypal')
  const saved = require('./savedPaypal').usable(business, customer)
  for (const m of due) {
    const n = (m.renewals || 0) + 1
    let ok = false
    if (saved) {
      try {
        const charge = await paypal.chargeSaved({ referenceId: `mbr_${m.membershipId}_r${n}`, amount: m.price, currency: m.currency, description: `${m.planName} (month ${n + 1}): ${business.name}`, business, vaultId: saved.vaultId, initiator: 'MERCHANT', usagePattern: 'SUBSCRIPTION_PREPAID', ...returnUrls(business, customer, m.membershipId, m.channel) })
        if (charge.captured?.captureStatus === 'COMPLETED') {
          const start = dayjs(now)
          Object.assign(m, { status: 'active', periodStart: start.toISOString(), periodEnd: start.add(1, 'month').toISOString(), uses: freshUses(m.covers), renewals: n, lastCaptureId: charge.captured.captureId })
          ok = true
          trace.event('paypal', `${m.planName} renewed: ${formatMoney(m.price)} from the saved PayPal`, { month: n + 1 })
        }
      } catch (err) {
        log.warn('membership_renewal_failed', { membershipId: m.membershipId, err: String(err.message).slice(0, 160) })
      }
    }
    if (!ok) {
      m.status = 'past_due'
      trace.event('policy', `${m.planName} not renewed: the saved PayPal didn't pay`, { month: n + 1 })
      await require('../services/notify').notifyCustomer({ business, customer, channel: 'inbox', kind: 'membership', subject: `${m.planName}: payment needed`, text: `We couldn't charge ${formatMoney(m.price)} for another month of ${m.planName} from your saved PayPal, so it's paused. Connect your PayPal again (Profile), then ask to rejoin.` }).catch(() => {})
    }
  }
  await updateCustomer(customer.customerId, { memberships: customer.memberships })
  return true
}

/**
 * Finish joining after PayPal (return page or webhook). Checks with PayPal using
 * the ids WE stored, never ids from the URL. Idempotent.
 */
async function activate({ businessId, customerId, membershipId, source = 'return' }) {
  const customer = await getCustomer(customerId)
  const m = (customer?.memberships || []).find(x => x.membershipId === membershipId && x.businessId === businessId)
  if (!m) return { status: 'not_found' }
  if (m.status === 'active' || m.status === 'cancelled') return { status: 'active', plan: m.planName, kind: m.kind, channel: m.channel, already: true }
  const business = await getBusiness(businessId)
  if (!business) return { status: 'not_found' }
  const paypal = require('../services/payments/paypal')
  return trace.run(m.traceScope, async () => {
    if (m.kind === 'monthly' && m.subscriptionId) {
      const sub = await paypal.getSubscription(m.subscriptionId)
      if (sub.customId && sub.customId !== `${businessId}|${customerId}|${membershipId}`) return { status: 'failed', channel: m.channel }
      if (sub.status === 'APPROVAL_PENDING') return { status: 'pending', plan: m.planName, channel: m.channel }
      if (!['ACTIVE', 'APPROVED'].includes(sub.status)) return { status: 'failed', plan: m.planName, channel: m.channel }
      m.nextBillingTime = sub.nextBillingTime
      m.payerEmail = sub.payerEmail
    } else {
      // Paid from the saved PayPal: already captured (joinWithSaved). Else capture the approved order.
      const cap = m.captureId ? { captureStatus: 'COMPLETED', captureId: m.captureId, amount: m.amountPaid, currency: m.currency } : await paypal.capture(m.orderId)
      if (cap.captureStatus === 'PENDING') return { status: 'pending', plan: m.planName, channel: m.channel }
      if (cap.captureStatus !== 'COMPLETED') return { status: 'failed', plan: m.planName, channel: m.channel }
      Object.assign(m, { captureId: cap.captureId, amountPaid: cap.amount, currency: cap.currency || m.currency })
    }
    const now = dayjs()
    Object.assign(m, {
      status: 'active', startedAt: now.toISOString(), periodStart: now.toISOString(),
      periodEnd: m.kind === 'pack' ? now.add(m.validDays || 180, 'day').toISOString() : now.add(1, 'month').toISOString(),
      uses: freshUses(m.covers), activatedVia: source
    })
    // A one-off payment (a pack, or a month from the saved PayPal) gets a paid PayPal
    // invoice; memberships billed by PayPal Subscriptions use PayPal's own receipts.
    const invoices = require('./invoices')
    const paidHere = m.kind === 'pack' || m.billing === 'saved_paypal'
    if (paidHere) await invoices.issueForPack({ business, customer, membership: m })
    await updateCustomer(customerId, { memberships: customer.memberships })
    const members = [...(business.members || []).filter(x => x.membershipId !== membershipId),
      { membershipId, customerId, customerName: customer.name || 'Customer', planId: m.planId, planName: m.planName, kind: m.kind, price: m.price, status: 'active', since: m.startedAt }]
    await updateBusiness(businessId, { members })
    trace.event('db', `${customer.name || 'Customer'} is now a ${m.planName} member`, { kind: m.kind, uses: coversText(business, m.covers) })

    const notify = require('../services/notify')
    const view = membershipView(business, m)
    const receipt = paidHere ? await invoices.receiptForPack(business, customer, m) : null
    const attachments = receipt ? [receipt] : undefined
    const invoiceLine = who => (m.invoiceNumber ? `\n\n${invoices.invoiceLine(m, who)}` : '')
    await notify.notifyOwner({ business, kind: 'new_member', attachments, subject: `New ${m.kind === 'pack' ? 'pack' : 'member'}: ${customer.name || 'a customer'} joined ${m.planName}`, text: `${customer.name || 'A customer'} joined ${m.planName} (${m.kind === 'pack' ? `${formatMoney(m.price)} paid once` : m.billing === 'saved_paypal' ? `${formatMoney(m.price)} a month from their saved PayPal` : `${formatMoney(m.price)} a month, PayPal subscription`}).\nIncludes: ${coversText(business, m.covers)}${m.kind === 'pack' ? '' : ' every month'}.${invoiceLine('owner')}` }).catch(() => {})
    await notify.notifyCustomer({ business, customer, channel: 'inbox', kind: 'membership', attachments, subject: `Welcome to ${m.planName}`, text: `You're in! ${m.planName} at ${business.name}: ${view.uses_left}${view.discount ? `, plus ${view.discount}` : ''}.\n${m.kind === 'pack' ? `Use them by ${view.valid_until}.` : `${m.billing === 'saved_paypal' ? 'Your saved PayPal is charged' : 'PayPal bills'} ${formatMoney(m.price)} a month; it renews ${view.renews}. Cancel any time by asking the assistant.`}\nJust ask to book: covered bookings cost nothing.${invoiceLine('customer')}` }).catch(() => {})
    return { status: 'active', plan: m.planName, kind: m.kind, channel: m.channel }
  })
}

/** The customer backed out on PayPal: drop the pending membership. */
async function abandon({ businessId, customerId, membershipId }) {
  const customer = await getCustomer(customerId)
  const m = (customer?.memberships || []).find(x => x.membershipId === membershipId && x.businessId === businessId)
  if (m?.status === 'pending') await updateCustomer(customerId, { memberships: customer.memberships.filter(x => x !== m) })
  return { status: 'cancelled', plan: m?.planName, channel: m?.channel || 'web' }
}

// ── Cancelling ───────────────────────────────────────────────────────────────

/**
 * Stop a monthly membership: PayPal stops billing, the uses already paid for
 * stay until the end of the month. Quote first; confirm to cancel.
 */
async function cancel({ business, customerId, planName, confirm, by = 'customer' }) {
  const customer = await getCustomer(customerId)
  if (!customer) return { error: 'Customer not found.' }
  const { live, changed } = inForce(customer, business.businessId)
  if (changed) await updateCustomer(customerId, { memberships: customer.memberships })
  const candidates = live.filter(m => m.status === 'active' && (!planName || sameName(m.planName, planName)))
  if (!candidates.length) return { error: `No active membership${planName ? ` called "${planName}"` : ''} at ${business.name}.` }
  const m = candidates.find(x => x.kind === 'monthly') || candidates[0]
  const tz = tzOf(business)
  if (m.kind === 'pack') return { error: `${m.planName} is a pack: it doesn't renew, so there's nothing to cancel. ${membershipView(business, m).uses_left} left, valid until ${fmtLocal(m.periodEnd, tz)}.` }
  const changes = [`${m.billing === 'saved_paypal' ? 'Your saved PayPal stops being charged' : 'PayPal stops billing'} ${formatMoney(m.price)} a month for ${m.planName}`, `${membershipView(business, m).uses_left} stay usable until ${fmtLocal(m.periodEnd, tz)}`, 'no refund for the current month']
  if (!confirm) return { needs_confirmation: true, changes, message: `Tell ${by === 'owner' ? 'the owner' : 'the customer'} exactly this; only cancel after they agree (call again with confirm=true).` }
  if (m.subscriptionId) await require('../services/payments/paypal').cancelSubscription(m.subscriptionId, by === 'owner' ? 'Cancelled by the business' : 'Cancelled by the customer')
  Object.assign(m, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: by, activeUntil: m.periodEnd })
  await updateCustomer(customerId, { memberships: customer.memberships })
  const fresh = await getBusiness(business.businessId)
  await updateBusiness(business.businessId, { members: (fresh.members || []).map(x => (x.membershipId === m.membershipId ? { ...x, status: 'cancelled', endsAt: m.activeUntil } : x)) })
  trace.event('policy', `${m.planName} cancelled (${by}): billing stopped, uses last until ${fmtLocal(m.activeUntil, tz)}`)
  const notify = require('../services/notify')
  if (by === 'customer') await notify.notifyOwner({ business, kind: 'member_cancelled', subject: `${customer.name || 'A member'} cancelled ${m.planName}`, text: `${customer.name || 'A member'} cancelled ${m.planName}. Billing has stopped; their uses last until ${fmtLocal(m.activeUntil, tz)}.` }).catch(() => {})
  else await notify.notifyCustomer({ business, customer, channel: 'inbox', kind: 'membership', subject: `${m.planName} cancelled`, text: `${business.name} cancelled your ${m.planName}. You won't be charged again; you can still use what's left until ${fmtLocal(m.activeUntil, tz)}.` }).catch(() => {})
  return { cancelled: true, plan: m.planName, uses_until: fmtLocal(m.activeUntil, tz), changes }
}

/** A customer's memberships across the given businesses, in plain words. */
async function forCustomer(customerId, catalog) {
  const customer = await getCustomer(customerId)
  if (!customer?.memberships?.length) return []
  const out = []
  let changed = false
  for (const b of catalog) {
    await renewDue(customer, b)
    const r = inForce(customer, b.businessId)
    changed = changed || r.changed
    for (const m of r.live) out.push(membershipView(b, m))
  }
  if (changed) await updateCustomer(customerId, { memberships: customer.memberships })
  return out
}

// ── Subscription webhooks (renewals, failed payments, cancellations) ─────────

async function onSubscriptionEvent(type, resource) {
  const customId = resource.custom_id || resource.custom || ''
  const [businessId, customerId, membershipId] = String(customId).split('|')
  if (!businessId || !customerId || !membershipId) return { ignored: true }
  if (type === 'BILLING.SUBSCRIPTION.ACTIVATED') return activate({ businessId, customerId, membershipId, source: 'webhook' })
  const customer = await getCustomer(customerId)
  const m = (customer?.memberships || []).find(x => x.membershipId === membershipId)
  if (!m) return { ignored: true }
  const business = await getBusiness(businessId)
  if (type === 'PAYMENT.SALE.COMPLETED') {
    m.lastPaymentAt = resource.create_time || new Date().toISOString()
    m.paymentFailed = false
  } else if (type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
    m.paymentFailed = true
    if (business) await require('../services/notify').notifyOwner({ business, kind: 'member_payment_failed', subject: `Payment failed: ${customer.name || 'a member'} (${m.planName})`, text: `PayPal couldn't collect ${formatMoney(m.price)} for ${m.planName} from ${customer.name || 'a member'}. PayPal will retry; the membership stops if it keeps failing.` }).catch(() => {})
  } else if (['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED'].includes(type) && m.status === 'active') {
    Object.assign(m, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: 'paypal', activeUntil: m.periodEnd })
  } else {
    return { ignored: true }
  }
  await updateCustomer(customerId, { memberships: customer.memberships })
  log.info('membership_webhook', { type, membershipId })
  return { updated: true }
}

// ── The owner's side (dashboard + owner MCP) ─────────────────────────────────

// Services by name → [{ serviceId, uses }].
function resolveCovers(business, covers) {
  const out = []
  for (const c of covers || []) {
    const name = c?.service_name ?? c?.service
    const svc = (business.config.services || []).filter(s => s.active !== false).find(s => sameName(s.name, name))
    if (!svc) return { error: `No service called "${name}".` }
    const uses = Math.round(Number(c?.uses))
    if (!Number.isFinite(uses) || uses < 1 || uses > 100) return { error: 'uses must be 1–100.' }
    out.push({ serviceId: svc.serviceId, uses })
  }
  return { covers: out }
}

function resolveDiscount(business, percent, services) {
  if (percent === undefined || percent === null || percent === '') return { discountPercent: 0, discountServiceIds: [] }
  const d = Math.round(Number(percent))
  if (!Number.isFinite(d) || d < 0 || d > 90) return { error: 'discount_percent must be 0–90.' }
  const ids = []
  for (const n of services || []) {
    const svc = (business.config.services || []).find(s => sameName(s.name, n))
    if (!svc) return { error: `No service called "${n}".` }
    ids.push(svc.serviceId)
  }
  return { discountPercent: d, discountServiceIds: ids }
}

async function savePlans(business, memberships, what) {
  const config = { ...business.config, memberships }
  await updateBusiness(business.businessId, { config })
  business.config = config
  trace.event('setup', what)
  return offers(business)
}

const quote = changes => ({ needs_confirmation: true, changes, message: 'Tell the owner exactly this; if they agree, call again with the same arguments and confirm=true.' })

async function createPlan(business, { name, kind = 'monthly', price, covers, discount_percent, discount_services, valid_days, confirm }) {
  const n = String(name || '').trim().slice(0, 60)
  if (!n) return { error: 'What is the plan called?' }
  if (findPlan(business, n, { includeInactive: true })) return { error: `There is already a plan called "${n}". Use update_membership_plan.` }
  const k = String(kind).toLowerCase().startsWith('pack') ? 'pack' : 'monthly'
  const p = Math.round(Number(price) * 100) / 100
  if (!Number.isFinite(p) || p <= 0 || p > 5000) return { error: 'price must be more than $0 (and at most $5,000).' }
  const c = resolveCovers(business, covers)
  if (c.error) return c
  const d = resolveDiscount(business, discount_percent, discount_services)
  if (d.error) return d
  if (!c.covers.length && !d.discountPercent) return { error: 'A plan needs uses of at least one service (covers) or a member discount.' }
  const vd = k === 'pack' ? Math.min(730, Math.max(7, Math.round(Number(valid_days) || 180))) : null
  const plan = { planId: `plan-${uuid().slice(0, 8)}`, name: n, kind: k, price: p, covers: c.covers, ...d, ...(vd ? { validDays: vd } : {}), active: true }
  const view = planView(business, plan)
  const changes = [`new ${view.kind}: ${n}, ${view.price}`, `includes: ${view.includes}`, ...(view.discount ? [`member discount: ${view.discount}`] : []), `paid with ${view.paid_with}`]
  if (!confirm) return quote(changes)
  return { created: true, changes, plans: await savePlans(business, [...(business.config.memberships || []), plan], `Owner created ${n} (${view.price})`) }
}

async function updatePlan(business, { plan_name, new_name, price, covers, discount_percent, discount_services, active, confirm }) {
  const plan = findPlan(business, plan_name, { includeInactive: true })
  if (!plan) return { error: `No plan called "${plan_name}".` }
  const next = { ...plan }
  if (new_name) next.name = String(new_name).trim().slice(0, 60)
  if (price !== undefined) {
    const p = Math.round(Number(price) * 100) / 100
    if (!Number.isFinite(p) || p <= 0 || p > 5000) return { error: 'price must be more than $0.' }
    next.price = p
  }
  if (covers !== undefined) { const c = resolveCovers(business, covers); if (c.error) return c; next.covers = c.covers }
  if (discount_percent !== undefined) { const d = resolveDiscount(business, discount_percent, discount_services); if (d.error) return d; Object.assign(next, d) }
  if (active !== undefined) next.active = !!active
  const before = planView(business, plan), after = planView(business, next)
  // Pausing is said in words below, not as "paused: none → true".
  const changes = Object.keys(after).filter(k => k !== 'paused' && JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(k => `${k}: ${before[k] ?? 'none'} → ${after[k] ?? 'none'}`)
  if (active !== undefined && (plan.active !== false) !== next.active) changes.push(next.active ? 'offered again' : 'paused: no new members (current members keep it)')
  if (!changes.length) return { error: 'Nothing to change.' }
  if (price !== undefined && next.price !== plan.price && next.kind === 'monthly') changes.push('current members keep the price they joined at; new members pay the new price')
  if (!confirm) return quote(changes)
  return { updated: true, changes, plans: await savePlans(business, (business.config.memberships || []).map(p => (p.planId === plan.planId ? next : p)), `Owner changed ${plan.name}: ${changes[0]}`) }
}

/** Plans, members and monthly recurring revenue. */
async function overview(business) {
  const all = business.config?.memberships || []
  const members = []
  for (const x of business.members || []) {
    const customer = await getCustomer(x.customerId)
    const m = (customer?.memberships || []).find(y => y.membershipId === x.membershipId)
    if (m) inForce(customer, business.businessId)
    members.push({
      customer: x.customerName, plan: x.planName, kind: x.kind === 'pack' ? 'pack' : 'monthly', status: m?.status || x.status,
      since: fmtLocal(x.since, tzOf(business)), ...(m ? { uses_left: membershipView(business, m).uses_left } : {}),
      ...(m?.kind === 'monthly' && m.status === 'active' ? { renews: fmtLocal(m.periodEnd, tzOf(business)) } : {}),
      ...(m?.status === 'cancelled' ? { ends: fmtLocal(m.activeUntil, tzOf(business)) } : {}),
      ...(m?.paymentFailed ? { payment_failed: true } : {})
    })
  }
  const activeMonthly = (business.members || []).filter(x => x.kind === 'monthly' && x.status === 'active')
  return {
    plans: all.map(p => ({ ...planView(business, p), members: (business.members || []).filter(x => x.planId === p.planId && x.status === 'active').length })),
    members,
    monthly_recurring_revenue: formatMoney(round2(activeMonthly.reduce((n, x) => n + Number(x.price || 0), 0))),
    pack_sales: formatMoney(round2((business.members || []).filter(x => x.kind === 'pack').reduce((n, x) => n + Number(x.price || 0), 0)))
  }
}

async function cancelMember(business, { customer_name, plan_name, confirm }) {
  // Owners say first names ("cancel John's membership").
  const first = s => String(s || '').trim().toLowerCase().split(/\s+/)[0]
  const isThem = m => sameName(m.customerName, customer_name) || first(m.customerName) === first(customer_name)
  const x = (business.members || []).filter(m => m.status === 'active').find(m => isThem(m) && (!plan_name || sameName(m.planName, plan_name)))
  if (!x) return { error: `No active member called ${customer_name}.` }
  return cancel({ business, customerId: x.customerId, planName: x.planName, confirm, by: 'owner' })
}

module.exports = {
  plans, findPlan, planView, offers, inForce, membershipView, coverFor, useOne, afterCancel,
  join, joinWithSaved, renewDue, activate, abandon, cancel, forCustomer, onSubscriptionEvent, coversText, discountText, freshUses,
  createPlan, updatePlan, overview, cancelMember
}
