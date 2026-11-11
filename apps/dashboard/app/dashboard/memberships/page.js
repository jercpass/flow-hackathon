'use client'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import Grid from '../../../lib/Grid'
import { TwoLines } from '../../../lib/GridCells'

// Memberships and packs (core/memberships): monthly plans are PayPal
// subscriptions (PayPal bills each member every month), packs are one PayPal
// payment. Members, monthly recurring revenue, and the plans themselves; the
// owner can also do all of this by asking their own AI (owner MCP link).

const EMPTY = { name: '', kind: 'monthly', price: '', service: '', uses: 1, discount: '', discountService: '', validDays: 180 }

export default function MembershipsPage() {
  const [data, setData] = useState(null)
  const [services, setServices] = useState([])
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null)

  const load = useCallback(() => api('/dashboard/memberships').then(d => d && !d.error && setData(d)), [])
  useEffect(() => {
    load()
    api('/dashboard/services').then(d => d?.services && setServices(d.services.filter(s => s.active !== false)))
  }, [load])

  async function act(label, path, body, method = 'POST') {
    setBusy(label); setMsg(null)
    const r = await api(path, { method, body })
    setBusy('')
    if (!r || r.error) { setMsg({ ok: false, text: r?.error || 'Something went wrong.' }); return false }
    setMsg({ ok: true, text: (r.changes || []).join('; ') || 'Saved.' })
    await load()
    return true
  }

  async function create(e) {
    e.preventDefault()
    const ok = await act('create', '/dashboard/memberships', {
      name: form.name, kind: form.kind, price: Number(form.price),
      covers: form.service ? [{ service_name: form.service, uses: Number(form.uses) || 1 }] : [],
      ...(form.discount ? { discount_percent: Number(form.discount), discount_services: form.discountService ? [form.discountService] : [] } : {}),
      ...(form.kind === 'pack' ? { valid_days: Number(form.validDays) || 180 } : {})
    })
    if (ok) setForm(null)
  }

  function reprice(plan) {
    const v = window.prompt(`New price for ${plan.name} (USD${plan.kind === 'pack' ? '' : ' a month'}). Current members keep their price.`)
    if (v) act(`price-${plan.name}`, '/dashboard/memberships', { plan_name: plan.name, price: Number(v) }, 'PATCH')
  }

  function cancelMember(m) {
    if (window.confirm(`Cancel ${m.customer}'s ${m.plan}? PayPal stops billing; their uses last until the end of the month.`)) {
      act(`cancel-${m.customer}`, '/dashboard/memberships/cancel-member', { customer_name: m.customer, plan_name: m.plan })
    }
  }

  if (!data) return <p className="muted">Loading…</p>
  const active = data.members.filter(m => m.status === 'active')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <div data-tour="members">
      <div className="page-head">
        <h1>Memberships</h1>
        <div className="btn-row"><button type="button" onClick={() => setForm(form ? null : { ...EMPTY, service: services[0]?.name || '' })}>{form ? 'Close' : 'New plan'}</button></div>
      </div>
      <p className="page-lead">Monthly memberships are charged to each member's saved PayPal every month, and they can cancel any time. Packs are one payment from their saved PayPal. Bookings a plan covers cost the customer nothing; the assistant offers plans when customers ask about packs or deals.</p>

      <div className="stat-grid">
        <div className="stat-card"><div className="label">Monthly recurring revenue</div><div className="value">{data.monthly_recurring_revenue}</div><div className="muted small">from active memberships</div></div>
        <div className="stat-card"><div className="label">Active members</div><div className="value">{active.length}</div><div className="muted small">{data.members.length - active.length} cancelled or ended</div></div>
        <div className="stat-card"><div className="label">Pack sales</div><div className="value">{data.pack_sales}</div><div className="muted small">paid once</div></div>
      </div>

      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-error'}`} style={{ marginBottom: 14 }}>{msg.text}</p>}

      {form && (
        <form className="card editor" onSubmit={create} style={{ marginBottom: 20 }}>
          <h2>New plan</h2>
          <div className="form-row">
            <div className="form-group"><label>Name</label><input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Willow Monthly" required /></div>
            <div className="form-group"><label>Kind</label>
              <select value={form.kind} onChange={e => set('kind', e.target.value)}><option value="monthly">Monthly membership (charged monthly)</option><option value="pack">Pack (one payment)</option></select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Price (USD{form.kind === 'pack' ? ', once' : ' a month'})</label><input type="number" min="1" step="0.01" value={form.price} onChange={e => set('price', e.target.value)} required /></div>
            <div className="form-group"><label>Includes</label>
              <div className="unit-input"><input type="number" min="1" max="100" value={form.uses} onChange={e => set('uses', e.target.value)} />
                <select value={form.service} onChange={e => set('service', e.target.value)}>{services.map(s => <option key={s.serviceId} value={s.name}>{s.name}</option>)}</select>
                <span>{form.kind === 'pack' ? 'in total' : 'a month'}</span></div>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group"><label>Member discount (optional)</label>
              <div className="unit-input"><input type="number" min="0" max="90" value={form.discount} onChange={e => set('discount', e.target.value)} placeholder="10" /><span>% off</span>
                <select value={form.discountService} onChange={e => set('discountService', e.target.value)}><option value="">other services</option>{services.map(s => <option key={s.serviceId} value={s.name}>{s.name}</option>)}</select></div>
            </div>
            {form.kind === 'pack' && <div className="form-group"><label>Use within (days)</label><input type="number" min="7" max="730" value={form.validDays} onChange={e => set('validDays', e.target.value)} /></div>}
          </div>
          <div className="card-foot"><button type="submit" disabled={busy === 'create'}>{busy === 'create' ? 'Creating…' : 'Create plan'}</button><span className="muted small">The PayPal plan is created the first time someone joins.</span></div>
        </form>
      )}

      <div className="section-title"><h2>Plans</h2></div>
      {data.plans.length ? (
        <div className="grid-wrap">
          <Grid rowData={data.plans} getRowId={r => r.data.name} domLayout="autoHeight" rowHeight={54} columnDefs={[
            { headerName: 'Plan', field: 'name', flex: 1, minWidth: 150, cellRenderer: p => <TwoLines a={<b>{p.value}</b>} b={`${p.data.kind}${p.data.paused ? ' · paused' : ''}`} /> },
            { headerName: 'Price', field: 'price', width: 120 },
            { headerName: 'Includes', field: 'includes', flex: 1, minWidth: 160 },
            { headerName: 'Member discount', field: 'discount', width: 150, valueFormatter: p => p.value || '—' },
            { headerName: 'Members', field: 'members', width: 110, filter: 'agNumberColumnFilter' },
            { headerName: '', colId: 'actions', width: 230, sortable: false, filter: false, resizable: false, cellRenderer: p => (
              <div className="btn-row grid-btns">
                <button type="button" className="btn-sm btn-secondary" onClick={() => reprice(p.data)} disabled={!!busy}>Change price</button>
                <button type="button" className="btn-sm btn-secondary" onClick={() => act(`pause-${p.data.name}`, '/dashboard/memberships', { plan_name: p.data.name, active: !!p.data.paused }, 'PATCH')} disabled={!!busy}>{p.data.paused ? 'Offer again' : 'Pause'}</button>
              </div>) }
          ]} />
        </div>
      ) : <div className="empty">No plans yet. Create one, or ask your own AI: “Create a $35 monthly haircut membership.”</div>}

      <div className="section-title"><h2>Members</h2></div>
      {data.members.length ? (
        <div className="grid-wrap">
          <Grid rowData={data.members} getRowId={r => `${r.data.customer}-${r.data.plan}-${r.data.since}`} domLayout="autoHeight" rowHeight={54} columnDefs={[
            { headerName: 'Customer', field: 'customer', flex: 1, minWidth: 150, cellRenderer: p => <TwoLines a={<b>{p.value}</b>} b={`since ${p.data.since}`} /> },
            { headerName: 'Plan', field: 'plan', flex: 1, minWidth: 130 },
            { headerName: 'Status', field: 'status', width: 170, cellRenderer: p => <span><span className={`badge ${p.value === 'active' ? 'badge-green' : 'badge-gray'}`}>{p.value}</span>{p.data.payment_failed && <span className="badge badge-red" style={{ marginLeft: 6 }}>payment failed</span>}</span> },
            { headerName: 'Uses left', field: 'uses_left', width: 110, valueFormatter: p => p.value || '—' },
            { headerName: 'Renews / ends', colId: 'when', width: 170, valueGetter: p => (p.data.renews ? `renews ${p.data.renews}` : p.data.ends ? `ends ${p.data.ends}` : '—') },
            { headerName: '', colId: 'actions', width: 110, sortable: false, filter: false, resizable: false, cellRenderer: p => (p.data.status === 'active' && p.data.kind === 'monthly'
              ? <button type="button" className="btn-sm btn-danger" onClick={() => cancelMember(p.data)} disabled={!!busy}>Cancel</button> : null) }
          ]} />
        </div>
      ) : <div className="empty">No members yet. When a customer joins from the chat (paid from their saved PayPal), they show up here.</div>}
    </div>
  )
}
