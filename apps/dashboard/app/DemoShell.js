'use client'
import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { demoApi, clearDemoSession, timeLeft, ownerBusinessId, switchOwner } from '../lib/demo'
import TracePanel from '../lib/TracePanel'
import BusinessFilter from '../lib/BusinessFilter'
import { ICON } from '../lib/kinds'
import McpConnect from '../lib/McpConnect'
import { CustomerLogin } from '../lib/CustomerLogin'
import Tour, { restartTour } from '../lib/Tour'

// Wraps the app while a demo session is active: top bar (addresses, time left,
// Customer/Business switch, End session) + side panel (inbox, Under the hood,
// guide). Customer side = /demo/client, Business side = the owner dashboard.
export default function DemoShell({ children }) {
  const pathname = usePathname()
  // middleware.js only lets these paths through with a demo session, so the
  // frame can be there on the first paint (no flash of a page without its top bar).
  const inShell = pathname.startsWith('/demo') || pathname.startsWith('/dashboard')
  // Always the same tree, frame or not: if the frame appeared around the page
  // (it does a moment after load), the page would remount and lose work in
  // progress, like the "Payment received" message after coming back from PayPal.
  return <Shell on={inShell} pathname={pathname}>{children}</Shell>
}

// The session's businesses, fetched once per page (the panel and the top bar share it).
function useBusinesses(on) {
  const [list, setList] = useState(null)
  useEffect(() => { if (on) demoApi('/businesses').then(d => setList(d?.businesses || [])) }, [on])
  return list
}

// Which business the Business side shows. Every shop in the demo city can be run
//; switching reloads the page under the new business.
const ADD = '__add'
function BusinessSwitcher({ session }) {
  const [list, setList] = useState(null)
  const [canAdd, setCanAdd] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { demoApi('/businesses').then(d => { setList(d?.businesses || []); setCanAdd(!!d?.add && d.add.added < d.add.max) }) }, [])
  const current = ownerBusinessId() || session.businessId
  if (!list || list.length < 2) return <span className="demo-chip"><b>{session.businessName}</b> <span>owner</span></span>
  async function pick(id) {
    if (id === ADD) { window.location.href = '/dashboard/add'; return }
    if (id === current) return
    setBusy(true)
    const r = await switchOwner(id)
    if (r?.error) { setBusy(false); window.alert(r.error); return }
    window.location.reload()
  }
  return (
    <label className="demo-chip demo-biz-pick" title="You're the owner. Switch which business you run, or add one.">
      <span className="demo-biz-icon" aria-hidden="true">🏪</span>
      <select value={current} onChange={e => pick(e.target.value)} disabled={busy} aria-label="Business you run">
        {list.map(b => <option key={b.businessId} value={b.businessId}>{b.name}{b.own ? ' (yours)' : b.added && !b.setupDone ? ' (not set up)' : ''}</option>)}
        {canAdd && <option value={ADD}>+ Add a business…</option>}
      </select>
    </label>
  )
}

