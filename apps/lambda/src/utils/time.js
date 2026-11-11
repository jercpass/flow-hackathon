// @ts-check
'use strict'

// ─── Business-timezone helpers ────────────────────────────────────────────────
// Opening hours ("09:00"), staff shifts and the times customers say are all in
// the BUSINESS's local time, while storage is UTC ISO. Everything converts here
// so nothing depends on the server's own clock/timezone (Lambda runs in UTC, a
// laptop in IST — both used to shift every slot).

const dayjs = require('dayjs')
dayjs.extend(require('dayjs/plugin/utc'))
dayjs.extend(require('dayjs/plugin/timezone'))
dayjs.extend(require('dayjs/plugin/isSameOrBefore'))

const DEFAULT_TZ = 'UTC'

function tzOf(business) {
  return business?.timezone || DEFAULT_TZ
}

// "2026-10-18" + "09:00" in tz → dayjs (UTC-aware)
function atLocal(dateIso, hhmm, tz) {
  return dayjs.tz(`${dateIso}T${hhmm}`, tz || DEFAULT_TZ)
}

// Accepts a full ISO with Z/offset (kept as is) or a local "YYYY-MM-DDTHH:mm[:ss]"
// in the business timezone → UTC ISO string. Returns null for junk.
function toUtcIso(value, tz) {
  const s = String(value || '').trim()
  if (!s) return null
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s)
  // dayjs.tz throws on junk, so only hand it a local date-time it can read.
  if (!hasZone && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return null
  try {
    const d = hasZone ? dayjs(s) : dayjs.tz(s.length === 16 ? `${s}:00` : s, tz || DEFAULT_TZ)
    return d.isValid() ? d.utc().toISOString() : null
  } catch {
    return null
  }
}

// UTC ISO → the local calendar date "YYYY-MM-DD" in tz
function localDate(iso, tz) {
  return dayjs(iso).tz(tz || DEFAULT_TZ).format('YYYY-MM-DD')
}

// UTC ISO → "Sat, Oct 18, 3 PM" or "Sat, Oct 18, 10:30 AM" in tz (what the AI should say):
// minutes only when they aren't :00, the format the AI is told to use.
function fmtLocal(iso, tz) {
  const t = dayjs(iso).tz(tz || DEFAULT_TZ)
  return t.format(t.minute() ? 'ddd, MMM D, h:mm A' : 'ddd, MMM D, h A')
}

module.exports = { dayjs, tzOf, atLocal, toUtcIso, localDate, fmtLocal }
