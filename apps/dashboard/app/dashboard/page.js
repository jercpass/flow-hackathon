'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '../../lib/api'
import { formatMoney } from '../../lib/money'
import Grid from '../../lib/Grid'
import { TwoLines } from '../../lib/GridCells'

const CHANNEL = { web: 'Web chat', speaker: 'Voice assistant', mcp: 'AI agent', voice: 'Phone', manual: 'Added by you', mcp_owner: 'Added by you (MCP)' }

// "Coming up" as an AG Grid (sort, filter): the next bookings at a glance.
const UPCOMING_COLUMNS = [
  { headerName: 'When', field: 'startTime', sort: 'asc', width: 150, valueFormatter: p => p.data.when },
  { headerName: 'Service', field: 'service', flex: 1, minWidth: 120, cellRenderer: p => <TwoLines a={p.value} b={p.data.notes ? `📝 ${p.data.notes}` : ''} /> },
  { headerName: 'Customer', field: 'customerName', flex: 1, minWidth: 110, valueFormatter: p => p.value || '—' },
  { headerName: 'Staff', field: 'staff', width: 90, valueFormatter: p => p.value || '—' },
  { headerName: 'Paid', field: 'paid', width: 80, valueFormatter: p => (p.value ? formatMoney(p.value) : '—') },
  { headerName: 'Booked via', field: 'channel', width: 130, valueGetter: p => CHANNEL[p.data.channel] || p.data.channel || '—',
    cellRenderer: p => <TwoLines a={p.value} b={p.data.moved ? (p.data.moved === 'owner' ? 'Moved by you' : 'Moved by the customer') : ''} /> }
]

// Overview: the owner's day at a glance — in the salon's own time zone.
export default function Overview() {
  const [stats, setStats] = useState(null)
  const [settings, setSettings] = useState(null)

  useEffect(() => {
    api('/dashboard/stats').then(setStats)
    api('/dashboard/settings').then(setSettings)
  }, [])

  if (!stats || !settings) {
    return (
      <div aria-label="Loading" aria-busy="true">
        <span className="skel skel-title" />
        <div className="stat-wrap"><div className="stat-grid stat-grid-4">{[0, 1, 2, 3].map(i => <div key={i} className="stat-card"><span className="skel skel-text" /><span className="skel skel-num" /></div>)}</div></div>
      </div>
    )
  }

  // A salon with nothing set up yet (guided demo) is one AI step away.
  const unset = !settings.servicesCount
  const steps = unset && settings.addedByJudge
    ? [{ key: 'ai', label: 'Set up services, staff, hours and refund rules: describe it to Flow\'s AI, or let your own AI do it', done: false, href: '/dashboard/added', cta: 'Set it up' }]
    : unset
    ? [{ key: 'ai', label: 'Set up services, staff and refund rules with AI, from your description and documents', done: false, href: '/dashboard/build', cta: 'Set up with AI' }]
    : [
      { key: 'payments', label: 'Connect PayPal (or use the demo sandbox account)', done: settings.paypalConnected, href: '/dashboard/payments' },
      { key: 'services', label: 'Add at least one service', done: settings.servicesCount > 0, href: '/dashboard/services' },
      { key: 'policy', label: 'Set your refund policy', done: !!settings.policies?.refundTiers?.length, href: '/dashboard/setup' }
    ]
  const todo = steps.filter(s => !s.done)

  return (
    <div>
      <div className="ov-head">
        <div>
          <h1 style={{ marginBottom: 2 }}>{settings.name}</h1>
          <p className="muted small">Times in {String(stats.timezone || '').replace('_', ' ')} · paid through PayPal · refunds follow your policy automatically</p>
        </div>
        <Link href="/dashboard/calendar" className="btn-link">Open calendar →</Link>
      </div>

      {todo.length > 0 && (
        <div className="card setup-card">
          <h2>Finish setting up</h2>
          {todo.map(s => (
            <div key={s.key} className="setup-step">
              <span className="setup-dot" aria-hidden="true" />
              <span>{s.label}</span>
              <Link href={s.href} className={`btn-link btn-sm ${s.cta ? '' : 'setup-go'}`}>{s.cta || 'Set up'}</Link>
            </div>
          ))}
        </div>
      )}

      <div className="stat-wrap"><div className="stat-grid stat-grid-4" data-tour="stats">
        <div className="stat-card"><div className="label">Today</div><div className="value">{stats.todayBookings}</div><div className="muted small">bookings</div></div>
        <div className="stat-card"><div className="label">Last 7 days</div><div className="value">{stats.weekBookings}</div><div className="muted small">bookings</div></div>
        <div className="stat-card"><div className="label">Collected (net)</div><div className="value">{formatMoney(stats.weekRevenue || 0)}</div><div className="muted small">after refunds</div></div>
        <div className="stat-card"><div className="label">Refunded</div><div className="value">{formatMoney(stats.weekRefunds || 0)}</div><div className="muted small">{stats.weekCancelled} cancelled</div></div>
      </div></div>

      {stats.impact && (
        <div className="card impact" data-tour="impact">
          <div className="impact-head">
            <h2>What Flow did for you</h2>
            <span className="muted small">last {stats.impact.days} days and booked ahead</span>
          </div>
          <div className="impact-grid">
            <div><b>{stats.impact.bookedWithoutYou}</b><span>bookings made without you, by chat, voice or the customer&apos;s own AI</span></div>
            <div><b>{formatMoney(stats.impact.paidUpfront)}</b><span>already paid through PayPal, before the visit</span></div>
            <div><b>{formatMoney(stats.impact.keptByPolicy)}</b><span>kept by your policy on late cancellations and no-shows</span></div>
          </div>
          <p className="muted small impact-note">Salons without deposits lose about 15–30% of bookings to no-shows; asking for payment up front cuts that by roughly 30–70% (industry reports, see the README). These numbers are your own.</p>
        </div>
      )}

      <div className="section-title"><h2>Coming up</h2></div>
      {stats.upcoming?.length ? (
        <div className="grid-wrap">
          <Grid rowData={stats.upcoming} columnDefs={UPCOMING_COLUMNS} domLayout="autoHeight" rowHeight={54} getRowId={r => `${r.data.startTime}-${r.data.service}-${r.data.customerName}`} />
        </div>
      ) : <div className="empty">Nothing booked yet. Switch to <b>Customer</b> and book something: it lands here and on the calendar.</div>}
    </div>
  )
}
