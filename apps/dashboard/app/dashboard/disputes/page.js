'use client'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../../lib/api'

// PayPal disputes, answered from the booking's own record (lambda core/disputes).
// The AI drafts; the owner edits and sends.
// Nothing goes to PayPal without the owner's click. A practice case (PayPal's
// sandbox can't open one by API) is labelled and never sent.

const STATUS = {
  OPEN: 'Open', WAITING_FOR_SELLER_RESPONSE: 'Waiting for your response', WAITING_FOR_BUYER_RESPONSE: 'Waiting for the customer',
  UNDER_REVIEW: 'PayPal is reviewing', RESOLVED: 'Resolved', OTHER: 'Other'
}
const OUTCOME = { RESOLVED_SELLER_FAVOUR: 'Decided for you', RESOLVED_BUYER_FAVOUR: 'Decided for the customer', RESOLVED_WITH_PAYOUT: 'Resolved with a payout', CANCELED_BY_BUYER: 'Customer withdrew it', ACCEPTED: 'You accepted the claim', DENIED: 'Denied', NONE: 'Closed' }
const day = iso => iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : ''
const shift = d => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10) }

function Case({ d, sandbox, onChanged }) {
  const [note, setNote] = useState(d.draft?.note || '')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null)
  useEffect(() => { if (d.draft?.note) setNote(d.draft.note) }, [d.draft?.at])   // eslint-disable-line react-hooks/exhaustive-deps

  async function run(what, body = {}) {
    setBusy(what); setMsg(null)
    const r = await api(`/dashboard/disputes/${what}`, { method: 'POST', body: { disputeId: d.disputeId, ...body } })
    setBusy('')
    if (r?.error) { setMsg({ ok: false, text: r.error }); return null }
    if (r?.message) setMsg({ ok: true, text: r.message })
    onChanged()
    return r
  }
  async function send() {
    if (!window.confirm(d.practice ? 'Record this response? (Practice case: nothing goes to PayPal.)' : 'Send this response and the booking record (PDF) to PayPal?')) return
    await run('send', { note, confirm: true })
  }
  async function accept() {
    if (!window.confirm(`Accept the claim? The customer gets ${d.money} back${d.practice ? ' (practice case: only recorded in Flow)' : ' through PayPal'}.`)) return
    await run('accept', { confirm: true })
  }

  const due = d.dueAt && d.open ? Math.ceil((Date.parse(d.dueAt) - Date.now()) / 86_400_000) : null
  return (
    <div className={`card dispute ${d.open ? 'dispute-open' : ''}`}>
      <div className="dispute-head">
        <div>
          <h2>{d.money} · the customer {d.reasonText}</h2>
          <p className="muted small">
            Case {d.disputeId}{d.startTime ? ` · booking on ${day(d.startTime)}` : ''}{d.createdAt ? ` · opened ${day(d.createdAt)}` : ''}
          </p>
        </div>
        <div className="dispute-badges">
          {d.practice && <span className="badge badge-gray">Practice, only in Flow</span>}
          <span className={`badge ${d.open ? 'badge-orange' : d.outcome === 'RESOLVED_SELLER_FAVOUR' ? 'badge-green' : 'badge-gray'}`}>{d.open ? STATUS[d.status] || d.status : OUTCOME[d.outcome] || STATUS[d.status] || d.status}</span>
          {due != null && <span className={`badge ${due <= 3 ? 'badge-red' : 'badge-gray'}`}>Respond by {day(d.dueAt)}</span>}
        </div>
      </div>
      {d.buyerMessage && <p className="dispute-buyer">“{d.buyerMessage}” <span className="muted small">the customer, to PayPal</span></p>}

      {d.open && (
        d.draft ? (
          <div className="dispute-draft">
            <label className="small"><b>Your response</b> <span className="muted">drafted by {d.draft.by === 'template' ? 'Flow' : d.draft.by} from the booking record; edit anything</span></label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={7} />
            <details className="dispute-facts">
              <summary className="small">The facts it used ({d.draft.facts.length}) · sent as a PDF with the response</summary>
              <ul>{d.draft.facts.map((f, i) => <li key={i} className="small">{f}</li>)}</ul>
            </details>
            <div className="btn-row">
              <button onClick={send} disabled={!!busy || note.trim().length < 20}>{busy === 'send' ? 'Sending…' : d.practice ? 'Record response' : 'Send to PayPal'}</button>
              <button className="btn-secondary" onClick={() => run('draft')} disabled={!!busy}>{busy === 'draft' ? 'Drafting…' : 'Draft again'}</button>
              <button className="btn-secondary saved-pp-remove" onClick={accept} disabled={!!busy}>Accept and refund</button>
            </div>
            <p className="muted small">PayPal&apos;s evidence type: {d.draft.evidenceType.replace(/_/g, ' ').toLowerCase()}.</p>
          </div>
        ) : (
          <div className="btn-row">
            <button onClick={() => run('draft')} disabled={!!busy}>{busy === 'draft' ? 'Reading the booking…' : 'Draft a response with AI'}</button>
            <button className="btn-secondary saved-pp-remove" onClick={accept} disabled={!!busy}>Accept and refund</button>
          </div>
        )
      )}
      {d.sent && <p className="small dispute-sent">✓ Response {d.sent.toPaypal ? 'sent to PayPal' : 'recorded'} {day(new Date(d.sent.at).toISOString())}{d.sent.toPaypal ? ' with the booking record attached' : ''}.</p>}

      {sandbox && d.open && (
        <div className="dispute-sandbox">
          <span className="muted small">{d.practice ? 'Practice' : 'PayPal sandbox'}: move the case on</span>
          <button className="btn-sm btn-secondary" onClick={() => run('sandbox', { action: 'seller_wins' })} disabled={!!busy}>Decide for the business</button>
          <button className="btn-sm btn-secondary" onClick={() => run('sandbox', { action: 'buyer_wins' })} disabled={!!busy}>Decide for the customer</button>
        </div>
      )}
      {msg && <p className={`small ${msg.ok ? 'saved-pp-done' : 'saved-pp-error'}`}>{msg.text}</p>}
    </div>
  )
}

