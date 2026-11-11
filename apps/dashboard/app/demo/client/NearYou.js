'use client'
import { useCallback, useEffect, useState } from 'react'
import { demoApi } from '../../../lib/demo'
import CityMap from './CityMap'
import { ICON } from '../../../lib/kinds'

// "Near you": the demo city around the customer on a real street map, with each place's
// distance, hours, prices and the customer's history ("your usual"). Distances are from
// the customer's made-up home, a test location: the visitor's real location is never
// asked for or used.
// detailed: the full page (cards with services and a Book button); otherwise
// the compact column next to the chat.

const LABEL = { salon: 'Hair salon', barber: 'Barber', spa: 'Day spa', nails: 'Nail studio', massage: 'Massage studio', fitness: 'Fitness studio', tattoo: 'Tattoo studio', pets: 'Pet grooming', other: 'Local business' }
const street = a => String(a || '').split(',')[0]
const placeId = name => `place-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
const fromPrice = p => p.services.map(s => s.price).sort((a, b) => parseFloat(a.slice(1)) - parseFloat(b.slice(1)))[0]

export default function NearYou({ refreshKey, detailed = false, onBook }) {
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState(null)

  const load = useCallback(() => demoApi('/places').then(d => d?.places && setData(d)), [])
  useEffect(() => { load() }, [load, refreshKey])

  // Clicking a pin brings its card into view; hovering only highlights.
  function pick(name, how) {
    setSelected(name)
    if (how === 'click') document.getElementById(placeId(name))?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  if (!data) return <p className="muted small">Loading the city…</p>
  const loc = data.location   // always the customer's made-up home

  if (!detailed) {
    return (
      <div className="near-compact">
        <CityMap places={data.places} location={loc} selected={selected} onSelect={setSelected} height={170} compact />
        <div className="near-compact-loc">
          <span className="muted small"><span className="demo-tag">Demo location</span> Your home, {loc.neighborhood || 'Austin'}</span>
        </div>
        {data.places.map(p => (
          <div key={p.name} className={`near-mini ${selected === p.name ? 'on' : ''}`} onMouseEnter={() => setSelected(p.name)}>
            <span className={`place-icon sm cat-${p.category}`} aria-hidden="true">{ICON[p.category] || '•'}</span>
            <div className="near-mini-body">
              <div className="near-mini-name">{p.name}</div>
              <div className="muted small">{p.distanceMi} mi · from {fromPrice(p)}</div>
              {p.visits > 0 && <span className="usual-tag">Your usual</span>}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="near-page">
      <div className="near-bar">
        <div>
          <div className="near-bar-label">Showing places near</div>
          <b>Your home, {loc.neighborhood || 'Austin'} <span className="demo-tag">Demo location</span></b>
          <div className="near-bar-note">A made-up Austin address for testing. Flow never asks for or uses your real location.</div>
        </div>
      </div>

      <div className="near-map-card">
        <CityMap places={data.places} location={loc} selected={selected} onSelect={pick} height={320} />
      </div>

      <div className="place-grid">
        {data.places.map(p => {
          const more = p.services.length - 3
          return (
            <article key={p.name} id={placeId(p.name)} className={`place ${selected === p.name ? 'on' : ''}`} onMouseEnter={() => setSelected(p.name)}>
              <header className="place-top">
                <span className={`place-icon cat-${p.category}`} aria-hidden="true">{ICON[p.category] || '•'}</span>
                <div className="place-id">
                  <h3>{p.name}</h3>
                  <div className="muted small">{LABEL[p.category] || 'Business'} · {p.neighborhood}</div>
                </div>
                {p.distanceMi != null && <span className="place-dist">{p.distanceMi} mi</span>}
              </header>

              {p.visits > 0 && (
                <div className="place-usual">★ Your usual · {p.visits} visits{p.usualStaff ? ` · with ${p.usualStaff}` : ''}</div>
              )}

              <dl className="place-facts">
                <div><dt>Hours</dt><dd>{p.hours}</dd></div>
                <div><dt>Address</dt><dd>{street(p.address)}</dd></div>
              </dl>

              <ul className="place-services">
                {p.services.slice(0, 3).map(s => (
                  <li key={s.name}><span>{s.name}</span><span className="muted">{s.minutes ? `${s.minutes} min` : ''}</span><b>{s.price}</b></li>
                ))}
                {more > 0 && <li className="muted small">+ {more} more</li>}
              </ul>

              <footer className="place-foot">
                <span className="muted small">{p.staff?.length ? `${p.staff.length} staff` : ''}</span>
                {onBook && <button className="btn-sm" onClick={() => onBook(p.name)}>Book here</button>}
              </footer>
            </article>
          )
        })}
      </div>
    </div>
  )
}
