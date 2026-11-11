// @ts-check
'use strict'

// ─── PayPal risk data for saved-PayPal charges ──
// PayPal wants risk data (FraudNet) on customer-started charges with a saved
// PayPal. The web chat loads PayPal's FraudNet script with this session's client
// metadata id, and the same id goes to PayPal as PayPal-Client-Metadata-Id when
// the customer says yes in the web chat. Voice, Alexa, Telegram and MCP have no
// browser to run it in, so they send none.

const crypto = require('crypto')

/** The session's id for FraudNet: stable for the session, nothing personal in it. */
function idFor(sid) {
  return crypto.createHash('sha256').update(`cmid:${sid}`).digest('hex').slice(0, 32)
}

/** For a charge the customer started in the web chat; null on other channels. */
function clientMetadataId(ctx) {
  return ctx?.channel === 'web' && ctx.demoSid ? idFor(ctx.demoSid) : null
}

/** What the web chat needs to load FraudNet. */
function fraudnet(sid) {
  return {
    clientMetadataId: idFor(sid),
    // PayPal assigns the source id per page in live; sandbox accepts any.
    source: process.env.PAYPAL_FRAUDNET_SOURCE || 'FLOW_BOOKINGS_web-chat',
    sandbox: (process.env.PAYPAL_ENV || 'sandbox') !== 'live'
  }
}

module.exports = { idFor, clientMetadataId, fraudnet }