function Shell({ on, pathname, children }) {
  const router = useRouter()
  const mode = pathname.startsWith('/dashboard') ? 'business' : 'customer'
  // Switching sides: the clicked side lights up at once and a slim bar shows
  // while its page opens (the Business side loads the tables library).
  const [switching, startSwitch] = useTransition()
  const [target, setTarget] = useState(null)
  const switchTo = (side, href) => { if (side === mode) return; setTarget(side); startSwitch(() => router.push(href)) }
  const shown = switching && target ? target : mode
  // Load the other side's code in the background, so the first switch is instant.
  useEffect(() => {
    if (!on) return
    const other = mode === 'customer' ? ['/dashboard', '/dashboard/calendar', '/dashboard/bookings'] : ['/demo/client']
    const t = setTimeout(() => {
      other.forEach(href => router.prefetch(href))
      // Page prefetch doesn't fetch the tables library (AG Grid, ~290 KB), the
      // big part of the Business side: load it while the browser is idle.
      if (mode === 'customer') {
        const load = () => import('../lib/Grid').catch(() => {})
        if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 4000 })
        else load()
      }
    }, 2500)
    return () => clearTimeout(t)
  }, [on, mode, router])
  const [session, setSession] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [tab, setTab] = useState('inbox')
  const [panelOpen, setPanelOpen] = useState(false)
  const [ending, setEnding] = useState(false)

  // The panel opens by default only when it fits beside the page (on smaller
  // screens it would cover it); after that, the visitor's choice is remembered.
  useEffect(() => {
    const saved = localStorage.getItem('bp_panel')
    setPanelOpen(saved ? saved === 'open' : window.innerWidth >= 1100)
  }, [])
  function togglePanel() {
    setPanelOpen(o => { try { localStorage.setItem('bp_panel', o ? 'closed' : 'open') } catch {} return !o })
  }

  const loadSession = useCallback(() => demoApi('/session').then(s => s && !s.error && setSession(s)), [])
  const businesses = useBusinesses(on)
  const currentBiz = (typeof window !== 'undefined' && ownerBusinessId()) || session?.businessId || null
  useEffect(() => {
    if (!on) return
    loadSession()
    const t = setInterval(() => setNow(Date.now()), 30_000)
    // Setup steps change what the session says (salon set up, documents learned).
    const onTour = e => { if (String(e.detail).startsWith('setup-')) loadSession() }
    window.addEventListener('bp-tour', onTour)
    return () => { clearInterval(t); window.removeEventListener('bp-tour', onTour) }
  }, [loadSession, on])

  // The tour opens the panel on the tab a step explains.
  const openPanel = useCallback(t => { setPanelOpen(true); setTab(t) }, [])
  const guided = session?.mode === 'guided'
  const implied = guided ? [
    ...(session.setupDone ? ['setup-generated', 'setup-applied'] : []),
    ...(session.knowledge?.docs?.length ? ['setup-learned'] : []),
    // Logged in with PayPal: the login step is done (there's no skipping it).
    ...(session.paypalLogin ? ['customer-who'] : [])
  ] : []

  async function endSession() {
    if (!window.confirm('End your session? This deletes your bookings, inbox and timeline.')) return
    setEnding(true)
    await demoApi('/session', { method: 'DELETE' })
    clearDemoSession()
    window.location.href = '/?ended=1'
  }

  const msLeft = session ? session.expiresAt - now : null

  return (
    <div className={on ? 'demo-root' : 'demo-off'}>
      {on && <header className="demo-top">
        <div className="demo-brand">Flow <span className="demo-pill">demo</span></div>
        <div className="demo-switch" role="tablist" aria-label="Side">
          <button className={shown === 'customer' ? 'on' : ''} onClick={() => switchTo('customer', '/demo/client')}>Customer</button>
          <button className={shown === 'business' ? 'on' : ''} onClick={() => switchTo('business', '/dashboard')}>Business</button>
        </div>
        {switching && <div className="demo-switching" aria-hidden="true" />}
        <div className="demo-who">
          {!session && <span className="skel skel-chip" aria-hidden="true" />}
          {session && (mode === 'customer'
            ? <span className="demo-chip"><b>{session.customerName}</b> <span>customer</span></span>
            : <BusinessSwitcher session={session} />)}
        </div>
        <div className="demo-time">{msLeft != null ? <>Ends in <b>{timeLeft(msLeft)}</b></> : ''}</div>
        <button className={`btn-sm btn-secondary demo-panel-toggle ${panelOpen ? 'on' : ''}`} onClick={togglePanel} aria-pressed={panelOpen}>{panelOpen ? 'Hide panel' : 'Inbox & timeline'}</button>
        <button className="btn-sm btn-danger demo-end" onClick={endSession} disabled={ending}>{ending ? 'Ending…' : 'End session'}</button>
      </header>}

      <div className={on ? 'demo-body' : 'demo-off'}>
        <div className={on ? 'demo-main' : 'demo-off'}>{children}</div>
        {on && panelOpen && <div className="demo-side-backdrop" onClick={togglePanel} aria-hidden="true" />}
        {on && panelOpen && (
          <aside className="demo-side">
            <div className="demo-tabs">
              {[['inbox', 'Inbox'], ['trace', 'Under the hood'], ['guide', 'Guide']].map(([k, l]) => (
                <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            <div className="demo-tab-body">
              {/* Kept mounted so polling and unread state survive tab switches. */}
              <div style={{ display: tab === 'inbox' ? 'block' : 'none', height: '100%' }}><Inbox mode={mode} businesses={businesses} current={currentBiz} /></div>
              <div style={{ display: tab === 'trace' ? 'block' : 'none' }}><TracePanel scoped={mode === 'business'} businesses={businesses} current={currentBiz} /></div>
              {tab === 'guide' && <Guide session={session} mode={mode} />}
            </div>
          </aside>
        )}
      </div>
      {on && guided && <Tour sid={session.sid} implied={implied} openPanel={openPanel} />}
    </div>
  )
}

// ── Web inbox: every message Flow sends this session, split by role ─────────
function Inbox({ mode, businesses, current }) {
  const [messages, setMessages] = useState([])
  const [role, setRole] = useState(mode === 'business' ? 'owner' : 'customer')
  // The owner inbox shows the business you're running; switch to another or all.
  const [biz, setBiz] = useState(current || 'all')
  useEffect(() => { if (current) setBiz(current) }, [current])
  const nameOf = id => (businesses || []).find(b => b.businessId === id)?.name
  const forBiz = m => m.role !== 'owner' || biz === 'all' || m.businessId === biz || (!m.businessId && m.to === `${nameOf(biz)} (owner)`)
  const [open, setOpen] = useState(null)
  const cursor = useRef(null)

  useEffect(() => { setRole(mode === 'business' ? 'owner' : 'customer'); setOpen(null) }, [mode])

  useEffect(() => {
    let stop = false
    async function poll() {
      const d = await demoApi(`/inbox${cursor.current ? `?since=${encodeURIComponent(cursor.current)}` : ''}`)
      if (!stop && d?.messages) {
        if (d.messages.length) setMessages(prev => [...prev, ...d.messages])
        cursor.current = d.cursor || cursor.current
      }
      if (!stop) setTimeout(poll, 3000)
    }
    poll()
    return () => { stop = true }
  }, [])

  const openMessage = useCallback(m => {
    setOpen(m)
    if (!m.read) {
      setMessages(prev => prev.map(x => x.sk === m.sk ? { ...x, read: true } : x))
      demoApi('/inbox/read', { method: 'POST', body: { sks: [m.sk] } })
    }
  }, [])

  const unread = r => messages.filter(m => m.role === r && !m.read && forBiz(m)).length
  const mine = messages.filter(m => m.role === role && forBiz(m)).slice().reverse()

  if (open) {
    return (
      <div className="inbox-view">
        <button className="btn-sm btn-secondary" onClick={() => setOpen(null)}>← Back</button>
        <h3>{open.subject}</h3>
        <div className="inbox-meta">From {open.from} · to {open.to}<br />{new Date(open.ts).toLocaleString('en-US')}</div>
        {open.html
          ? <iframe title="message" sandbox="" srcDoc={open.html} className="inbox-frame" />
          : <pre className="inbox-text">{open.text}</pre>}
        {/* One button a message can carry, e.g. "Review and approve $40" (core/approvals). */}
        {open.action?.url && <div className="inbox-action"><a className="btn-link btn-sm" href={open.action.url} target="_blank" rel="noreferrer">{open.action.label}</a></div>}
        {open.attachments?.length > 0 && (
          <div className="inbox-atts">
            {open.attachments.map((a, i) => <Attachment key={i} a={a} />)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="inbox-roles">
        <button className={role === 'customer' ? 'on' : ''} onClick={() => setRole('customer')}>Customer {unread('customer') ? <span className="dot">{unread('customer')}</span> : null}</button>
        <button className={role === 'owner' ? 'on' : ''} onClick={() => setRole('owner')}>Owner {unread('owner') ? <span className="dot">{unread('owner')}</span> : null}</button>
      </div>
      {role === 'owner' && <BusinessFilter list={businesses} value={biz} onChange={setBiz} />}
      {mine.length === 0 && <p className="muted small">{role === 'owner' && biz !== 'all' ? `No messages for ${nameOf(biz) || 'this business'} yet.` : 'No messages yet.'}</p>}
      {mine.map(m => (
        <button key={m.sk} className={`inbox-row ${m.read ? '' : 'unread'}`} onClick={() => openMessage(m)}>
          <div className="inbox-row-top"><span>{m.role === 'owner' && biz === 'all' && m.to ? m.to.replace(/ \(owner\)$/, '') : m.from}</span><span>{new Date(m.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span></div>
          <div className="inbox-subject">{!m.read && <span className="new">NEW</span>} {m.subject}{m.attachments?.length ? <span className="inbox-clip" title="Has an attachment"> 📎</span> : null}</div>
          <div className="inbox-snippet">{(m.text || '').slice(0, 90)}</div>
        </button>
      ))}
    </div>
  )
}

// A message attachment (the receipt PDF). The API serves it at signed links
// (valid an hour), so these are plain links: no pop-up or blob URL for a
// browser to block. "Show here" previews it inside the message.
function Attachment({ a }) {
  const [preview, setPreview] = useState(false)
  const isPdf = (a.contentType || '').includes('pdf')
  return (
    <div>
      <div className="inbox-att">
        <span className="inbox-att-icon">{isPdf ? 'PDF' : 'FILE'}</span>
        <span className="inbox-att-name">{a.filename}</span>
        {isPdf && <button className="btn-sm btn-secondary" onClick={() => setPreview(p => !p)}>{preview ? 'Hide' : 'Show here'}</button>}
        <a className="btn-sm btn-secondary" href={a.url} target="_blank" rel="noreferrer">Open</a>
        <a className="btn-sm btn-secondary" href={a.downloadUrl} download={a.filename}>Download</a>
      </div>
      {preview && <iframe title={a.filename} src={a.url} className="inbox-pdf" />}
    </div>
  )
}

// ── Guide: login info + "Try this" checklist ───────────────────────────────────
// What to try, per side. The side you're on comes first.
const STEPS = {
  customer: [
    ['c-login', 'Log in with PayPal (Customer login below): your own sandbox account, or the demo\'s buyer. The customer takes that name.'],
    ['c-book', 'Say "Book me a haircut". Flow suggests your usual (Willow & Co. with Ana). Or try "a massage near me" or "a beard trim" for the spa and the barber.'],
    ['c-pay', 'Pay with PayPal. The first payment also saves PayPal, so the next booking pays in one step after you say yes. The receipt and PayPal invoice land in your inbox.'],
    ['c-change', 'Ask to move it to another time or stylist, or to cancel it. The refund follows the business\'s policy.'],
    ['c-ask', 'Ask for money back without cancelling ("I waited 30 minutes, can I get $10 back?"). The business decides.'],
    ['c-member', 'Join Willow Monthly. Covered haircuts then cost nothing.'],
    ['c-channels', 'Book the same way by voice (Voice assistant) or from your own AI with the customer link below. Then take it with you: Telegram and Alexa, under On your phone.']
  ],
  business: [
    ['b-calendar', 'Find the customer\'s booking on the Calendar. Drag it to move it; the customer is told.'],
    ['b-switch', 'Pick another business from the menu at the top. Every shop in the demo city has its own owner side.'],
    ['b-money', 'On Bookings: refund part of a payment, cancel with a refund, or answer a refund request.'],
    ['b-add', '"+ Add a business" in that menu: pin it near the customer\'s demo home, set it up with AI, then book it as the customer.'],
    ['b-hood', 'Open Under the hood to watch every AI step, seat hold, PayPal payment and refund.']
  ]
}
const SIDE = { customer: 'As the customer', business: 'As the owner' }

function Guide({ session, mode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [done, setDone] = useState({})
  const [biz, setBiz] = useState(null)   // { list, current }
  // The full "Connect your own AI" page for a role: the customer's menu item, or the
  // owner's AI & channels.
  function openConnectPage(role) {
    if (role === 'business') return router.push('/dashboard/ai')
    if (pathname === '/demo/client') window.dispatchEvent(new CustomEvent('bp-view', { detail: 'mcp' }))
    else router.push('/demo/client?view=mcp')
  }
  useEffect(() => { try { setDone(JSON.parse(localStorage.getItem('bp_steps') || '{}')) } catch {} }, [])
  useEffect(() => {
    demoApi('/businesses').then(d => {
      const list = d?.businesses || []
      const id = ownerBusinessId() || session?.businessId
      setBiz({ list, add: d?.add || null, current: list.find(b => b.businessId === id) || list.find(b => b.own) || null })
    })
  }, [session?.businessId])
  // Run a business as its owner: switch the Business side to it.
  async function runBusiness(b) {
    if (biz?.current?.businessId !== b.businessId) {
      const r = await switchOwner(b.businessId)
      if (r?.error) { window.alert(r.error); return }
    }
    window.location.href = '/dashboard'
  }
  // Book it as the customer: the request goes in the chat box, ready to send.
  function bookAt(b) {
    const text = `Book me at ${b.name}`
    if (pathname === '/demo/client') window.dispatchEvent(new CustomEvent('bp-ask', { detail: text }))
    else router.push(`/demo/client?ask=${encodeURIComponent(text)}`)
  }
  function toggle(k) {
    const next = { ...done, [k]: !done[k] }
    setDone(next)
    try { localStorage.setItem('bp_steps', JSON.stringify(next)) } catch {}
  }
  const sides = mode === 'business' ? ['business', 'customer'] : ['customer', 'business']
  const running = biz?.current?.name || session?.businessName
  const added = (biz?.list || []).filter(b => b.added).length

  return (
    <div className="guide">
      {session?.mode === 'guided' && (
        <div className="guide-tour">
          <div>
            <b>Guided tour</b>
            <div className="muted small">Set up the salon with AI, book it as the customer, see it as the owner.</div>
          </div>
          <button type="button" className="btn-sm" onClick={() => restartTour(session.sid)}>Restart tour</button>
        </div>
      )}

      <h3>Try this</h3>
      {sides.map(side => (
        <div key={side} className="guide-group">
          <div className="guide-group-title">{SIDE[side]}{side === mode && <span className="guide-here">you&apos;re here</span>}</div>
          {STEPS[side].map(([k, label]) => (
            <label key={k} className="guide-step">
              <input type="checkbox" checked={!!done[k]} onChange={() => toggle(k)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      ))}

      <h3>The businesses</h3>
      <p className="guide-note">Every shop in the demo city takes real bookings and PayPal payments. Run any of them as the owner, or book it as the customer.</p>
      <div className="guide-biz">
        {(biz?.list || []).map(b => (
          <div key={b.businessId} className={`guide-biz-row ${biz.current?.businessId === b.businessId ? 'on' : ''}`}>
            <span className="guide-biz-icon" aria-hidden="true">{ICON[b.category] || '📍'}</span>
            <div className="guide-biz-name">
              <b>{b.name}</b>
              <span>{b.own ? 'yours' : b.added ? (b.setupDone ? 'added by you' : 'added by you · not set up') : (b.neighborhood || 'demo city')}{biz.current?.businessId === b.businessId ? ' · running' : ''}</span>
            </div>
            <div className="guide-biz-acts">
              <button type="button" className="btn-sm btn-secondary" onClick={() => runBusiness(b)} disabled={mode === 'business' && biz.current?.businessId === b.businessId}>Run it</button>
              {b.setupDone && <button type="button" className="btn-sm btn-secondary" onClick={() => bookAt(b)}>Book here</button>}
            </div>
          </div>
        ))}
      </div>
      {biz?.add && biz.add.added < biz.add.max && <button type="button" className="link-btn guide-add" onClick={() => router.push('/dashboard/add')}>+ Add your own business nearby</button>}

      {/* The panel is the judge's toolbox, so it carries both links on either
          side; each page itself only shows its own. */}
      <h3>Connect your own AI (MCP)</h3>
      <p className="guide-note">The <b>customer link</b> books across every business in the city. The <b>owner link</b> runs the business you have picked in the top menu{running ? <> (now <b>{running}</b>)</> : null}: pick another business to get its link.</p>
      <div className="guide-mcp">
        <McpConnect focus="customer" compact onOpenFull={() => openConnectPage('customer')} />
        <McpConnect key={biz?.current?.businessId || 'own'} focus="business" compact onOpenFull={() => openConnectPage('business')} />
      </div>

      <h3>Customer login (PayPal sandbox, fake money)</h3>
      <CustomerLogin session={session} />

      <h3>Your session</h3>
      {session && (
        <ul className="guide-list">
          <li>You&apos;re <b>{session.paypalLogin?.name || session.customerName || 'John Doe'}</b> on the customer side{session.paypalLogin ? ' (logged in with PayPal)' : ''}, and the owner on the business side. Switch with Customer / Business at the top.</li>
          <li>{biz ? <>{biz.list.length} businesses in the demo city{added ? <> ({added} added by you)</> : null}.</> : 'The businesses in the demo city.'} You&apos;re running <b>{running}</b>; change it from the menu at the top.</li>
          <li>Your customer home is a made-up address in Austin. Your real location is never asked for or used.</li>
          <li>Every message goes to the two inboxes in this panel (the customer&apos;s and the owner&apos;s). Nothing leaves the demo.</li>
          <li>Ends {new Date(session.expiresAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, or when you click End session. Everything is deleted then.</li>
        </ul>
      )}
    </div>
  )
}
