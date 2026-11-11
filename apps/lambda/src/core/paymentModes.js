// @ts-check
'use strict'

// ─── Payment mode resolution ──────────────────────────────────────────────────
// v1 ships none, deposit_fixed, deposit_percent, full_prepaid (brief section G).
// subscription and package are v1.5+ — resolveAmountDue throws on them so a
// misconfigured business fails loudly instead of silently undercharging.

const V1_MODES = new Set(['none', 'deposit_fixed', 'deposit_percent', 'full_prepaid'])

/**
 * @param {object} service - business.config.services[i]
 * @returns {{ amountDue: number, requiresPayment: boolean }}
 */
function resolveAmountDue(service) {
  if (!V1_MODES.has(service.paymentMode)) {
    throw new Error(`payment_mode "${service.paymentMode}" is not supported in v1`)
  }

  // No paying at the visit: a priced service is paid when booking, so the people
  // who book turn up. "none" means free.
  if (service.paymentMode === 'none') {
    if (Number(service.price) > 0) return resolveAmountDue({ ...service, paymentMode: 'full_prepaid' })
    return { amountDue: 0, requiresPayment: false }
  }

  let amountDue
  switch (service.paymentMode) {
    case 'full_prepaid':
      amountDue = service.price
      break
    case 'deposit_fixed':
      amountDue = service.depositAmount
      break
    case 'deposit_percent':
      amountDue = (Number.isFinite(service.price) && Number.isFinite(service.depositPercent))
        ? Math.round(service.price * (service.depositPercent / 100))
        : NaN
      break
  }

  // Strict source-of-truth: a paid service's amount MUST be defined in the panel.
  // If it's missing or ≤0 we refuse the whole booking rather than charge ₹0 or send
  // a broken link. Prices never come from an uploaded document — only the panel.
  if (!Number.isFinite(amountDue) || amountDue <= 0) {
    const err = new Error('AMOUNT_NOT_CONFIGURED')
    err.code = 'AMOUNT_NOT_CONFIGURED'
    throw err
  }
  return { amountDue, requiresPayment: true }
}

module.exports = { resolveAmountDue }
