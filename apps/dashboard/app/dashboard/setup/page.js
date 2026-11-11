'use client'
import { useState, useEffect } from 'react'
import { api } from '../../../lib/api'
import Grid from '../../../lib/Grid'
import { formatMoney } from '../../../lib/money'

// What the example column shows: a booking of this price, cancelled at each tier.
const EXAMPLE_PRICE = 40

// Policies: the rules the assistant quotes word for word, the refund tiers it
// works refunds out from, and the details it collects before confirming.
export default function Policies() {
  const [details, setDetails] = useState(null)
  const [newField, setNewField] = useState('')
  const [detailsSaved, setDetailsSaved] = useState(false)
  const [policies, setPolicies] = useState(null)
  const [policiesSaved, setPoliciesSaved] = useState(false)

  useEffect(() => {
    api('/dashboard/settings').then(d => {
      setDetails(d?.requiredDetails || [])
      setPolicies(d?.policies || { cancellation: '', reschedule: '', refundTiers: [] })
    })
  }, [])

  function toggleRequired(key) {
    setDetails(details.map(d => d.key === key && !d.fixed ? { ...d, required: !d.required } : d))
  }
  function removeField(key) {
    setDetails(details.filter(d => d.key !== key))
  }
  function addField() {
    const label = newField.trim()
    if (!label) return
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    if (details.some(d => d.key === key)) return
    setDetails([...details, { key, label, required: true }])
    setNewField('')
  }
  async function saveDetails() {
    await api('/dashboard/settings', { method: 'PATCH', body: { requiredDetails: details } })
    setDetailsSaved(true); setTimeout(() => setDetailsSaved(false), 2000)
  }
  async function savePolicies() {
    await api('/dashboard/settings', { method: 'PATCH', body: { policies } })
    setPoliciesSaved(true); setTimeout(() => setPoliciesSaved(false), 2000)
  }
  function updateTier(i, field, val) {
    const tiers = [...(policies.refundTiers || [])]
    tiers[i] = { ...tiers[i], [field]: val === '' ? '' : Number(val) }
    setPolicies({ ...policies, refundTiers: tiers })
  }
  function addTier() {
    setPolicies({ ...policies, refundTiers: [...(policies.refundTiers || []), { hoursBefore: 0, refundPct: 0 }] })
  }
  function removeTier(i) {
    setPolicies({ ...policies, refundTiers: (policies.refundTiers || []).filter((_, idx) => idx !== i) })
  }

  const tiers = policies?.refundTiers || []
  // Rows carry their index so an edit lands on the right tier.
  const tierRows = tiers.map((t, i) => ({ ...t, _i: i }))
  const TIER_COLUMNS = [
    { headerName: 'Cancelled at least (hours before)', field: 'hoursBefore', flex: 1, minWidth: 170, editable: true, singleClickEdit: true, cellClass: 'grid-edit', sort: 'desc',
      cellEditor: 'agNumberCellEditor', cellEditorParams: { min: 0, precision: 0 }, valueFormatter: p => (p.value === '' || p.value == null ? '—' : `${p.value} hours`) },
    { headerName: 'Refund', field: 'refundPct', width: 130, editable: true, singleClickEdit: true, cellClass: 'grid-edit',
      cellEditor: 'agNumberCellEditor', cellEditorParams: { min: 0, max: 100, precision: 0 }, valueFormatter: p => (p.value === '' || p.value == null ? '—' : `${p.value}%`) },
    { headerName: `A ${formatMoney(EXAMPLE_PRICE)} booking gets back`, colId: 'example', width: 190, sortable: false, filter: false,
      valueGetter: p => formatMoney(Math.round(EXAMPLE_PRICE * (Number(p.data.refundPct) || 0)) / 100) },
    { headerName: '', colId: 'actions', width: 110, sortable: false, filter: false, resizable: false,
      cellRenderer: p => <button type="button" className="btn-sm btn-ghost" onClick={() => removeTier(p.data._i)} aria-label="Remove tier">Remove</button> }
  ]
  const DETAIL_COLUMNS = [
    { headerName: 'Detail', field: 'label', flex: 1, minWidth: 160 },
    { headerName: 'Asked', field: 'required', width: 110, sortable: false, filter: false,
      cellRenderer: p => <input type="checkbox" checked={!!p.value} disabled={p.data.fixed} onChange={() => toggleRequired(p.data.key)} aria-label={`Ask for ${p.data.label}`} /> },
    { headerName: 'Note', colId: 'note', width: 190, sortable: false, filter: false, valueGetter: p => (p.data.fixed ? 'Always asked' : p.data.key === 'phone' ? 'If the customer gives one' : '') },
    { headerName: '', colId: 'actions', width: 110, sortable: false, filter: false, resizable: false,
      cellRenderer: p => (p.data.fixed ? null : <button type="button" className="btn-sm btn-ghost" onClick={() => removeField(p.data.key)}>Remove</button>) }
  ]

  return (
    <div>
      <h1>Policies</h1>
      <p className="page-lead">The rules the assistant follows and quotes word for word. Refunds are worked out from these tiers automatically.</p>

      {policies && (
        <div className="card" style={{ maxWidth: 820 }}>
          <h2>Cancellations and refunds</h2>
          <p className="card-lead">Leave a box blank if you don&apos;t have that rule. Menu and prices live in Services &amp; prices.</p>
          {[
            ['cancellation', 'Cancellation policy', 'e.g. Free cancellation up to 48 hours before. Refund tiers are set below.'],
            ['reschedule',   'Reschedule policy',   'e.g. Reschedule once for free up to 2 hours before your slot.']
          ].map(([key, label, ph]) => (
            <div className="form-group" key={key}>
              <label>{label}</label>
              <textarea rows={2} value={policies[key] || ''} maxLength={600}
                onChange={e => setPolicies({ ...policies, [key]: e.target.value })} placeholder={ph} />
            </div>
          ))}

          <span className="field-label">Refund when a customer cancels</span>
          <p className="field-hint" style={{ margin: '0 0 10px' }}>How much comes back depends on how early they cancel. The assistant quotes these exact figures.</p>
          {tiers.length > 0 ? (
            <div className="grid-wrap">
              <Grid rowData={tierRows} columnDefs={TIER_COLUMNS} domLayout="autoHeight" getRowId={r => String(r.data._i)}
                onCellValueChanged={e => updateTier(e.data._i, e.colDef.field, e.newValue == null ? '' : e.newValue)} />
            </div>
          ) : <p className="muted small">No tiers yet: every cancellation is refunded in full until you add one.</p>}
          <div className="btn-row" style={{ margin: '10px 0 4px' }}>
            <button type="button" className="btn-secondary btn-sm" onClick={addTier}>+ Add tier</button>
            <span className="muted small">A no-show, or cancelling after the start, is never refunded.</span>
          </div>

          <div className="card-foot">
            <button onClick={savePolicies}>Save policies</button>
            {policiesSaved && <span className="saved">Saved</span>}
          </div>
        </div>
      )}

      {details && (
        <div className="card" style={{ maxWidth: 820 }}>
          <h2>Details to collect</h2>
          <p className="card-lead">What the assistant asks for before confirming a booking.</p>
          <div className="grid-wrap">
            <Grid rowData={details} columnDefs={DETAIL_COLUMNS} domLayout="autoHeight" getRowId={r => r.data.key} />
          </div>
          <div className="inline-form" style={{ marginTop: 12 }}>
            <input value={newField} onChange={e => setNewField(e.target.value)} placeholder="Add a detail, e.g. Allergies" />
            <button type="button" className="btn-secondary" onClick={addField}>Add</button>
          </div>
          <div className="card-foot">
            <button onClick={saveDetails}>Save details</button>
            {detailsSaved && <span className="saved">Saved</span>}
          </div>
        </div>
      )}
    </div>
  )
}
