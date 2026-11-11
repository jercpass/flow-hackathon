// @ts-check
'use strict'

// ─── Edition ──────────────────────────────────────────────────────────────────
// Flow: USD by default, PayPal, the web inbox, and the web, voice, Telegram, Alexa
// and MCP channels. (The India edition from before the hackathon, with WhatsApp,
// Cashfree, GST invoices and a phone line, was removed on Nov 11, 2026.)

const EDITIONS = {
  global: { currency: 'USD', timezone: 'America/Chicago', brand: 'Flow' }
}

// feature → editions it is ON in
const FEATURES = {
  paypal:       ['global'],
  demoSessions: ['global']
}

function edition() {
  const e = String(process.env.EDITION || 'global').toLowerCase()
  return EDITIONS[e] ? e : 'global'
}

function isEnabled(feature) {
  const on = FEATURES[feature]
  if (!on) throw new Error(`unknown feature: ${feature}`)
  return on.includes(edition())
}

function editionDefaults() {
  return { edition: edition(), ...EDITIONS[edition()] }
}

// Everything the dashboard needs to render the edition.
function publicConfig() {
  const features = {}
  for (const f of Object.keys(FEATURES)) features[f] = isEnabled(f)
  return { ...editionDefaults(), features }
}

module.exports = { edition, isEnabled, editionDefaults, publicConfig, FEATURES }
