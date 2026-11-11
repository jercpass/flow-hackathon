// @ts-check
'use strict'

// ─── Saved PayPal for customers ─────────────
// The first PayPal payment saves the customer's PayPal (PayPal Vault, with
// PayPal's own consent page). Later payments use it in one step, but only after
// the customer agrees to the exact amount (the tools quote first). The customer
// can change or remove it from Profile, chat, voice or their own AI.
//
// Stored on the customer: { vaultId, email, savedAt }. Nothing else.

const { getCustomer, updateCustomer } = require('../services/dynamo/customers')
const { saveResult, getResult } = require('../services/dynamo/processedMessages')
const { getPaymentProvider } = require('../services/payments')
const trace = require('../services/trace')
const log = require('../utils/logger')

const paypal = () => require('../services/payments/paypal')

// A saved PayPal belongs to the PayPal app that saved it, so it only pays
// businesses paid through Flow's own app (every demo business). A business
// with its own connected PayPal keeps the normal link each time.
function canSave(business) {
  if (!business || business.provider) return false
  const provider = getPaymentProvider(business)
  return provider.id === 'paypal' && provider.isConfigured(business) && !business.paypalMerchantId
}

/** The customer's saved PayPal, if it can pay this business. */
function usable(business, customer) {
  return customer?.savedPaypal?.vaultId && canSave(business) ? customer.savedPaypal : null
}

// "john.doe@example.com" → "j***@example.com": enough to recognise, nothing more.
function masked(email) {
  const [user, domain] = String(email || '').split('@')
  if (!user || !domain) return 'your PayPal account'
  return `${user[0]}***@${domain}`
}

function view(customer) {
  const s = customer?.savedPaypal
  return s?.vaultId ? { saved: true, account: masked(s.email), savedAt: s.savedAt || null } : { saved: false }
}

/** Save (or swap in) a PayPal account. The one it replaces is deleted at PayPal. */
async function remember(customerId, saved) {
  if (!customerId || !saved?.vaultId) return null
  const customer = await getCustomer(customerId)
  if (!customer) return null
  const old = customer.savedPaypal?.vaultId
  if (old === saved.vaultId) return customer.savedPaypal
  const record = { vaultId: saved.vaultId, email: saved.email || null, savedAt: new Date().toISOString() }
  await updateCustomer(customerId, { savedPaypal: record })
  // vault id → customer, for VAULT.PAYMENT-TOKEN.DELETED (onTokenDeleted).
  try { await saveResult(vaultKey(saved.vaultId), { customerId }, 400 * 24 * 60 * 60) } catch (err) { log.warn('saved_paypal_index_failed', { err: err.message }) }
  trace.event('db', old ? 'Saved PayPal swapped on the customer' : 'PayPal saved on the customer for one-step booking', { account: masked(record.email) })
  if (old) await paypal().deleteSaved(old).catch(err => log.warn('saved_paypal_old_delete_failed', { err: err.message }))
  return record
}

/** Remove: quote first, then delete at PayPal and on the customer on confirm. */
async function remove({ customer, confirm }) {
  const s = customer?.savedPaypal
  if (!s?.vaultId) return { removed: false, message: 'No PayPal is saved, so there is nothing to remove.' }
  if (!confirm) {
    return { removed: false, needsConfirm: true, account: masked(s.email), message: `This removes ${masked(s.email)} from Flow. Your next payment will open PayPal again (and can save it again). Ask the customer to confirm, then call again with confirm=true.` }
  }
  await paypal().deleteSaved(s.vaultId)
  await updateCustomer(customer.customerId, { savedPaypal: null })
  customer.savedPaypal = null
  return { removed: true, message: `Removed ${masked(s.email)}. The next payment opens PayPal again.` }
}

/**
 * "Change account": a PayPal link (no payment) where the customer logs in with
 * the other account. PayPal returns to /pay/paypal/vault/return; finishChange()
 * then swaps the saved account. The setup token → customer link is stored here,
 * so the return URL can't point the new account at someone else.
 */
