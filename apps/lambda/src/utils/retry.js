// @ts-check
'use strict'

// Retry transient AI-provider errors (503 "high demand", 429, overloaded) a few
// times with a short backoff. Anything else is thrown immediately.

// A spent quota (Google: "You exceeded your current quota", retry in ~a minute)
// won't clear within a quick backoff, so it isn't retried here; the caller moves
// on instead (services/ai switches to the backup model, which has its own quota).
function isQuotaExhausted(err) {
  return /exceeded your current quota/i.test(String(err?.message || ''))
}

function isTransient(err) {
  if (isQuotaExhausted(err)) return false
  const s = String(err?.message || '') + ' ' + String(err?.status || '')
  return /\b(503|429|529)\b|high demand|overloaded|unavailable|ECONNRESET|ETIMEDOUT/i.test(s)
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ delays?: number[], onRetry?: (attempt: number, waitMs: number) => void }} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, { delays = [700, 1800, 3500], onRetry } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (!isTransient(err) || i >= delays.length) throw err
      if (onRetry) onRetry(i + 2, delays[i])
      await new Promise(r => setTimeout(r, delays[i]))
    }
  }
}

module.exports = { withRetry, isTransient, isQuotaExhausted }
