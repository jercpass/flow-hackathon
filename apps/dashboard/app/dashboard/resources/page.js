'use client'
import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import Grid from '../../../lib/Grid'
import { TwoLines } from '../../../lib/GridCells'
import { formatMoney } from '../../../lib/money'

export default function StaffResources() {
  const [services, setServices] = useState([])
  const [staff, setStaff] = useState([])
  const [resources, setResources] = useState([])
  const [staffForm, setStaffForm] = useState({ name: '', services: [] })
  const [servicesFor, setServicesFor] = useState(null)   // staffId whose services are being edited
  const [chosen, setChosen] = useState([])
  const [resourceName, setResourceName] = useState('')
  const [hoursFor, setHoursFor] = useState(null)
  const [hours, setHours] = useState({ workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], open: '09:00', close: '18:00' })
  const [pricingFor, setPricingFor] = useState(null)
  const [overrides, setOverrides] = useState({})

  function loadAll() {
    api('/dashboard/services').then(d => setServices((d?.services || []).filter(s => s.active)))
    api('/dashboard/staff').then(d => setStaff(d?.staff || []))
    api('/dashboard/resources').then(d => setResources(d?.resources || []))
  }
  useEffect(loadAll, [])

  const personServices = services.filter(s => s.unitType === 'person')
  const resourceServices = services.filter(s => s.unitType === 'resource')

  function toggleStaffService(serviceId) {
    const has = staffForm.services.includes(serviceId)
    setStaffForm({ ...staffForm, services: has ? staffForm.services.filter(s => s !== serviceId) : [...staffForm.services, serviceId] })
  }

  async function addStaff(e) {
    e.preventDefault()
    await api('/dashboard/staff', { method: 'POST', body: staffForm })
    setStaffForm({ name: '', services: [] })
    loadAll()
  }
  async function removeStaff(s) {
    if (!confirm(`Remove ${s.name}?`)) return
    await api('/dashboard/staff', { method: 'DELETE', body: { staffId: s.staffId } })
    loadAll()
  }
  function openHours(s) {
    setHoursFor(s.staffId); setServicesFor(null); setPricingFor(null)
    setHours(s.availability || { workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], open: '09:00', close: '18:00' })
  }
  function toggleHoursDay(key) {
    const days = hours.workingDays || []
    setHours({ ...hours, workingDays: days.includes(key) ? days.filter(d => d !== key) : [...days, key] })
  }
  async function saveHours() {
    await api('/dashboard/staff', { method: 'PATCH', body: { staffId: hoursFor, availability: hours } })
    setHoursFor(null); loadAll()
  }
  function openPricing(s) {
    setPricingFor(s.staffId); setServicesFor(null); setHoursFor(null)
    setOverrides({ ...(s.priceOverrides || {}) })
  }
  async function savePricing() {
    const clean = {}
    for (const [sid, v] of Object.entries(overrides)) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) clean[sid] = n
    }
    await api('/dashboard/staff', { method: 'PATCH', body: { staffId: pricingFor, priceOverrides: clean } })
    setPricingFor(null); loadAll()
  }
  async function clearHours(s) {
    await api('/dashboard/staff', { method: 'PATCH', body: { staffId: s.staffId, availability: null } })
    loadAll()
  }
  async function addResource(e) {
    e.preventDefault()
    if (!resourceName) return
    await api('/dashboard/resources', { method: 'POST', body: { name: resourceName } })
    setResourceName('')
    loadAll()
  }
  async function removeResource(r) {
    await api('/dashboard/resources', { method: 'DELETE', body: { resourceId: r.resourceId } })
    loadAll()
  }

  const serviceName = id => services.find(s => s.serviceId === id)?.name || id

  function openServices(s) { setServicesFor(s.staffId); setChosen(s.services || []); setHoursFor(null); setPricingFor(null) }
  async function saveServices() {
    await api('/dashboard/staff', { method: 'PATCH', body: { staffId: servicesFor, services: chosen } })
    setServicesFor(null)
    api('/dashboard/staff').then(d => setStaff(d?.staff || []))
  }
  const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']]
  const fmtHours = a => `${a.open}–${a.close}${a.workingDays?.length && a.workingDays.length < 7 ? ` · ${a.workingDays.map(d => d[0].toUpperCase() + d.slice(1)).join(', ')}` : ''}`

  return (
    <div>
      <h1>Staff</h1>
      <p className="page-lead">Who does what. A service is only bookable once someone (or something) can provide it. Each person can have their own hours and prices.</p>

      <div className="section-title"><h2>Team</h2><span className="muted small">for services booked with a staff member</span></div>
      {staff.length ? (
        <div className="grid-wrap">
          <Grid rowData={staff} getRowId={r => r.data.staffId} domLayout="autoHeight" rowHeight={54} columnDefs={[
            // Hours ride under the name, so the four buttons fit beside the services.
            { headerName: 'Name', field: 'name', width: 190, cellRenderer: p => <TwoLines a={<b>{p.value}</b>} b={[p.data.availability ? fmtHours(p.data.availability) : 'Business hours', p.data.priceOverrides && Object.keys(p.data.priceOverrides).length > 0 ? 'Own prices' : ''].filter(Boolean).join(' · ')} /> },
            { headerName: 'Services', colId: 'services', flex: 1, minWidth: 180, valueGetter: p => (p.data.services || []).filter(id => services.some(x => x.serviceId === id)).map(serviceName).join(', '),
              cellRenderer: p => p.value || <span className="badge badge-yellow">No services yet</span> },
            { headerName: '', colId: 'actions', width: 320, pinned: 'right', sortable: false, filter: false, resizable: false, cellRenderer: p => (
              <div className="btn-row grid-btns">
                <button className="btn-sm btn-secondary" onClick={() => openServices(p.data)}>Services</button>
                <button className="btn-sm btn-secondary" onClick={() => openHours(p.data)}>Hours</button>
                <button className="btn-sm btn-secondary" onClick={() => openPricing(p.data)}>Prices</button>
                <button className="btn-sm btn-danger" onClick={() => removeStaff(p.data)}>Remove</button>
              </div>) }
          ]} />
        </div>
      ) : <div className="empty">No staff yet. Add your first team member below.</div>}

      {servicesFor && (
        <div className="card editor">
          <h2>What {staff.find(s => s.staffId === servicesFor)?.name} does</h2>
          <p className="card-lead">Customers can book them for these services. New services show up here as soon as you add them.</p>
          {personServices.length ? (
            <div className="chips" style={{ marginBottom: 14 }}>
              {personServices.map(s => (
                <button type="button" key={s.serviceId} onClick={() => setChosen(c => (c.includes(s.serviceId) ? c.filter(x => x !== s.serviceId) : [...c, s.serviceId]))}
                  className={`chip-toggle ${chosen.includes(s.serviceId) ? 'on' : ''}`}>{s.name}</button>
              ))}
            </div>
          ) : <p className="muted small">No services booked with a staff member yet: add one on Services &amp; prices.</p>}
          <div className="btn-row">
            <button onClick={saveServices}>Save services</button>
            <button className="btn-secondary" onClick={() => setServicesFor(null)}>Cancel</button>
          </div>
        </div>
      )}

      {hoursFor && (
        <div className="card editor">
          <h2>Hours for {staff.find(s => s.staffId === hoursFor)?.name}</h2>
          <p className="card-lead">Bookings with this person only happen inside these hours.</p>
          <span className="field-label">Days</span>
          <div className="chips" style={{ marginBottom: 14 }}>
            {DAYS.map(([key, l]) => (
              <button type="button" key={key} onClick={() => toggleHoursDay(key)} className={`chip-toggle ${hours.workingDays.includes(key) ? 'on' : ''}`}>{l}</button>
            ))}
          </div>
          <div className="form-row">
            <div className="form-group"><label>From</label><input type="time" value={hours.open} onChange={e => setHours({ ...hours, open: e.target.value })} /></div>
            <div className="form-group"><label>To</label><input type="time" value={hours.close} onChange={e => setHours({ ...hours, close: e.target.value })} /></div>
          </div>
          <div className="btn-row">
            <button onClick={saveHours}>Save hours</button>
            <button className="btn-secondary" onClick={() => setHoursFor(null)}>Cancel</button>
            {staff.find(s => s.staffId === hoursFor)?.availability && (
              <button className="btn-ghost" onClick={() => { clearHours(staff.find(s => s.staffId === hoursFor)); setHoursFor(null) }}>Use business hours</button>
            )}
          </div>
        </div>
      )}

      {pricingFor && (
        <div className="card editor">
          <h2>Prices for {staff.find(s => s.staffId === pricingFor)?.name}</h2>
          <p className="card-lead">Leave a price blank to use the service&apos;s base price. Set one if this person costs more, for example a senior stylist.</p>
          {(staff.find(s => s.staffId === pricingFor)?.services || []).map(sid => {
            const svc = services.find(x => x.serviceId === sid)
            return (
              <div key={sid} className="price-row">
                <span>{svc?.name || sid} <span className="muted small">base {formatMoney(svc?.price ?? 0)}</span></span>
                <div className="money-input"><span>$</span>
                  <input type="number" value={overrides[sid] ?? ''} placeholder={String(svc?.price ?? 0)} onChange={e => setOverrides({ ...overrides, [sid]: e.target.value })} />
                </div>
              </div>
            )
          })}
          {!(staff.find(s => s.staffId === pricingFor)?.services || []).length && <p className="muted small">Assign services to this person first.</p>}
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button onClick={savePricing}>Save prices</button>
            <button className="btn-secondary" onClick={() => setPricingFor(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <h2>Add a team member</h2>
        {personServices.length === 0
          ? <p className="card-lead">Add a service booked with a staff member on Services &amp; prices first.</p>
          : (
            <form onSubmit={addStaff}>
              <p className="card-lead">They can be booked as soon as you pick what they do.</p>
              <div className="form-group">
                <label>Name</label>
                <input value={staffForm.name} onChange={e => setStaffForm({ ...staffForm, name: e.target.value })} placeholder="e.g. Maya" required />
              </div>
              <div className="form-group">
                <label>Does which services?</label>
                <div className="chips">
                  {personServices.map(s => (
                    <button type="button" key={s.serviceId} onClick={() => toggleStaffService(s.serviceId)}
                      className={`chip-toggle ${staffForm.services.includes(s.serviceId) ? 'on' : ''}`}>{s.name}</button>
                  ))}
                </div>
              </div>
              <button type="submit">Add team member</button>
            </form>
          )}
      </div>

      <div className="section-title"><h2>Shared resources</h2><span className="muted small">rooms, chairs or tables for services that don&apos;t need a specific person</span></div>
      <div className="card">
        {resourceServices.length === 0 && <p className="card-lead">No services are booked by resource yet. Pick &quot;Shared resource&quot; when adding a service to use these.</p>}
        <form onSubmit={addResource} className="inline-form">
          <input value={resourceName} onChange={e => setResourceName(e.target.value)} placeholder="e.g. Treatment room 1" />
          <button type="submit" className="btn-secondary">Add</button>
        </form>
        {resources.length > 0 && (
          <div className="chips" style={{ marginTop: 12 }}>
            {resources.map(r => (
              <span key={r.resourceId} className="tag">
                {r.name}
                <button type="button" aria-label={`Remove ${r.name}`} onClick={() => removeResource(r)}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
