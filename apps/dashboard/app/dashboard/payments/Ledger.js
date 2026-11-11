'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../../lib/api'
import { formatMoney } from '../../../lib/money'
import Grid from '../../../lib/Grid'

// The PayPal ledger: one row per money event
// (payment, deposit, the rest of a deposit, refund), built from the bookings,
// the same records the PayPal invoices use. AG Grid: sort, filter, search, a
// totals row that follows the filters, and CSV export. PayPal money only: walk-in
// payments aren't PayPal, so they never show here. The sample bookings a demo
// session starts with are paid with real sandbox payments shared by every
// session, and say so.
const SAMPLE = 'Sample payment (shared by every demo session)'

const CHANNEL = { web: 'Web chat', speaker: 'Voice', mcp: 'AI agent', voice: 'Phone', manual: 'You', mcp_owner: 'You (AI)' }

function iso(d) { return d.toISOString().slice(0, 10) }

// Bookings → money events. A moved booking carries its payment to the new
// record, so the old one isn't counted twice.
export function ledgerRows(bookings) {
  const movedAway = new Set(bookings.map(b => b.rescheduledFrom).filter(Boolean))
  const rows = []
  for (const b of bookings) {
    if (b.blocked || movedAway.has(b.appointmentId) || b.paidWith !== 'paypal') continue
    const base = { booking: b.appointmentId, customer: b.customerName || b.customerPhone || '—', service: b.service, visit: b.startTime, via: CHANNEL[b.createdVia] || b.createdVia || '—', invoice: b.invoiceNumber || '', capture: b.paymentId || '' }
    if (Number(b.amountPaid) > 0) {
      const deposit = b.totalAmount > b.amountPaid + 0.001
      // Dated by when it was paid (booked).
      rows.push({ ...base, id: `${b.appointmentId}-p`, at: b.createdAt || b.startTime, type: deposit ? 'Deposit' : 'Payment', amount: Number(b.amountPaid), note: b.samplePayment ? SAMPLE : b.paidUnder === 'allowance' ? 'Paid by their AI (allowance)' : deposit ? `${formatMoney(b.totalAmount - b.amountPaid)} still due` : '' })
    }
    if (Number(b.refundAmount) > 0) {
      rows.push({ ...base, id: `${b.appointmentId}-r`, at: b.refundedAt || b.startTime, type: 'Refund', amount: -Number(b.refundAmount), note: b.samplePayment ? SAMPLE : b.refundStatus ? `PayPal: ${String(b.refundStatus).toLowerCase()}` : b.status === 'cancelled' ? 'Cancelled' : '' })
    }
  }
  return rows.sort((x, y) => String(y.at).localeCompare(String(x.at)))
}

export default function Ledger() {
  const grid = useRef(null)
  const [rows, setRows] = useState(null)
  const [tz, setTz] = useState(undefined)
  const [search, setSearch] = useState('')
  const [totals, setTotals] = useState(null)

  useEffect(() => {
    const from = iso(new Date(Date.now() - 90 * 86400000))
    const to = iso(new Date(Date.now() + 60 * 86400000))
    api(`/dashboard/bookings?from=${from}T00:00:00&to=${to}T23:59:59`).then(d => { setRows(ledgerRows(d?.bookings || [])); if (d?.timezone) setTz(d.timezone) })
  }, [])

  const shown = rows || []
  const fmtDay = v => v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz }) : '—'

  const columns = useMemo(() => [
    { headerName: 'Date', field: 'at', width: 150, sort: 'desc', valueFormatter: p => p.node.rowPinned ? '' : fmtDay(p.value), filter: 'agDateColumnFilter', filterValueGetter: p => new Date(p.data.at) },
    { headerName: 'Type', field: 'type', width: 110, cellRenderer: p => p.node.rowPinned ? <b>{p.value}</b> : <span className={`badge ${p.value === 'Refund' ? 'badge-red' : p.value === 'Deposit' ? 'badge-yellow' : 'badge-green'}`}>{p.value}</span> },
    { headerName: 'Amount', field: 'amount', width: 120, type: 'rightAligned', filter: 'agNumberColumnFilter',
      valueFormatter: p => p.value == null ? '' : formatMoney(p.value), cellClass: p => (p.value < 0 ? 'ledger-neg' : 'ledger-pos') },
    { headerName: 'Customer', field: 'customer', flex: 1, minWidth: 130 },
    { headerName: 'Service', field: 'service', flex: 1, minWidth: 130 },
    { headerName: 'Visit', field: 'visit', width: 140, valueFormatter: p => p.node.rowPinned ? '' : fmtDay(p.value) },
    { headerName: 'Booked via', field: 'via', width: 115 },
    { headerName: 'PayPal capture', field: 'capture', width: 170, cellClass: 'ledger-mono' },
    { headerName: 'Invoice', field: 'invoice', width: 100 },
    { headerName: 'Note', field: 'note', flex: 1, minWidth: 150 }
  ], [tz])   // eslint-disable-line react-hooks/exhaustive-deps

  // The totals row follows whatever the filters and search leave showing.
  function recount() {
    const api_ = grid.current?.api
    if (!api_) return
    let inn = 0, out = 0
    api_.forEachNodeAfterFilter(n => { const v = Number(n.data?.amount) || 0; if (v >= 0) inn += v; else out += v })
    setTotals({ inn, out })
  }

  const pinned = totals ? [{ id: 'total', type: 'Net', amount: Math.round((totals.inn + totals.out) * 100) / 100, customer: `In ${formatMoney(totals.inn)} · refunded ${formatMoney(-totals.out)}` }] : []

  return (
    <div className="ledger">
      <div className="section-title ledger-head">
        <h2>PayPal ledger</h2>
        <div className="ledger-tools">
          <input className="grid-search" type="search" placeholder="Search customer, service, capture…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search the ledger" />
          <button className="btn-sm btn-secondary" disabled={!shown.length}
            onClick={() => grid.current?.api.exportDataAsCsv({ fileName: 'flow-paypal-ledger.csv', skipPinnedBottom: true })}>Export CSV</button>
        </div>
      </div>
      <p className="muted small ledger-lead">Every payment and refund, newest first: the last 90 days and what&apos;s paid ahead. Filter any column; the totals follow.</p>
      {rows === null ? <div className="skel skel-block" aria-label="Loading" /> : shown.length ? (
        <div className="grid-wrap">
          <Grid ref={grid} rowData={shown} columnDefs={columns} domLayout="autoHeight" quickFilterText={search}
            getRowId={r => r.data.id} pinnedBottomRowData={pinned}
            onFirstDataRendered={recount} onFilterChanged={recount} onRowDataUpdated={recount}
            pagination paginationPageSize={15} paginationPageSizeSelector={[15, 50, 100]} />
        </div>
      ) : <div className="empty">No PayPal payments yet. Book something on the Customer side and pay with PayPal: it shows up here.</div>}
    </div>
  )
}
