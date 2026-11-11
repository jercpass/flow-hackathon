'use strict'

// ─── Structured logger ────────────────────────────────────────────────────────
//
// Emits JSON lines to stdout so CloudWatch Logs Insights can query on fields:
//
//   fields @timestamp, level, event, err.message
//   | filter level = "ERROR"
//   | sort @timestamp desc
//
// Usage:
//   const log = require('../utils/logger')
//   log.info('booking_confirmed', { businessId, customerId })
//   log.warn('token_refresh_retry', { businessId, provider })
//   log.error('payment_webhook_failed', err, { businessId, amount })
// ─────────────────────────────────────────────────────────────────────────────

const IS_TEST = process.env.NODE_ENV === 'test'

function entry(level, event, errOrExtra, extra) {
  let err = null
  let ctx = extra || {}

  if (errOrExtra instanceof Error) {
    err = errOrExtra
  } else if (errOrExtra && typeof errOrExtra === 'object') {
    ctx = errOrExtra
  }

  const record = {
    level,
    event,
    ts: new Date().toISOString(),
    ...ctx,
    ...(err ? {
      err: {
        message: err.message,
        name:    err.name,
        code:    err.code,
        ...(process.env.STAGE !== 'prod' ? { stack: err.stack } : {})
      }
    } : {})
  }

  if (!IS_TEST) {
    const fn = level === 'ERROR' ? console.error : console.log
    fn(JSON.stringify(record))
  }
}

const log = {
  info:  (event, extra)           => entry('INFO',  event, extra),
  warn:  (event, extra)           => entry('WARN',  event, extra),
  error: (event, errOrCtx, extra) => entry('ERROR', event, errOrCtx, extra)
}

module.exports = log
