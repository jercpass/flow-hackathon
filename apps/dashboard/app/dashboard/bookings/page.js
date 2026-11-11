'use client'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { formatMoney } from '../../../lib/money'
import Grid from '../../../lib/Grid'

// Bookings as a grid (AG Grid: sort, filter, search; the week view lives on the
// Calendar page), plus adding a walk-in and blocking time.

function iso(d) { return d.toISOString().slice(0, 10) }

// PayPal invoice status, in plain words.
const CHANNEL = { web: 'via web chat', speaker: 'via voice', mcp: 'via an AI agent', voice: 'by phone', manual: 'added by you', mcp_owner: 'added by your AI', reschedule: 'moved by the customer', owner_reschedule: 'moved by you' }
const INVOICE_LABEL = { DRAFT: 'draft', UNPAID: 'unpaid', PAID: 'paid', PARTIALLY_PAID: 'partly paid', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partly refunded' }
// Attendance: a booking is "Booked" until it starts, then "Not marked" until
// the owner says whether they came (completed) or not (no_show).
function statusOf(b) {
  if (b.blocked) return ['Blocked', 'badge-gray']
  if (b.status === 'cancelled') return ['Cancelled', 'badge-gray']
  if (b.status === 'completed') return ['Came', 'badge-green']
  if (b.status === 'no_show') return ['No-show', 'badge-red']
  return new Date(b.startTime).getTime() > Date.now() ? ['Booked', 'badge-blue'] : ['Not marked', 'badge-yellow']
}

export default function Bookings() {
  const [bookings, setBookings] = useState(null)
  const [tz, setTz] = useState(undefined)   // the salon's time zone
  const [from, setFrom] = useState(iso(new Date()))
  const [to, setTo] = useState(iso(new Date(Date.now() + 7 * 86400000)))
  const [services, setServices] = useState([])
  const [staff, setStaff] = useState([])
  const [panel, setPanel] = useState('')   // '' | 'add' | 'block'
  const [add, setAdd] = useState({ serviceId: '', date: iso(new Date()), time: '10:00', staffId: '', customerName: '', customerPhone: '', markPaid: false })
  const [blk, setBlk] = useState({ date: iso(new Date()), start: '13:00', end: '14:00', unitId: 'all', label: 'Blocked' })
  const [msg, setMsg] = useState('')
  // Cancelling: the quote first (refund by policy / full / none), then confirm.
  const [cancel, setCancel] = useState(null)   // { b, quote, refund, reason, busy }
  // Refunding without cancelling, or saying no to a customer's request.
  const [refund, setRefund] = useState(null)   // { id, label, max, amount, reason, busy, mode: 'refund' | 'decline', asked }
  const [requests, setRequests] = useState([])   // refunds customers asked for, any date
  const [search, setSearch] = useState('')
  // The grid's cells call the page's actions through this, so the columns can stay put.
  const act = useRef({})

  useEffect(() => {
    api('/dashboard/services').then(d => setServices(d?.services || []))
    api('/dashboard/staff').then(d => setStaff(d?.staff || []))
  }, [])

  const reload = useCallback(() => {
    api(`/dashboard/bookings?from=${from}T00:00:00&to=${to}T23:59:59`).then(d => { setBookings(d?.bookings || []); if (d?.timezone) setTz(d.timezone) })
    api('/dashboard/bookings/refund-requests').then(d => setRequests(d?.requests || []))
  }, [from, to])

  // id: the booking id (full or the short one the requests list gives).
  function openRefund({ id, label, max, asked, mode = 'refund' }) {
    setMsg('')
    setRefund({ id, label, max, asked, amount: String(asked ?? max), reason: '', busy: false, mode })
    window.scrollTo?.({ top: 0, behavior: 'smooth' })
  }
  async function confirmRefund() {
    const { id, label, mode, amount, reason } = refund
    setRefund(r => ({ ...r, busy: true }))
    const r = mode === 'decline'
      ? await api('/dashboard/bookings/refund-request/decline', { method: 'POST', body: { appointmentId: id, reason: reason.trim() || undefined } })
      : await api('/dashboard/bookings/refund', { method: 'POST', body: { appointmentId: id, amount: Number(amount), reason: reason.trim() || undefined, confirm: true } })
    setRefund(null)
    if (!r || r.error) { setMsg(r?.error || 'That didn\'t work.'); return }
    if (mode === 'decline') setMsg(`Refund request declined.${r.customer_notified ? ' The customer was told in their inbox.' : ''}`)
    else setMsg(r.refunded ? `${r.amount} refunded to their PayPal for ${label}. They were told in their inbox.` : (r.message || 'Nothing was refunded.'))
    reload()
  }
  useEffect(() => { reload() }, [reload])

  async function startCancel(b) {
    setMsg('')
    const quote = await api('/dashboard/bookings/cancel', { method: 'POST', body: { appointmentId: b.appointmentId } })
    if (!quote || quote.error) { setMsg(quote?.error || 'Could not get the refund for this booking.'); return }
    setCancel({ b, quote, refund: 'policy', reason: '', busy: false })
    window.scrollTo?.({ top: 0, behavior: 'smooth' })
  }
  async function confirmCancel() {
    setCancel(c => ({ ...c, busy: true }))
    const { b, refund, reason, quote } = cancel
    const r = await api('/dashboard/bookings/cancel', { method: 'POST', body: { appointmentId: b.appointmentId, refund, reason: reason.trim() || undefined, confirm: true } })
    setCancel(null)
    if (!r || r.error) { setMsg(r?.error || 'Could not cancel the booking.'); return }
    // Say what really happened: the refund, and whether a message reached their inbox.
    const told = r.customer_notified ? ` ${b.customerName || 'The customer'} was told in their inbox.` : ''
    const money = r.refunded ? ` ${r.refund} is on its way back to their PayPal.` : ''
    setMsg(`${b.service} cancelled.${money}${r.message ? ` ${r.message}` : ''}${told}`)
    reload()
  }

  async function updateStatus(b, status) {
    const d = await api('/dashboard/bookings', { method: 'PATCH', body: { startTime: b.startTime, appointmentId: b.appointmentId, status } })
    if (d?.error) { setMsg(d.error); return }
    const who = b.customerName || 'The customer'
    setMsg({ completed: `${who}: marked as came.`, no_show: `${who}: marked as a no-show.`, confirmed: `${who}: attendance cleared.`, cancelled: `${b.service} cancelled.` }[status] || 'Saved.')
    reload()
  }

  async function collectBalance(b) {
    const d = await api('/dashboard/bookings/request-balance', { method: 'POST', body: { startTime: b.startTime, appointmentId: b.appointmentId } })
    if (d?.sent) setMsg(`Balance payment link of ${formatMoney(d.balance)} sent to the customer.`)
    else setMsg(d?.error || 'Could not send the balance request.')
  }

  async function addBooking() {
    if (!add.serviceId) { setMsg('Pick a service first.'); return }
    const startTime = `${add.date}T${add.time}:00`
    const d = await api('/dashboard/calendar/booking', { method: 'POST', body: {
      serviceId: add.serviceId, startTime, staffId: add.staffId || undefined,
      customerName: add.customerName, customerPhone: add.customerPhone, markPaid: add.markPaid
    } })
    if (d?.booked) { setMsg('Booking added.'); setPanel(''); reload() }
    else setMsg(d?.error || 'Could not add the booking.')
  }

  async function doBlock() {
    const startTime = `${blk.date}T${blk.start}:00`
    const endTime = `${blk.date}T${blk.end}:00`
    if (endTime <= startTime) { setMsg('The end has to be after the start.'); return }
    const d = await api('/dashboard/calendar/block', { method: 'POST', body: {
      startTime, endTime, unitId: blk.unitId, label: blk.label
    } })
    if (d?.blocked) { setMsg(`Blocked ${d.count} slot${d.count === 1 ? '' : 's'}.`); setPanel(''); reload() }
    else setMsg(d?.error || 'Could not block the time.')
  }

  const toggle = p => { setPanel(panel === p ? '' : p); setMsg('') }
  act.current = { openRefund, startCancel, updateStatus, collectBalance }

  const columns = useMemo(() => [
    { headerName: 'When', field: 'startTime', sort: 'asc', width: 150, filter: 'agDateColumnFilter',
      filterValueGetter: p => new Date(p.data.startTime),
      cellRenderer: p => <TwoLines a={new Date(p.value).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz })} b={new Date(p.value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })} /> },
    { headerName: 'Service', field: 'service', flex: 1, minWidth: 150, cellRenderer: p => <TwoLines a={p.value} b={p.data.customerNotes ? `📝 ${p.data.customerNotes}` : p.data.staff ? `with ${p.data.staff}` : ''} /> },
    { headerName: 'Customer', field: 'customerName', flex: 1, minWidth: 140,
      valueGetter: p => p.data.customerName || p.data.customerPhone || '—',
      cellRenderer: p => <TwoLines a={p.value} b={p.data.refundRequest?.status === 'open' ? `Asked for ${formatMoney(p.data.refundRequest.amount)} back` : CHANNEL[p.data.createdVia] || ''} /> },
    { headerName: 'Status', colId: 'status', width: 120, valueGetter: p => statusOf(p.data)[0],
      cellRenderer: p => <span className={`badge ${statusOf(p.data)[1]}`}>{p.value}</span> },
    { headerName: 'Paid', field: 'amountPaid', width: 150, filter: 'agNumberColumnFilter', valueGetter: p => Number(p.data.amountPaid || 0),
      cellRenderer: p => <TwoLines a={p.value ? formatMoney(p.value) : '—'} b={paidNote(p.data)} /> },
    { headerName: '', colId: 'actions', width: 290, sortable: false, filter: false, resizable: false, cellRenderer: RowActions, cellClass: 'grid-actions' }
  ], [tz])

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <p className="page-lead">Everything booked from any channel, plus walk-ins you add yourself. After a visit, mark whether the customer came: <b>Came</b> or <b>No-show</b> (click it again to undo).</p>
        </div>
        <div className="btn-row">
          <button className={panel === 'add' ? 'btn-sm' : 'btn-sm btn-secondary'} onClick={() => toggle('add')}>+ Add booking</button>
          <button className={panel === 'block' ? 'btn-sm' : 'btn-sm btn-secondary'} onClick={() => toggle('block')}>Block time</button>
          <Link href="/dashboard/calendar" className="btn-link btn-sm">Open calendar →</Link>
        </div>
      </div>

      {msg && <p className="notice notice-info" style={{ marginBottom: 16 }}>{msg}</p>}

      {requests.length > 0 && !refund && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2>Refund requests</h2>
          <p className="card-lead">Customers asking for money back without cancelling. Nothing is refunded until you decide.</p>
          {requests.map(q => (
            <div key={q.booking_id} className="list-row" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderTop: '1px solid var(--border, #eee)' }}>
              <div>
                <b>{q.customer || 'A customer'}</b> asks for <b>{q.asked}</b> back · {q.service}, {q.when}
                <div className="muted small">&ldquo;{q.reason}&rdquo; · paid {q.paid}{q.refunded ? `, ${q.refunded} already refunded` : ''}</div>
              </div>
              <div className="btn-row">
                <button className="btn-sm" onClick={() => openRefund({ id: q.booking_id, label: `${q.service}, ${q.when}`, max: q.refundable_amount, asked: q.asked_amount })}>Refund…</button>
                <button className="btn-sm btn-secondary" onClick={() => openRefund({ id: q.booking_id, label: `${q.service}, ${q.when}`, max: q.refundable_amount, asked: q.asked_amount, mode: 'decline' })}>Decline…</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {refund && (
        <div className="card editor cancel-card">
          {refund.mode === 'decline' ? (
            <>
              <h2>Decline the refund request?</h2>
              <p className="card-lead">{refund.label}. No money moves; the customer is told in their inbox.</p>
            </>
          ) : (
            <>
              <h2>Refund {refund.label}</h2>
              <p className="card-lead">Goes back to their PayPal now. The booking stays as it is{refund.asked != null ? `; they asked for ${formatMoney(refund.asked)}` : ''}.</p>
              <div className="form-group">
                <label>Amount (up to {formatMoney(refund.max)})</label>
                <input type="number" min="0.01" max={refund.max} step="0.01" value={refund.amount} onChange={e => setRefund(r => ({ ...r, amount: e.target.value }))} />
              </div>
            </>
          )}
          <div className="form-group">
            <label>Note for the customer (optional)</label>
            <input value={refund.reason} onChange={e => setRefund(r => ({ ...r, reason: e.target.value }))} placeholder={refund.mode === 'decline' ? 'e.g. The colour was done as agreed' : 'e.g. Sorry about the wait'} maxLength={200} />
          </div>
          <div className="btn-row">
            {refund.mode === 'decline'
              ? <button className="btn-danger" onClick={confirmRefund} disabled={refund.busy}>{refund.busy ? 'Saving…' : 'Decline request'}</button>
              : <button onClick={confirmRefund} disabled={refund.busy || !(Number(refund.amount) > 0) || Number(refund.amount) > refund.max}>{refund.busy ? 'Refunding…' : `Refund ${formatMoney(Number(refund.amount) || 0)}`}</button>}
            <button className="btn-secondary" onClick={() => setRefund(null)} disabled={refund.busy}>Back</button>
          </div>
        </div>
      )}

      {cancel && (() => {
        const { b, quote } = cancel
        const o = quote.options || {}
        const paid = (o.full?.amount || 0) > 0
        const pick = cancel.refund
        return (
          <div className="card editor cancel-card">
            <h2>Cancel {b.service}{b.customerName ? ` for ${b.customerName}` : ''}?</h2>
            <p className="card-lead">{quote.booking?.when}{quote.booking?.staff ? ` with ${quote.booking.staff}` : ''}. The time becomes free again{quote.tells_customer ? ' and the customer is told in their inbox' : ''}.</p>
            {quote.covered_by && <p className="notice notice-info">Covered by {quote.covered_by}: nothing was paid, and the haircut goes back to their membership.</p>}
            {paid ? (
              <div className="form-group">
                <label>Refund (they paid {quote.paid})</label>
                <div className="refund-options">
                  {[['policy', `By your policy: ${o.policy.label}`, `${o.policy.pct}% back, worked out from your refund rules`], ['full', `Full refund: ${o.full.label}`, 'Everything they paid'], ['none', 'No refund', 'Keep the payment']].map(([k, title, sub]) => (
                    <label key={k} className={`refund-option ${pick === k ? 'on' : ''}`}>
                      <input type="radio" name="refund" checked={pick === k} onChange={() => setCancel(c => ({ ...c, refund: k }))} />
                      <span><b>{title}</b><span className="muted small">{sub}</span></span>
                    </label>
                  ))}
                </div>
                {pick !== 'none' && <div className="field-hint">Refunds go back to their PayPal automatically.</div>}
              </div>
            ) : !quote.covered_by && <p className="muted small" style={{ marginBottom: 12 }}>Nothing was paid online, so there&apos;s no refund.</p>}
            <div className="form-group">
              <label>Reason for the customer (optional)</label>
              <input value={cancel.reason} onChange={e => setCancel(c => ({ ...c, reason: e.target.value }))} placeholder="e.g. Ana is off sick" maxLength={200} />
            </div>
            <div className="btn-row">
              <button className="btn-danger" onClick={confirmCancel} disabled={cancel.busy}>{cancel.busy ? 'Cancelling…' : paid && pick !== 'none' ? `Cancel and refund ${o[pick].label}` : 'Cancel booking'}</button>
              <button className="btn-secondary" onClick={() => setCancel(null)} disabled={cancel.busy}>Keep it</button>
            </div>
          </div>
        )
      })()}

      {panel === 'add' && (
        <div className="card editor" style={{ marginTop: 0, marginBottom: 20 }}>
          <h2>Add a walk-in or phone booking</h2>
          <p className="card-lead">It goes on your calendar, so the assistant won&apos;t double-book that slot.</p>
          <div className="form-row">
            <div className="form-group">
              <label>Service</label>
              <select value={add.serviceId} onChange={e => setAdd({ ...add, serviceId: e.target.value })}>
                <option value="">Choose…</option>
                {services.filter(s => s.active !== false).map(s => <option key={s.serviceId} value={s.serviceId}>{s.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>With</label>
              <select value={add.staffId} onChange={e => setAdd({ ...add, staffId: e.target.value })}>
                <option value="">Anyone available</option>
                {staff.map(s => <option key={s.staffId} value={s.staffId}>{s.name}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Date</label><input type="date" value={add.date} onChange={e => setAdd({ ...add, date: e.target.value })} /></div>
            <div className="form-group"><label>Time</label><input type="time" value={add.time} onChange={e => setAdd({ ...add, time: e.target.value })} /></div>
            <div className="form-group"><label>Customer name</label><input value={add.customerName} onChange={e => setAdd({ ...add, customerName: e.target.value })} placeholder="Walk-in" /></div>
            <div className="form-group"><label>Phone (optional)</label><input value={add.customerPhone} onChange={e => setAdd({ ...add, customerPhone: e.target.value })} /></div>
          </div>
          <label className="check"><input type="checkbox" checked={add.markPaid} onChange={e => setAdd({ ...add, markPaid: e.target.checked })} /> Already paid</label>
          <div className="card-foot">
            <button onClick={addBooking}>Add booking</button>
            <button className="btn-secondary" onClick={() => setPanel('')}>Cancel</button>
          </div>
        </div>
      )}

      {panel === 'block' && (
        <div className="card editor" style={{ marginTop: 0, marginBottom: 20 }}>
          <h2>Block time</h2>
          <p className="card-lead">Lunch, a day off or personal time. The assistant won&apos;t offer these slots.</p>
          <div className="form-row">
            <div className="form-group"><label>Date</label><input type="date" value={blk.date} onChange={e => setBlk({ ...blk, date: e.target.value })} /></div>
            <div className="form-group">
              <label>Who</label>
              <select value={blk.unitId} onChange={e => setBlk({ ...blk, unitId: e.target.value })}>
                <option value="all">Whole business</option>
                {staff.map(s => <option key={s.staffId} value={s.staffId}>{s.name}</option>)}
              </select>
            </div>
            <div className="form-group"><label>From</label><input type="time" value={blk.start} onChange={e => setBlk({ ...blk, start: e.target.value })} /></div>
            <div className="form-group"><label>To</label><input type="time" value={blk.end} onChange={e => setBlk({ ...blk, end: e.target.value })} /></div>
          </div>
          <div className="form-group"><label>Shown on the calendar as</label><input value={blk.label} onChange={e => setBlk({ ...blk, label: e.target.value })} /></div>
          <div className="card-foot">
            <button onClick={doBlock}>Block it</button>
            <button className="btn-secondary" onClick={() => setPanel('')}>Cancel</button>
          </div>
        </div>
      )}

      <div className="filter-bar">
        <label>From <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <input className="grid-search" type="search" placeholder="Search customer, service, staff…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search bookings" />
        {bookings && <span className="muted small" style={{ marginLeft: 'auto' }}>{bookings.length} booking{bookings.length === 1 ? '' : 's'}</span>}
      </div>

      {bookings === null ? <div className="skel skel-block" aria-label="Loading" /> : bookings.length ? (
        <div className="grid-wrap" data-tour="bookings-grid">
          <Grid rowData={bookings} columnDefs={columns} domLayout="autoHeight" quickFilterText={search}
            getRowId={r => r.data.appointmentId} rowHeight={58} context={act}
            pagination paginationPageSize={20} paginationPageSizeSelector={[20, 50, 100]} />
        </div>
      ) : <div className="empty">No bookings in these dates. Book something on the Customer side and it shows up here.</div>}
    </div>
  )
}

function TwoLines({ a, b }) {
  return <div className="grid-two"><div className="grid-a">{a}</div>{b ? <div className="grid-b">{b}</div> : null}</div>
}

// What happened to the money, under the amount.
function paidNote(b) {
  if (b.refundAmount > 0) return b.refundAmount >= b.amountPaid ? 'Refunded in full' : `${formatMoney(b.refundAmount)} refunded`
  if (b.invoiceNumber) return `Invoice ${b.invoiceNumber} · ${INVOICE_LABEL[b.invoiceStatus] || 'issued'}`
  if (b.samplePayment) return 'Sample PayPal payment (shared by every demo session)'
  if (b.paidWith === 'demo') return 'Made-up demo booking'
  if (b.paidWith === 'in_person') return 'Walk-in, paid at the salon'
  if (b.balanceDue > 0 && b.amountPaid > 0) return `${formatMoney(b.balanceDue)} still due`
  return ''
}

// The same actions the list had: refund without cancelling, collect the rest,
// came / no-show, cancel. They call the page through the grid's context.
function RowActions({ data: b, context }) {
  const a = context.current
  const left = Math.round(((b.amountPaid || 0) - (b.refundAmount || 0)) * 100) / 100
  const label = `${b.service}${b.customerName ? ` for ${b.customerName}` : ''}`
  return (
    <div className="btn-row grid-btns">
      {b.paidWithPayPal && left > 0.001 && <button className="btn-sm btn-secondary" onClick={() => a.openRefund({ id: b.appointmentId, label, max: left, asked: b.refundRequest?.status === 'open' ? b.refundRequest.amount : undefined })}>Refund…</button>}
      {b.status !== 'cancelled' && !b.blocked && (
        <>
          {b.balanceDue > 0 && b.amountPaid > 0 && !b.seeded && <button className="btn-sm" onClick={() => a.collectBalance(b)}>Collect {formatMoney(b.balanceDue)}</button>}
          <div className="seg seg-sm attend" role="group" aria-label={`Did ${b.customerName || 'the customer'} come?`}>
            <button type="button" className={b.status === 'completed' ? 'on came' : ''} aria-pressed={b.status === 'completed'} onClick={() => a.updateStatus(b, b.status === 'completed' ? 'confirmed' : 'completed')}>Came</button>
            <button type="button" className={b.status === 'no_show' ? 'on noshow' : ''} aria-pressed={b.status === 'no_show'} onClick={() => a.updateStatus(b, b.status === 'no_show' ? 'confirmed' : 'no_show')}>No-show</button>
          </div>
          {b.status === 'confirmed' && <button className="btn-sm btn-danger" onClick={() => a.startCancel(b)}>Cancel</button>}
        </>
      )}
    </div>
  )
}
