'use client'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../../lib/api'
import { formatMoney } from '../../../lib/money'
import Grid from '../../../lib/Grid'
import { TwoLines } from '../../../lib/GridCells'

// Plain-English labels for the engine's values.
const UNIT_TYPES = [['person', 'Staff member'], ['resource', 'Shared resource (room, chair)'], ['queue', 'Walk-in queue']]
// No paying at the visit: a priced service is paid when booking (in full or a
// deposit; the rest is paid with PayPal later). "Free" only for a $0 service.
const PAYMENT_MODES = [['full_prepaid', 'Paid in full when booking'], ['deposit_percent', 'Percentage deposit when booking'], ['deposit_fixed', 'Fixed deposit when booking'], ['none', 'Free (no payment)']]
const label = (list, v) => (list.find(([k]) => k === v) || [v, v])[1]
const DURATION_MODES = [
  ['fixed', 'Fixed length'],
  ['variable', 'Ask the customer (no fixed slots)'],
]
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']]

const EMPTY = {
  name: '', price: '', duration: '30', durationMode: 'fixed', bufferAfterMins: '0',
  unitType: 'person', paymentMode: 'full_prepaid',
  customHours: false,
  availability: { open: '09:00', close: '18:00', workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] }
}

export default function Services() {
  const [services, setServices] = useState(null)
  const [staff, setStaff] = useState([])
  const [form, setForm] = useState(EMPTY)
  const [staffIds, setStaffIds] = useState(null)     // who does it (null = everyone, until edited)
  const [editingId, setEditingId] = useState(null)
  const formRef = useRef(null)

  function load() {
    api('/dashboard/services').then(d => setServices(d?.services || []))
    api('/dashboard/staff').then(d => setStaff(d?.staff || []))
  }
  useEffect(load, [])

  function reset() { setForm(EMPTY); setEditingId(null); setStaffIds(null) }
  const doers = id => staff.filter(p => (p.services || []).includes(id))
  const picked = staffIds ?? staff.map(p => p.staffId)
  function toggleStaff(id) { setStaffIds(picked.includes(id) ? picked.filter(x => x !== id) : [...picked, id]) }

  function loadIntoForm(s) {
    setEditingId(s.serviceId)
    setStaffIds(doers(s.serviceId).map(p => p.staffId))
    setForm({
      name: s.name || '',
      price: String(s.price ?? ''),
      duration: String(s.duration ?? '30'),
      durationMode: s.durationMode || 'fixed',
      bufferAfterMins: String(s.bufferAfterMins ?? '0'),
      unitType: s.unitType || 'person',
      paymentMode: s.paymentMode || 'none',
      customHours: !!s.availability,
      availability: s.availability || EMPTY.availability
    })
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function setAvail(patch) { setForm({ ...form, availability: { ...form.availability, ...patch } }) }
  function toggleDay(key) {
    const days = form.availability.workingDays || []
    setAvail({ workingDays: days.includes(key) ? days.filter(d => d !== key) : [...days, key] })
  }

  async function submit(e) {
    e.preventDefault()
    const body = {
      name: form.name,
      price: Number(form.price) || 0,
      duration: Number(form.duration) || 30,
      durationMode: form.durationMode,
      bufferAfterMins: Number(form.bufferAfterMins) || 0,
      unitType: form.unitType,
      paymentMode: form.paymentMode,
      availability: form.customHours ? form.availability : null,
      ...(form.unitType === 'person' ? { staffIds: picked } : {})
    }
    if (editingId) await api('/dashboard/services', { method: 'PATCH', body: { serviceId: editingId, ...body } })
    else await api('/dashboard/services', { method: 'POST', body })
    reset()
    load()
  }

  async function toggleActive(s) {
    await api('/dashboard/services', { method: 'PATCH', body: { serviceId: s.serviceId, active: !s.active } })
    load()
  }
  async function remove(s) {
    if (!confirm(`Delete "${s.name}"?`)) return
    await api('/dashboard/services', { method: 'DELETE', body: { serviceId: s.serviceId } })
    if (editingId === s.serviceId) reset()
    load()
  }

  const isQueue = form.unitType === 'queue'
  const isVariable = form.durationMode === 'variable'
  const length = s => s.unitType === 'queue' ? 'Walk-in' : s.durationMode === 'variable' ? 'Varies' : `${s.duration} min${s.bufferAfterMins ? ` + ${s.bufferAfterMins} gap` : ''}`

  return (
    <div>
      <h1>Services &amp; prices</h1>
      <p className="page-lead">What customers can book, what it costs and how it&apos;s paid. The assistant quotes exactly these prices.</p>

      {services === null ? <p className="muted">Loading…</p> : services.length ? (
        <div className="grid-wrap">
          <Grid rowData={services} getRowId={r => r.data.serviceId} domLayout="autoHeight" rowHeight={54} columnDefs={[
            { headerName: 'Service', field: 'name', flex: 1, minWidth: 160, cellRenderer: p => <TwoLines a={<b>{p.value}</b>} b={p.data.availability ? 'Own hours' : ''} /> },
            { headerName: 'Price', field: 'price', width: 100, filter: 'agNumberColumnFilter', valueFormatter: p => (p.value ? formatMoney(p.value) : '—') },
            { headerName: 'Length', colId: 'length', width: 110, valueGetter: p => length(p.data) },
            { headerName: 'Booked with', colId: 'with', flex: 1, minWidth: 150, valueGetter: p => p.data.unitType === 'person' ? doers(p.data.serviceId).map(x => x.name).join(', ') : label(UNIT_TYPES, p.data.unitType).replace(/ \(.*\)$/, ''),
              cellRenderer: p => p.value || <span className="badge badge-yellow" title="Nobody can take this booking yet: pick who does it (Edit), or on the Staff page">Nobody yet</span> },
            { headerName: 'Payment', colId: 'payment', width: 200, valueGetter: p => label(PAYMENT_MODES, p.data.paymentMode) },
            { headerName: 'Status', colId: 'status', width: 100, valueGetter: p => (p.data.active ? 'Active' : 'Hidden'), cellRenderer: p => <span className={`badge ${p.data.active ? 'badge-green' : 'badge-gray'}`}>{p.value}</span> },
            { headerName: '', colId: 'actions', width: 210, sortable: false, filter: false, resizable: false, cellRenderer: p => (
              <div className="btn-row grid-btns">
                <button className="btn-sm btn-secondary" onClick={() => loadIntoForm(p.data)}>Edit</button>
                <button className="btn-sm btn-secondary" onClick={() => toggleActive(p.data)}>{p.data.active ? 'Hide' : 'Show'}</button>
                <button className="btn-sm btn-danger" onClick={() => remove(p.data)}>Delete</button>
              </div>) }
          ]} />
        </div>
      ) : <div className="empty">No services yet. Add your first one below.</div>}

      <div className="card" ref={formRef} style={{ marginTop: 24 }}>
        <h2>{editingId ? `Edit ${form.name || 'service'}` : 'Add a service'}</h2>
        <p className="card-lead">{editingId ? 'Changes apply to new bookings.' : 'It becomes bookable on every channel right away, with the staff you pick.'}</p>
        <form onSubmit={submit}>
          <div className="form-row">
            <div className="form-group">
              <label>Name</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Haircut" required />
            </div>
            <div className="form-group">
              <label>Price ($)</label>
              <input type="number" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} placeholder="0" />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Booked with</label>
              <select value={form.unitType} onChange={e => setForm({ ...form, unitType: e.target.value })}>
                {UNIT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Payment</label>
              <select value={form.paymentMode} onChange={e => setForm({ ...form, paymentMode: e.target.value })}>
                {PAYMENT_MODES.filter(([v]) => v !== 'none' || !(Number(form.price) > 0)).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {/^deposit/.test(form.paymentMode) && <div className="field-hint">The rest is paid with PayPal before the visit: the customer can pay it from the chat, voice or their own AI, or you send a link from Bookings.</div>}
            </div>
          </div>

          {form.unitType === 'person' && (
            <div className="form-group">
              <label>Who does it?</label>
              {staff.length ? (
                <>
                  <div className="chips">
                    {staff.map(p => (
                      <button type="button" key={p.staffId} onClick={() => toggleStaff(p.staffId)} className={`chip-toggle ${picked.includes(p.staffId) ? 'on' : ''}`}>{p.name}</button>
                    ))}
                  </div>
                  {!picked.length && <div className="field-hint">Nobody picked: customers can&apos;t book it until someone does it.</div>}
                </>
              ) : <div className="field-hint">No staff yet. Add people on the Staff page, then pick who does this.</div>}
            </div>
          )}

          {!isQueue && (
            <>
              <div className="form-group">
                <label>Slot length</label>
                <select value={form.durationMode} onChange={e => setForm({ ...form, durationMode: e.target.value })}>
                  {DURATION_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {isVariable && <p className="field-hint">The assistant asks the customer how long they need, with no fixed slot grid.</p>}
              </div>

              {!isVariable && (
                <div className="form-row">
                  <div className="form-group">
                    <label>Duration (min)</label>
                    <input type="number" min="5" step="5" value={form.duration} onChange={e => setForm({ ...form, duration: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>Gap after (min)</label>
                    <input type="number" min="0" step="5" value={form.bufferAfterMins} onChange={e => setForm({ ...form, bufferAfterMins: e.target.value })} />
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="check">
                  <input type="checkbox" checked={form.customHours} onChange={e => setForm({ ...form, customHours: e.target.checked })} />
                  Own hours for this service (otherwise uses business hours)
                </label>
              </div>

              {form.customHours && (
                <div className="subpanel">
                  <div className="form-row">
                    <div className="form-group">
                      <label>Open</label>
                      <input type="time" value={form.availability.open} onChange={e => setAvail({ open: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label>Close</label>
                      <input type="time" value={form.availability.close} onChange={e => setAvail({ close: e.target.value })} />
                    </div>
                  </div>
                  <span className="field-label">Days</span>
                  <div className="chips">
                    {DAYS.map(([key, l]) => (
                      <button type="button" key={key} onClick={() => toggleDay(key)}
                        className={`chip-toggle ${form.availability.workingDays.includes(key) ? 'on' : ''}`}>{l}</button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="btn-row" style={{ marginTop: 4 }}>
            <button type="submit">{editingId ? 'Save changes' : 'Add service'}</button>
            {editingId && <button type="button" className="btn-secondary" onClick={reset}>Cancel</button>}
          </div>
        </form>
      </div>
    </div>
  )
}
