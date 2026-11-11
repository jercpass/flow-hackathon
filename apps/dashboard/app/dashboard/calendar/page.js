'use client'
import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { api } from '../../../lib/api'

// Bryntum touches window/document, so it only renders in the browser.
const SchedulerView = dynamic(() => import('./SchedulerView'), { ssr: false, loading: () => <div className="skel skel-block" aria-label="Loading calendar" /> })

function shift(day, days) {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

const fmtRange = (day, view) => {
  if (!day) return ''
  const d = new Date(`${day}T12:00:00`)
  if (view === 'day') return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const e = new Date(d); e.setDate(e.getDate() + 6)
  const sameMonth = d.getMonth() === e.getMonth()
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${e.getFullYear()}`
}
// Event times are the salon's wall clock ("2026-10-20T15:00:00").
const chipWhen = s => new Date(s).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function CalendarPage() {
  // Week first: a new booking a few days out is in view straight away.
  const [view, setView] = useState('week')
  const [upcoming, setUpcoming] = useState([])
  const [day, setDay] = useState(null)
  const [today, setToday] = useState(null)
  const [data, setData] = useState(null)
  const [msg, setMsg] = useState(null)

  // First load tells us "today" in the salon's time zone.
  useEffect(() => {
    api('/dashboard/calendar/events').then(d => { if (d?.from) { setToday(d.from); setDay(d.from) } })
  }, [])
  // ?view=week (the guided tour opens the week so the new booking is in view).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') === 'week') setView('week')
    const on = e => { if (e.detail === 'week' || e.detail === 'day') setView(e.detail) }
    window.addEventListener('bp-view', on)
    return () => window.removeEventListener('bp-view', on)
  }, [])

  const load = useCallback(async () => {
    if (!day) return
    const to = view === 'week' ? shift(day, 6) : day
    const d = await api(`/dashboard/calendar/events?from=${day}&to=${to}`)
    if (d?.resources) setData(d)
  }, [day, view])
  // The next month's bookings, so any booking is one click away.
  const loadUpcoming = useCallback(async () => {
    if (!today) return
    const d = await api(`/dashboard/calendar/events?from=${today}&to=${shift(today, 45)}`)
    if (!d?.events) return
    const nowLocal = new Date().toLocaleString('sv-SE', { timeZone: d.timezone }).replace(' ', 'T')
    setUpcoming(d.events.filter(e => e.status !== 'blocked' && e.endDate >= nowLocal).sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 8))
  }, [today])
  useEffect(() => { load() }, [load])
  useEffect(() => { loadUpcoming() }, [loadUpcoming])
  // New bookings show up without a reload (from any channel, while this is open).
  // While a seat is held for a PayPal payment, look every 4 s, so the bar locks
  // in as soon as PayPal captures it.
  const holding = !!data?.events?.some(e => e.pay === 'held')
  useEffect(() => {
    const refresh = () => { load(); loadUpcoming() }
    const t = setInterval(refresh, holding ? 4_000 : 15_000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(t); window.removeEventListener('focus', refresh) }
  }, [load, loadUpcoming, holding])
  function jumpTo(e) { setView('day'); setDay(e.startDate.slice(0, 10)) }
  const inView = data?.events?.filter(e => e.status !== 'blocked').length || 0

  async function onMove(move) {
    setMsg(null)
    const r = await api('/dashboard/calendar/move', { method: 'POST', body: move })
    if (r?.rescheduled) {
      setMsg({ ok: true, text: `Moved ${r.service} to ${r.when} with ${r.staff}.${r.customer_notified ? ' The customer was told in their inbox.' : ''}` })
      setTimeout(() => { load(); loadUpcoming() }, 300)
      return true
    }
    setMsg({ ok: false, text: r?.error || 'Could not move that booking.' })
    return false
  }

  return (
    <div className="cal">
      <div className="cal-head">
        <h1 style={{ margin: 0 }}>Calendar</h1>
        <div className="cal-tools">
          <button className="btn-sm btn-secondary" onClick={() => setDay(shift(day, view === 'week' ? -7 : -1))} disabled={!day}>‹</button>
          <button className="btn-sm btn-secondary" onClick={() => setDay(today)} disabled={!today}>Today</button>
          <button className="btn-sm btn-secondary" onClick={() => setDay(shift(day, view === 'week' ? 7 : 1))} disabled={!day}>›</button>
          <span className="cal-day">{fmtRange(day, view)}</span>
          <input type="date" className="cal-date" value={day || ''} onChange={e => e.target.value && setDay(e.target.value)} aria-label="Go to date" />
          <div className="cal-switch">
            <button className={view === 'day' ? 'on' : ''} onClick={() => setView('day')}>Day</button>
            <button className={view === 'week' ? 'on' : ''} onClick={() => setView('week')}>Week</button>
          </div>
        </div>
      </div>
      <p className="muted small" style={{ margin: '4px 0 10px' }}>
        {data ? `${data.business} · times in ${data.timezone.replace('_', ' ')} · ` : ''}Drag a booking to another time or stylist to move it.
        <span className="cal-legend"><i style={{ background: '#3b82f6' }} />paid <i className="cal-legend-held" />waiting for PayPal <i style={{ background: '#f59e0b' }} />deposit paid <i style={{ background: '#ef4444' }} />refunded <i style={{ background: '#f97316' }} />disputed <i style={{ background: '#9333ea' }} />reversed by PayPal <i style={{ background: '#9ca3af' }} />past / blocked</span>
      </p>
      {upcoming.length > 0 && (
        <div className="cal-upcoming" aria-label="Upcoming bookings">
          <span className="cal-upcoming-label">Upcoming</span>
          {upcoming.map(e => (
            <button type="button" key={e.id} className="cal-chip" onClick={() => jumpTo(e)} title="Show this day">
              <b>{chipWhen(e.startDate)}</b> {e.name}{e.customer ? ` · ${e.customer}` : ''}
            </button>
          ))}
        </div>
      )}
      {data && inView === 0 && upcoming.length > 0 && (
        <div className="cal-msg">No bookings {view === 'week' ? 'this week' : 'on this day'}. Next: <button type="button" className="link-btn" onClick={() => jumpTo(upcoming[0])}>{chipWhen(upcoming[0].startDate)}</button></div>
      )}
      {msg && <div className={`cal-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      <div className="cal-frame" data-tour="calendar">
        {data && day ? <SchedulerView data={data} view={view} day={day} onMove={onMove} onOpenDispute={() => { window.location.href = '/dashboard/disputes' }} /> : <div className="skel skel-block" aria-label="Loading calendar" />}
      </div>
    </div>
  )
}
