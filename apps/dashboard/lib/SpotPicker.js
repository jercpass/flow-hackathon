'use client'
import { useEffect, useRef } from 'react'
import 'leaflet/dist/leaflet.css'
import { iconFor } from './kinds'

// Pick where a new business goes: Leaflet + OpenStreetMap (no API key), centred
// on the customer's demo home with the circle the business must sit inside. Click or drag the
// pin; a spot outside the circle snaps to its edge. Never asks for the visitor's
// real location: the home is the demo customer's.

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const METERS_PER_MILE = 1609.344

export default function SpotPicker({ home, radiusMiles, value, kind, onPick, height = 360 }) {
  const box = useRef(null)
  const map = useRef(null)
  const pin = useRef(null)
  const L = useRef(null)
  const pick = useRef(onPick)
  pick.current = onPick

  useEffect(() => {
    let dead = false
    let ro = null
    import('leaflet').then(mod => {
      if (dead || !box.current || map.current) return
      const Lf = L.current = mod.default || mod
      const m = map.current = Lf.map(box.current, { scrollWheelZoom: false, zoomSnap: 0.25 })
      Lf.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(m)
      // A view first: Leaflet can't measure layers on a map that has none.
      m.setView([home.lat, home.lng], 13)
      Lf.circle([home.lat, home.lng], { radius: radiusMiles * METERS_PER_MILE, color: '#2563eb', weight: 2, fillOpacity: 0.06 }).addTo(m)
      Lf.marker([home.lat, home.lng], { icon: Lf.divIcon({ className: '', html: '<div class="map-home" title="Customer\'s home">🏠</div>', iconSize: [28, 28], iconAnchor: [14, 14] }), keyboard: false })
        .addTo(m).bindTooltip(`Customer's home · ${home.label || 'Travis Heights'}`)
      const fit = () => m.fitBounds(Lf.latLng(home.lat, home.lng).toBounds(2 * radiusMiles * METERS_PER_MILE), { padding: [12, 12] })
      fit()
      m.on('click', e => pick.current(inside(m, e.latlng)))
      // A map laid out while hidden measures 0×0: re-measure and re-fit when its box changes.
      ro = new ResizeObserver(() => { m.invalidateSize(); if (!pin.current) fit() })
      ro.observe(box.current)
      draw()
    })
    return () => { dead = true; ro?.disconnect(); map.current?.remove(); map.current = null; pin.current = null }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { draw() }, [value?.lat, value?.lng, kind])   // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the spot inside the circle: outside, move it to the edge on the same bearing.
  function inside(m, latlng) {
    const centre = L.current.latLng(home.lat, home.lng)
    const max = radiusMiles * METERS_PER_MILE * 0.995
    const d = m.distance(centre, latlng)
    if (d <= max) return { lat: latlng.lat, lng: latlng.lng }
    const k = max / d
    return { lat: centre.lat + (latlng.lat - centre.lat) * k, lng: centre.lng + (latlng.lng - centre.lng) * k }
  }

  function draw() {
    const Lf = L.current, m = map.current
    if (!Lf || !m) return
    if (!value) { pin.current?.remove(); pin.current = null; return }
    const icon = Lf.divIcon({ className: 'map-pin-wrap on', html: `<div class="map-pin"><span>${iconFor(kind)}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34] })
    if (!pin.current) {
      pin.current = Lf.marker([value.lat, value.lng], { icon, draggable: true }).addTo(m)
      pin.current.on('dragend', () => {
        const p = inside(m, pin.current.getLatLng())
        pin.current.setLatLng([p.lat, p.lng])
        pick.current(p)
      })
    } else {
      pin.current.setLatLng([value.lat, value.lng])
      pin.current.setIcon(icon)
    }
  }

  return <div ref={box} className="spot-map" style={{ height }} role="application" aria-label={`Map: click inside the ${radiusMiles}-mile circle around the customer's home to place the business`} />
}