async function startChange({ customer, returnTo }) {
  const api = process.env.API_URL
  const ref = `${String(customer.customerId).slice(0, 60)}-${Date.now().toString(36)}`
  const setup = await paypal().createVaultSetup({
    requestId: ref, brandName: 'Flow',
    returnUrl: `${api}/pay/paypal/vault/return`, cancelUrl: `${api}/pay/paypal/vault/cancel`
  })
  // The timeline scope travels with the link, so the return shows up in Under the hood.
  await saveResult(setupKey(setup.setupTokenId), { customerId: customer.customerId, returnTo: returnTo || null, traceScope: trace.currentScope() || null }, 60 * 60)
  return { approveUrl: setup.approveUrl, message: `Open this PayPal link and log in with the account you want to use: ${setup.approveUrl} — nothing is charged.` }
}

async function finishChange(setupTokenId) {
  const pending = await getResult(setupKey(setupTokenId))
  if (!pending?.customerId) return { status: 'not_found' }
  if (pending.status === 'saved' || pending.status === 'same') return pending     // the return page was reloaded
  const finish = async () => {
    trace.event('paypal', 'Back from PayPal: customer agreed to save PayPal', {})
    const before = (await getCustomer(pending.customerId))?.savedPaypal?.vaultId || null
    const saved = await paypal().finishVaultSetup(setupTokenId)
    const record = await remember(pending.customerId, saved)
    // PayPal hands back the same saved account when the customer logs in with it again.
    const status = !record ? 'not_found' : before === saved.vaultId ? 'same' : 'saved'
    if (status === 'same') trace.event('db', 'Same PayPal account as before: nothing to change', { account: masked(saved.email) })
    return { ...pending, status, account: masked(saved.email) }
  }
  const done = pending.traceScope ? await trace.run(pending.traceScope, finish) : await finish()
  await saveResult(setupKey(setupTokenId), done, 60 * 60)
  return done
}

async function returnToFor(setupTokenId) {
  return (await getResult(setupKey(setupTokenId)))?.returnTo || null
}

const setupKey = id => `vaultsetup:${id}`

// Ending a demo session deletes the saved account at PayPal too.
async function forget(customerId) {
  const customer = await getCustomer(customerId).catch(() => null)
  if (customer?.savedPaypal?.vaultId) await paypal().deleteSaved(customer.savedPaypal.vaultId).catch(err => log.warn('saved_paypal_forget_failed', { err: err.message }))
}

const vaultKey = id => `vault:${id}`

/**
 * VAULT.PAYMENT-TOKEN.DELETED: the customer removed Flow in their PayPal account.
 * The saved PayPal can't pay any more, so it's forgotten, and the AI spending
 * mandate (which pays with it) stops. Flow's own removals arrive here as no-ops.
 */
async function onTokenDeleted(vaultId, eventType = 'VAULT.PAYMENT-TOKEN.DELETED') {
  const ref = vaultId && await getResult(vaultKey(vaultId))
  const customer = ref?.customerId && await getCustomer(ref.customerId)
  if (!customer || customer.savedPaypal?.vaultId !== vaultId) return { forgotten: false }
  const mandateOn = !!customer.aiAllowance?.on
  await updateCustomer(customer.customerId, { savedPaypal: null, ...(mandateOn ? { aiAllowance: { ...customer.aiAllowance, on: false, endedAt: new Date().toISOString(), endedBy: 'paypal' } } : {}) })
  trace.event('webhook', `PayPal webhook: ${eventType}: the customer removed Flow in PayPal, so the saved PayPal is forgotten${mandateOn ? ' and the AI mandate stopped' : ''}`, { account: masked(customer.savedPaypal.email) })
  await require('../services/notify').notifyCustomer({
    business: null, customer, channel: 'inbox', kind: 'saved_paypal_removed',
    subject: 'Your saved PayPal was removed',
    text: `You removed Flow from your PayPal account (${masked(customer.savedPaypal.email)}), so Flow no longer has it saved${mandateOn ? ' and your AI can no longer pay on its own' : ''}. Your next payment opens PayPal again.`
  }).catch(err => log.warn('saved_paypal_removed_notice_failed', { err: err.message }))
  return { forgotten: true }
}

module.exports = { canSave, usable, masked, view, remember, remove, startChange, finishChange, returnToFor, forget, onTokenDeleted }
