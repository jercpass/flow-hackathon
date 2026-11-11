'use client'
import { useEffect, useRef } from 'react'
import 'leaflet/dist/leaflet.css'
import { ICON } from '../../../lib/kinds'

// A real street map of the demo city: Leaflet + OpenStreetMap's standard tiles
// (no API key, attribution shown), softened with a CSS filter so the pins stand
// out. Pins for each business, a dot for the customer, hover/click to select.
// Leaflet touches `window`, so it's loaded in the browser only.

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export default function CityMap({ places, location, selected, onSelect, height = 320, compact = false }) {
  const box = useRef(null)
  const map = useRef(null)
  const layer = useRef(null)
  const markers = useRef({})
  const L = useRef(null)
  const pts = useRef([])
  const select = useRef(onSelect)
  select.current = onSelect

  // Create the map once.
  useEffect(() => {
    let dead = false
    import('leaflet').then(mod => {
      if (dead || !box.current || map.current) return
      L.current = mod.default || mod
      // zoomSnap .25: fitBounds can pick an in-between zoom instead of zooming a
      // whole level out, so the pins don't bunch up.
      map.current = L.current.map(box.current, { zoomControl: !compact, attributionControl: true, scrollWheelZoom: false, zoomSnap: 0.25, zoomDelta: 0.5 })
      L.current.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map.current)
      layer.current = L.current.layerGroup().addTo(map.current)
      draw()
      // A map created while hidden (e.g. the side column below 1400px) measures 0×0;
      // re-measure and re-fit whenever its box changes size.
      ro = new ResizeObserver(() => { if (map.current) { map.current.invalidateSize(); fit() } })
      ro.observe(box.current)
    })
    let ro = null
    return () => { dead = true; ro?.disconnect(); map.current?.remove(); map.current = null }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw pins when the places or the customer's location change.
  useEffect(() => { draw() }, [places, location])   // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight the selected pin.
  useEffect(() => {
    for (const [name, m] of Object.entries(markers.current)) {
      const el = m.getElement()
      if (el) el.classList.toggle('on', name === selected)
      if (name === selected) m.setZIndexOffset(1000)
      else m.setZIndexOffset(0)
    }
  }, [selected])

  function draw() {
    const Lf = L.current
    if (!Lf || !map.current || !layer.current) return
    layer.current.clearLayers()
    markers.current = {}
    const all = []
    for (const p of places || []) {
      if (p.lat == null) continue
      const icon = Lf.divIcon({
        className: 'map-pin-wrap',
        html: `<div class="map-pin cat-${esc(p.category)}"><span>${ICON[p.category] || '•'}</span></div>`,
        iconSize: [34, 42], iconAnchor: [17, 40], tooltipAnchor: [0, -38]
      })
      const m = Lf.marker([p.lat, p.lng], { icon, title: p.name, riseOnHover: true })
        .bindTooltip(`<b>${esc(p.name)}</b><br>${esc(p.neighborhood || '')}${p.distanceMi != null ? ` · ${p.distanceMi} mi` : ''}`, { direction: 'top', className: 'map-tip' })
        .on('click', () => select.current?.(p.name, 'click'))
        .on('mouseover', () => select.current?.(p.name, 'hover'))
        .addTo(layer.current)
      markers.current[p.name] = m
      all.push([p.lat, p.lng])
    }
    if (location?.lat != null) {
      Lf.marker([location.lat, location.lng], {
        icon: Lf.divIcon({ className: 'map-you-wrap', html: '<div class="map-you"><i></i></div>', iconSize: [22, 22], iconAnchor: [11, 11], tooltipAnchor: [0, -12] }),
        zIndexOffset: 500, keyboard: false
      }).bindTooltip(esc(`Your home (demo location) · ${location.neighborhood || 'Austin'}`), { direction: 'top', className: 'map-tip' }).addTo(layer.current)
      all.push([location.lat, location.lng])
    }
    pts.current = all
    fit()
  }

  function fit() {
    const el = box.current
    if (!map.current || !pts.current.length || !el || !el.clientWidth || !el.clientHeight) return
    // Pins rise ~40px above their point, so leave more room at the top.
    map.current.fitBounds(pts.current, compact
      ? { paddingTopLeft: [24, 48], paddingBottomRight: [24, 26], maxZoom: 15 }
      : { paddingTopLeft: [50, 70], paddingBottomRight: [50, 34], maxZoom: 15 })
  }

  return <div ref={box} className={`city-map ${compact ? 'compact' : ''}`} style={{ height }} role="region" aria-label="Map of nearby businesses" />
}
