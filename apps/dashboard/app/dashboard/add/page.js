'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { demoApi, adoptOwnerToken } from '../../../lib/demo'
import { iconFor } from '../../../lib/kinds'

// "+ Add a business" (phase 2): a name, a kind and
// a pin within a few miles of the customer's demo home. Then it's set up on /dashboard/added.
// Leaflet needs the browser, so the map loads client-side only.
const SpotPicker = dynamic(() => import('../../../lib/SpotPicker'), { ssr: false, loading: () => <div className="spot-map" style={{ height: 320 }} /> })

export default function AddBusiness() {
  const router = useRouter()
  const [opts, setOpts] = useState(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('')
  const [spot, setSpot] = useState(null)       // { lat, lng, neighborhood, miles }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { demoApi('/businesses').then(d => setOpts(d?.add || null)) }, [])

  // Every pick is checked by the server too: inside the circle, and which neighbourhood it's near.
  async function choose(p) {
    setError('')
    const r = await demoApi('/businesses/place', { method: 'POST', body: p })
    if (r?.error) { setError(r.error); return }
    setSpot(r)
  }
  async function randomSpot() {
    setError('')
    const r = await demoApi('/businesses/spot')
    if (r && !r.error) setSpot(r)
  }

  async function create() {
    setBusy(true); setError('')
    const r = await demoApi('/businesses', { method: 'POST', body: { name, kind, lat: spot?.lat, lng: spot?.lng } })
    if (!r?.created) { setBusy(false); setError(r?.error || 'Could not add the business.'); return }
    adoptOwnerToken(r.ownerToken, r.businessId)
    window.location.href = '/dashboard/added'
  }

  if (!opts) return <p className="muted">Loading…</p>
  const full = opts.added >= opts.max
  const missing = !name.trim() ? 'Give it a name' : !kind ? 'Pick what kind of business it is' : !spot ? 'Put it on the map' : null

  return (
    <div className="add-page">
      <div className="page-head">
        <div>
          <h1>Add a business</h1>
          <p className="page-lead">Put your own business on the customer&apos;s map, within {opts.radiusMiles} miles of their demo home, so it shows up when the customer searches nearby, asks by voice, or uses their own AI. You&apos;ll set it up next.</p>
        </div>
      </div>

      {full ? (
        <div className="notice notice-info">This demo allows {opts.max} added businesses per session, and you&apos;ve added both. Switch to one from the business menu at the top.</div>
      ) : (
        <div className="card">
          <div className="form-group">
            <label htmlFor="biz-name">Name</label>
            <input id="biz-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Polished Nail Bar" maxLength={60} />
          </div>

          <div className="form-group">
            <label id="kind-label">What kind of business</label>
            <div className="chips" role="radiogroup" aria-labelledby="kind-label">
              {opts.kinds.map(k => (
                <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`chip-toggle kind-chip ${kind === k.id ? 'on' : ''}`} onClick={() => setKind(k.id)}>
                  <span aria-hidden="true">{iconFor(k.id)}</span> {k.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>Where</label>
            <div className="spot-head">
              {spot
                ? <span className="spot-chosen">{iconFor(kind)} Near <b>{spot.neighborhood}</b> · {spot.miles} mi from the customer</span>
                : <span className="muted small">Click inside the blue circle, or let Flow pick a spot.</span>}
              <button type="button" className="btn-sm btn-secondary" onClick={randomSpot}>Pick a spot for me</button>
            </div>
            <SpotPicker home={opts.home} radiusMiles={opts.radiusMiles} value={spot} kind={kind} onPick={choose} height={320} />
            <div className="field-hint">🏠 is the customer&apos;s home ({opts.home.label}); the circle is {opts.radiusMiles} miles. That location is made up for the demo; yours is never used.</div>
          </div>

          {error && <p className="notice notice-warn">{error}</p>}
          <div className="card-foot">
            <button type="button" onClick={create} disabled={!!missing || busy}>{busy ? 'Adding…' : 'Add it and set it up'}</button>
            <button type="button" className="btn-secondary" onClick={() => router.push('/dashboard')}>Cancel</button>
            {missing && <span className="muted small">{missing}.</span>}
          </div>
        </div>
      )}
    </div>
  )
}
