'use client'
import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import BusinessFilter from './BusinessFilter'

// "Under the hood": a live timeline of what the system actually did: AI steps and
// tool calls, seat holds, PayPal order/capture/refund, policy maths, bookings
// written, inbox messages, webhooks. Newest first. Polls the trace API with a
// cursor (only new events). The side panel scrolls; the list itself doesn't.

const TZ = 'America/Chicago'   // the demo city's time: every booking time is Austin's

// Each layer belongs to one group: its colour and its filter.
const GROUP = {
  ai: 'ai', tool: 'ai', setup: 'ai', knowledge: 'ai', media: 'ai',
  paypal: 'money', policy: 'money', webhook: 'money',
  db: 'booking', redis: 'booking',
  inbox: 'message', mcp: 'message', session: 'message'
}
const FILTERS = [['all', 'All'], ['ai', 'AI'], ['money', 'PayPal'], ['booking', 'Bookings'], ['message', 'Messages']]
const LABEL = {
  ai: 'AI', tool: 'Tool', redis: 'Seat hold', paypal: 'PayPal', policy: 'Policy', db: 'Booking', inbox: 'Inbox',
  webhook: 'Webhook', media: 'Media', session: 'Session', mcp: 'MCP', setup: 'AI setup', knowledge: 'Knowledge'
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/i
const SHOW = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
// A stored time (UTC, "…Z") is shown in Austin time. A time with no zone, like a
// tool's start_time "2026-11-03T09:00", is already the business's own clock:
// show it as written. new Date() would read it in the viewer's zone, so a judge
// in India saw 9 AM as "9:30 PM the day before".
const when = v => ZONED.test(v)
  ? new Date(v).toLocaleString('en-US', { timeZone: TZ, ...SHOW })
  : new Date(`${v}Z`).toLocaleString('en-US', { timeZone: 'UTC', ...SHOW })
// "endsAt" / "business_name" → "ends at" / "business name"
const RENAME = { chars: 'reply length', ms: 'took', usage: 'tokens' }
const words = k => RENAME[k] || k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
function value(v) {
  if (Array.isArray(v)) return v.map(value).join(', ')
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'string' && ISO.test(v)) return when(v)
  return String(v)
}
function details(d) {
  if (!d) return []
  const out = []
  const walk = (o, prefix) => {
    for (const [k, v] of Object.entries(o)) {
      if (v == null || v === '') continue
      // A tool's arguments show plainly; what it returned gets an arrow.
      if (typeof v === 'object' && !Array.isArray(v)) walk(v, prefix + (k === 'args' ? '' : k === 'result' ? '→ ' : `${words(k)} `))
      else out.push([`${prefix}${words(k)}`, value(v)])
    }
  }
  walk(d, '')
  return out
}

// scoped (the owner side): show one business's steps, with a selector; the
// customer side shows everything (there's one customer, across the whole city).
export default function TracePanel({ path = '/dashboard/trace', intervalMs = 1500, scoped = false, businesses = null, current = null }) {
  const [events, setEvents] = useState([])
  const [biz, setBiz] = useState(current || 'all')
  useEffect(() => { if (current) setBiz(current) }, [current])
  const [hiddenBefore, setHiddenBefore] = useState(null)
  const [filter, setFilter] = useState('all')
  const cursor = useRef(null)

  useEffect(() => {
    let stop = false
    async function poll() {
      const q = cursor.current ? `?since=${encodeURIComponent(cursor.current)}` : ''
      const d = await api(`${path}${q}`)
      if (!stop && d?.events) {
        if (d.events.length) setEvents(prev => [...prev, ...d.events].slice(-300))
        cursor.current = d.cursor || cursor.current
      }
      if (!stop) setTimeout(poll, intervalMs)
    }
    poll()
    return () => { stop = true }
  }, [path, intervalMs])

  const kept = (hiddenBefore ? events.filter(e => e.sk > hiddenBefore) : events).filter(e => !scoped || biz === 'all' || e.biz === biz)
  const shown = kept.filter(e => filter === 'all' || (GROUP[e.layer] || 'ai') === filter).slice().reverse()

  return (
    <div className="trace">
      <div className="trace-head">
        <span className="trace-live"><i /> Live · newest first</span>
        <button className="btn-sm btn-secondary" onClick={() => setHiddenBefore(events.length ? events[events.length - 1].sk : null)} disabled={!kept.length}>Clear</button>
      </div>
      {scoped && <BusinessFilter list={businesses} value={biz} onChange={setBiz} />}
      <div className="trace-filters" role="tablist" aria-label="Show">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      <ol className="trace-list">
        {shown.length === 0 && <li className="trace-empty">{kept.length ? 'Nothing of this kind yet.' : 'Steps appear here as Flow works: AI steps and tool calls, seat holds, PayPal payments and refunds, and every message sent.'}</li>}
        {shown.map(e => {
          const group = GROUP[e.layer] || 'ai'
          const rows = details(e.detail)
          return (
            <li key={e.sk} className={`trace-row g-${group}`}>
              <span className="trace-dot" aria-hidden="true" />
              <div className="trace-body">
                <div className="trace-top">
                  <span className="trace-tag">{LABEL[e.layer] || e.layer}</span>
                  {scoped && biz === 'all' && e.bizName && <span className="trace-biz">{e.bizName}</span>}
                  <span className="trace-t">{new Date(e.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}{e.ms != null ? ` · ${e.ms < 1000 ? `${e.ms} ms` : `${(e.ms / 1000).toFixed(1)} s`}` : ''}</span>
                </div>
                <div className="trace-title">{e.title}</div>
                {rows.length > 0 && (
                  <dl className="trace-detail">
                    {rows.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}
                  </dl>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
