// @ts-check
'use strict'

// ─── Money helpers ────────────────────────────────────────────────────────────
// Amounts are stored as plain numbers in major units (e.g. 40.5 = $40.50), the
// same shape the engine has always used. Every provider call and every customer-
// facing string goes through here so rounding and currency symbols are consistent.

const DEFAULT_CURRENCY = 'USD'

// Currencies PayPal accepts without decimals — sending "1000.00" for these errors.
const ZERO_DECIMAL = new Set(['JPY', 'HUF', 'TWD'])

function currencyOf(business) {
  const fallback = process.env.DEFAULT_CURRENCY || require('../config/edition').editionDefaults().currency || DEFAULT_CURRENCY
  return String(business?.config?.currency || fallback).toUpperCase()
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}

// PayPal wants amount.value as a string with the currency's exact decimals.
function toProviderValue(amount, currency) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid amount: ${amount}`)
  return ZERO_DECIMAL.has(currency) ? String(Math.round(n)) : round2(n).toFixed(2)
}

function formatMoney(amount, currency = DEFAULT_CURRENCY) {
  const n = Number(amount) || 0
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency,
      minimumFractionDigits: ZERO_DECIMAL.has(currency) || Number.isInteger(n) ? 0 : 2
    }).format(n)
  } catch {
    return `${currency} ${round2(n)}`
  }
}

module.exports = { DEFAULT_CURRENCY, currencyOf, round2, toProviderValue, formatMoney }
