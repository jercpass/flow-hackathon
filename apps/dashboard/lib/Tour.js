'use client'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { TOUR, WHO, PENDING_KEY, FINALE, setPhoneLock } from './tourSteps'

// Guided demo coach marks: a card anchored to the element it explains, a soft
// spotlight on that element (clicks still go through), Next / Back, and a
// "Resume tour" pill when it's put away. Progress is kept per session in
// localStorage. Pages report what the judge did with tourEvent(); a step that
// waits for something moves on by itself when it happens.

const KEY = 'bp_tour'
const fresh = sid => ({ sid, step: 0, done: false, hidden: false, seen: [] })

function load(sid) {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (s && s.sid === sid) return { ...fresh(sid), ...s }
  } catch {}
  return fresh(sid)
}
function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch {}
}

/** Start the tour again from step 1 (the Guide tab's button). */
export function restartTour(sid) {
  save(fresh(sid))
  window.dispatchEvent(new Event('bp-tour-restart'))
}

// Moving forward skips steps whose action already happened (e.g. the judge
// generated the draft before the tour asked).
function forwardFrom(i, seen) {
  let n = i
  while (n < TOUR.length - 1 && TOUR[n].waitFor && seen.includes(TOUR[n].waitFor)) n++
  return n
}

export default function Tour({ sid, implied = [], openPanel }) {
  const router = useRouter()
  const pathname = usePathname()
  const [state, setState] = useState(null)
  const [rect, setRect] = useState(null)
  const [size, setSize] = useState({ w: 1280, h: 800, card: 220 })
  const cardRef = useRef(null)

  const update = useCallback(fn => setState(s => { if (!s) return s; const n = fn(s); save(n); return n }), [])

  const impliedRef = useRef(implied)
  impliedRef.current = implied
  useEffect(() => {
    setState(load(sid))
    const again = () => { const s = { ...load(sid), seen: [...impliedRef.current] }; save(s); setState(s) }
    window.addEventListener('bp-tour-restart', again)
    return () => window.removeEventListener('bp-tour-restart', again)
  }, [sid])

  // What the session already shows as done counts as seen (e.g. after a restart).
  const impliedKey = implied.join(',')
  useEffect(() => {
    if (!impliedKey) return
    update(s => ({ ...s, seen: [...new Set([...s.seen, ...impliedKey.split(',')])] }))
  }, [impliedKey, update])

  // Apply queued events (see tourEvent), then listen for new ones.
  useEffect(() => {
    if (!state) return
    const drain = () => {
      let q = []
      try { q = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); localStorage.removeItem(PENDING_KEY) } catch {}
      for (const name of q) {
        update(s => {
          const seen = s.seen.includes(name) ? s.seen : [...s.seen, name]
          const cur = TOUR[s.step]
          if (!s.done && cur?.waitFor === name) return { ...s, seen, hidden: false, step: forwardFrom(Math.min(s.step + 1, TOUR.length - 1), seen) }
          return { ...s, seen }
        })
      }
    }
    drain()
    window.addEventListener('bp-tour', drain)
    return () => window.removeEventListener('bp-tour', drain)
  }, [!!state, update])   // eslint-disable-line react-hooks/exhaustive-deps

  const active = state && !state.done && !state.hidden
  // The phone apps unlock when the tour is finished or put away (see setPhoneLock).
  useEffect(() => { if (state) setPhoneLock(!state.done && !state.hidden) }, [state?.done, state?.hidden, !!state])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setPhoneLock(false), [])
  const index = state?.step || 0
  const step = active ? TOUR[index] : null

  // Entering a step: show its page, customer view and panel. Only on step
  // change, so the judge can still wander off and come back.
  const pushed = useRef(null)     // the page the tour last navigated to
  const go = useCallback(s => {
    if (!s) return
    if (s.route && window.location.pathname !== s.route) { pushed.current = s.route; router.push(s.view ? `${s.route}?view=${s.view}` : s.route) }
    else if (s.view) window.dispatchEvent(new CustomEvent('bp-view', { detail: s.view }))
    if (s.panel) openPanel?.(s.panel)
  }, [router, openPanel])
  // A page load (reload, a typed URL, back from PayPal) stays where it is: the
  // card offers "Take me to this step" instead of pulling the judge away.
  const booted = useRef(false)
  useEffect(() => {
    if (!state) return
    if (!booted.current) {
      booted.current = true
      if (step && (!step.route || window.location.pathname === step.route)) go(step)
      return
    }
    go(step)
  }, [step?.id, !!state])   // eslint-disable-line react-hooks/exhaustive-deps
  // A slow navigation from an earlier step can land after the judge has moved
  // on: if the tour's own navigation lands on the wrong page, go again.
  useEffect(() => {
    if (!pushed.current || pathname !== pushed.current) return
    pushed.current = null
    if (step?.route && step.route !== pathname) go(step)
  }, [pathname])   // eslint-disable-line react-hooks/exhaustive-deps

  // A new step is measured before the browser paints, so its card never shows
  // at the previous step's place first; until its anchor is found the card stays
  // invisible (ready = false) instead of flashing in the middle of the screen.
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    setReady(false)
    if (!step) return
    setSize(sz => ({ ...sz, w: window.innerWidth, h: window.innerHeight }))
    if (!step.anchor) { setRect(null); setReady(true); return }
    const r = anchorRect(step.anchor)
    setRect(r)
    if (r) setReady(true)
  }, [step?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the anchor every frame (smooth while the page scrolls), scroll it into
  // view once if it isn't fully visible, and only let go of it after it has been
  // gone for a moment (a re-render can drop it for a frame or two).
  useEffect(() => {
    if (!step?.anchor) return
    let raf = 0
    let scrolled = 0
    let retried = false
    let lastSeen = performance.now()
    const since = performance.now()
    let current = null
    const tick = () => {
      // The anchor changed (the script card, then the "Yes, pay" button once the
      // reply arrives): bring the new one into view too.
      const el = findAnchor(step.anchor)
      if (el && el !== current) { current = el; scrolled = 0; retried = false }
      const r = anchorRect(step.anchor)
      if (r) {
        lastSeen = performance.now()
        const block = r.height < window.innerHeight * 0.7 ? 'center' : 'start'
        const inView = r.top >= 0 && r.top < window.innerHeight - 40
        if (!scrolled) {
          scrolled = performance.now()
          const fullyVisible = r.top >= 64 && r.top + r.height <= window.innerHeight - 8
          // In the window but maybe cut off inside a scrolling box (the chat):
          // "nearest" scrolls that box only if needed, and the page not at all.
          findAnchor(step.anchor)?.scrollIntoView?.({ block: fullyVisible ? 'nearest' : block, behavior: 'smooth' })
        } else if (!retried && performance.now() - scrolled > 1000) {
          // A smooth scroll can be cut short: if the anchor still isn't on screen, jump once.
          retried = true
          if (!inView) findAnchor(step.anchor)?.scrollIntoView?.({ block, behavior: 'auto' })
        }
        setRect(prev => (sameRect(prev, r) ? prev : r))
        setReady(true)
      } else {
        const now = performance.now()
        if (now - lastSeen > 400) setRect(prev => (prev ? null : prev))
        // Not on this page: show the card (with "Take me to this step") after a
        // moment, or after up to 3 s while the tour itself is moving to the page.
        const moving = pushed.current && pushed.current !== window.location.pathname
        if (now - since > (moving ? 3000 : 700)) setReady(true)
      }
    }
    // Every frame for smooth following; a slower timer too, for browsers that
    // throttle animation frames (background tabs, some screen recorders).
    const loop = () => { tick(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    const backup = setInterval(tick, 200)
    const onResize = () => setSize(sz => ({ ...sz, w: window.innerWidth, h: window.innerHeight }))
    window.addEventListener('resize', onResize)
    return () => { cancelAnimationFrame(raf); clearInterval(backup); window.removeEventListener('resize', onResize) }
  }, [step?.id, step?.anchor, pathname])

  // The card's own height decides above/below; watch it rather than guess.
  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setSize(sz => (Math.abs(sz.card - el.offsetHeight) < 2 ? sz : { ...sz, card: el.offsetHeight })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [active, step?.id])

  if (!state || state.done) return null

  if (state.hidden) {
    return (
      // Resuming also brings the chat's script back (app/demo/client listens).
      <button type="button" className="tour-pill" onClick={() => { update(s => ({ ...s, hidden: false })); window.dispatchEvent(new Event('bp-resume')) }}>
        Guided tour · {index + 1} of {TOUR.length} · <b>Resume</b>
      </button>
    )
  }

  const next = () => update(s => (s.step >= TOUR.length - 1 ? { ...s, done: true } : { ...s, step: forwardFrom(s.step + 1, s.seen) }))
  const back = () => update(s => ({ ...s, step: Math.max(0, s.step - 1) }))
  const hide = () => update(s => ({ ...s, hidden: true }))
  const waiting = step.waitFor && !state.seen.includes(step.waitFor)
  const elsewhere = ready && step.route && pathname !== step.route && !rect

  // The closing screen: the phone apps, big. A tile ends the tour and opens its page.
  if (step.finale) {
    const open = view => {
      update(s => ({ ...s, done: true }))
      if (pathname === '/demo/client') window.dispatchEvent(new CustomEvent('bp-view', { detail: view }))
      else router.push(`/demo/client?view=${view}`)
    }
    return (
      <>
        <div className="tour-dim tour-dim-strong" aria-hidden="true" />
        <div className="tour-finale" role="dialog" aria-label={step.title}>
          <div className="tour-top">
            <span className="tour-act">{step.act}</span>
            <span className="tour-count">{index + 1} of {TOUR.length}</span>
            <button type="button" className="tour-x" onClick={hide} aria-label="Put the tour away" title="Put the tour away (resume any time)">×</button>
          </div>
          <h2>{step.title}</h2>
          <p className="tour-finale-lead">{step.body}</p>
          <div className="tour-finale-tiles">
            {FINALE.map(t => (
              <button key={t.view} type="button" className={`tour-tile tile-${t.brand}`} onClick={() => open(t.view)}>
                <span className="tour-tile-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22">{TILE_ICONS[t.brand]}</svg></span>
                <span className="tour-tile-name">{t.name}</span>
                <span className="tour-tile-tag">{t.tag}</span>
                <span className="tour-tile-body">{t.body}</span>
                <span className="tour-tile-cta">{t.cta} →</span>
              </button>
            ))}
          </div>
          <div className="tour-foot">
            <span className="muted small">No phone handy? The <button type="button" className="link-btn" onClick={() => open('voice')}>voice assistant</button> works right here.</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn-secondary btn-sm" onClick={back}>Back</button>
            <button type="button" className="btn-sm" onClick={next}>{step.next || 'Finish'}</button>
          </div>
        </div>
      </>
    )
  }

  const pos = place(rect, size)
  return (
    <>
      {rect && <div className="tour-spot" aria-hidden="true" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />}
      {!step.anchor && <div className="tour-dim" aria-hidden="true" />}
      <div ref={cardRef} className={`tour-card ${pos.mode}${ready ? '' : ' tour-wait-pos'}`} style={pos.style} role="dialog" aria-live="polite" aria-label={step.title}>
        <div className="tour-top">
          <span className="tour-act">{step.act}</span>
          <span className="tour-count">{index + 1} of {TOUR.length}</span>
          <button type="button" className="tour-x" onClick={hide} aria-label="Put the tour away" title="Put the tour away (resume any time)">×</button>
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-meta">
          <span className={`tour-who who-${step.who}`}>{WHO[step.who]}</span>
          {waiting && <span className="tour-wait">Your turn: do this to go on</span>}
        </div>
        {elsewhere && <button type="button" className="link-btn tour-there" onClick={() => go(step)}>Take me to this step →</button>}
        <div className="tour-foot">
          <button type="button" className="btn-ghost btn-sm" onClick={hide}>Explore on my own</button>
          <span style={{ flex: 1 }} />
          {index > 0 && <button type="button" className="btn-secondary btn-sm" onClick={back}>Back</button>}
          <button type="button" className="btn-sm" onClick={next} disabled={waiting}
            title={waiting ? 'Do this step first: the next ones show what it makes' : undefined}>{step.next || 'Next'}</button>
        </div>
        <div className="tour-progress" aria-hidden="true"><span style={{ width: `${((index + 1) / TOUR.length) * 100}%` }} /></div>
      </div>
    </>
  )
}

// The finale tiles' marks: a paper plane (Telegram), a ring (Alexa), a sparkle (your AI).
const TILE_ICONS = {
  tg: <path fill="#fff" d="M20.7 3.3 2.9 10.2c-.9.4-.9 1.6 0 1.9l4.4 1.4 1.7 5.3c.3.8 1.3 1 1.9.4l2.5-2.5 4.5 3.3c.7.5 1.7.1 1.9-.8l2.8-14.3c.2-1-.8-1.9-1.9-1.6ZM9.6 14l8-6.6-6.3 7.9-.3 2.6-1.4-3.9Z" />,
  alexa: <circle cx="12" cy="12" r="7.5" fill="none" stroke="#fff" strokeWidth="3" />,
  ai: <path fill="#fff" d="M12 2.5l2.1 6.4 6.4 2.1-6.4 2.1L12 19.5l-2.1-6.4L3.5 11l6.4-2.1Z" />
}

// A step's anchor: one selector, or a list tried in order (the first selector
// with a sized element on the page wins), e.g. the PayPal button if it's there,
// else the script. Within a selector the NEWEST element wins: an older unpaid
// PayPal link higher up the chat once took the highlight from "Yes, pay $40".
function findAnchor(anchor) {
  for (const sel of [].concat(anchor)) {
    const els = document.querySelectorAll(sel)
    for (let i = els.length - 1; i >= 0; i--) {
      const r = els[i].getBoundingClientRect()
      if (r.width || r.height) return els[i]
    }
  }
  return null
}

// The anchor's box in the viewport, or null when it isn't on the page (or has no size).
function anchorRect(anchor) {
  const r = findAnchor(anchor)?.getBoundingClientRect()
  return r && (r.width || r.height) ? { top: r.top, left: r.left, width: r.width, height: r.height } : null
}
function sameRect(a, b) {
  return !!a && !!b && Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
}

// Beside the anchor where there's room (right, left, below, above), otherwise
// docked bottom-right; centred when there's no anchor; full width on phones.
function place(rect, { w, h, card }) {
  const W = Math.min(340, w - 24)
  const gap = 14
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))
  // Narrow screens: full width, docked on the side away from the anchor so it never covers it.
  if (w < 720) return rect && rect.top + rect.height / 2 > h / 2
    ? { mode: 'docked', style: { left: 12, right: 12, top: 12 } }
    : { mode: 'docked', style: { left: 12, right: 12, bottom: 12 } }
  if (!rect) return { mode: 'centre', style: { width: W, left: (w - W) / 2, top: clamp(h * 0.28, 70, h - card - 20) } }
  const right = w - (rect.left + rect.width)
  const below = h - (rect.top + rect.height)
  const top = clamp(rect.top, 66, h - card - 12)
  if (right >= W + gap + 12) return { mode: 'side', style: { width: W, left: rect.left + rect.width + gap, top } }
  if (rect.left >= W + gap + 12) return { mode: 'side', style: { width: W, left: rect.left - W - gap, top } }
  const left = clamp(rect.left, 12, w - W - 12)
  if (below >= card + gap + 12) return { mode: 'below', style: { width: W, left, top: rect.top + rect.height + gap } }
  if (rect.top >= card + gap + 66) return { mode: 'above', style: { width: W, left, top: rect.top - card - gap } }
  return { mode: 'docked', style: { width: W, right: 16, bottom: 16 } }
}