export default function DisputesPage() {
  const [data, setData] = useState(null)
  const [paid, setPaid] = useState(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const load = useCallback(() => api('/dashboard/disputes').then(d => { if (d && !d.error) setData(d); else if (d?.error) setErr(d.error) }), [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api(`/dashboard/calendar/events?from=${shift(-30)}&to=${shift(30)}`).then(d => setPaid((d?.events || []).filter(e => e.paid && e.status !== 'blocked')))
  }, [])

  async function practice() {
    if (!pick) return
    setBusy(true); setErr('')
    const r = await api('/dashboard/disputes/practice', { method: 'POST', body: { bookingId: pick } })
    setBusy(false)
    if (r?.error) setErr(r.error); else { setPick(''); load() }
  }

  const open = (data?.disputes || []).filter(d => d.open)
  return (
    <div>
      <h1>Disputes</h1>
      <p className="muted" style={{ maxWidth: 680 }}>When a customer disputes a payment with PayPal, the booking is your evidence: when and how it was booked, what they paid, the policy they saw, and whether the visit happened. Flow&apos;s AI drafts your response from that record only, and nothing goes to PayPal until you send it.</p>
      {err && <p className="notice notice-warn">{err}</p>}
      {!data ? <div className="skel skel-block" aria-label="Loading disputes" /> : (
        <>
          {data.disputes.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>No disputes. Customers&apos; cases from PayPal show up here (and in your inbox) as soon as PayPal opens them.</p></div>}
          {open.length > 0 && <p className="small"><b>{open.length}</b> open {open.length === 1 ? 'case' : 'cases'}.</p>}
          {data.disputes.map(d => <Case key={d.disputeId} d={d} sandbox={data.sandbox} onChanged={load} />)}
        </>
      )}
      <div className="card dispute-practice" data-tour="disputes">
        <h2>Try it on a practice case</h2>
        <p className="muted small">PayPal&apos;s sandbox has no way to open a dispute by API: a buyer opens one in PayPal&apos;s Resolution Center. To see the whole flow now, open a practice case on a paid booking. It stays in Flow and is never sent to PayPal.</p>
        <div className="inline-form">
          <select value={pick} onChange={e => setPick(e.target.value)} aria-label="Paid booking">
            <option value="">{paid == null ? 'Loading bookings…' : paid.length ? 'Pick a paid booking' : 'No paid bookings in the last 30 days'}</option>
            {(paid || []).map(e => <option key={e.id} value={e.id}>{day(e.startDate)} · {e.name}{e.customer ? ` · ${e.customer}` : ''} · {e.paid}</option>)}
          </select>
          <button className="btn-sm" onClick={practice} disabled={!pick || busy}>{busy ? 'Opening…' : 'Open practice case'}</button>
        </div>
      </div>
    </div>
  )
}
