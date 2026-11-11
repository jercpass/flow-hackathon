'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { demoApi, publicApi } from '../../../lib/demo'
import { tourEvent, phoneLocked, PHONE_LOCK_EVENT } from '../../../lib/tourSteps'
import ScriptCard from './ScriptCard'
import TelegramConnect from './TelegramConnect'
import AlexaConnect from './AlexaConnect'
import { formatMoney } from '../../../lib/money'
import { startRecorder, audioToAttachment, fileToAttachment, MAX_VOICE_SECONDS, FILE_ACCEPT } from '../../../lib/media'
import NearYou from './NearYou'
import VoiceDevice from './VoiceDevice'
import { BookingCard, ConnectAI, Memberships, MyBookings, NearYouPage, Payments, Profile } from './AccountViews'
import { BuyerLogin, PayPalLoginButton } from '../../../lib/CustomerLogin'
import { loadFraudNet } from '../../../lib/fraudnet'

// Customer side of the demo: the customer's own menu, like the owner's on the business
// side. The channels (real AI + real booking tools, pay with PayPal) come in two
// groups: "Try it here" needs nothing installed (where the tour runs); "On your
// phone" is the same assistant in real apps. "Your account" = bookings, places,
// payments, profile.

const NAV = [
  { title: 'Try it here', items: [
    { id: 'web', label: 'Web chat', sub: 'Live' },
    { id: 'voice', label: 'Voice assistant', sub: 'Talk' },
    { id: 'mcp', label: 'Your own AI', sub: 'MCP' }
  ]},
  { title: 'On your phone', items: [
    { id: 'telegram', label: 'Telegram', sub: 'App', phone: true },
    { id: 'alexa', label: 'Alexa', sub: 'Echo', phone: true }
  ]},
  { title: 'Your account', items: [
    { id: 'bookings', label: 'My bookings' },
    { id: 'memberships', label: 'Memberships & packs' },
    { id: 'near', label: 'Near you' },
    { id: 'payments', label: 'Payments & refunds' },
    { id: 'profile', label: 'Profile' }
  ]}
]
const CHAT_VIEWS = ['web', 'voice', 'mcp']

const STATUS_TEXT = {
  confirmed: r => `Payment received${r.amount != null ? ` (${formatMoney(r.amount)})` : ''}. Your ${r.serviceName || 'booking'} is confirmed${r.when ? ` for ${r.when}` : ''}. The confirmation is in your inbox.`,
  slot_taken: r => `That ${r.serviceName || ''} slot was taken while you were paying. You were NOT charged. Want another time?`,
  refunded: r => `We couldn't complete the booking, so your ${r.amount != null ? formatMoney(r.amount) : ''} payment was refunded in full.`,
  cancelled: () => 'Payment cancelled. No charge was made. The link still works for a few minutes if you change your mind.',
  pending: () => 'PayPal is still processing your payment. You\'ll get a message in your inbox as soon as it clears.',
  declined: () => 'Your payment method was declined. Open the PayPal button again to retry.',
  failed: () => 'PayPal couldn\'t complete the payment. You were not charged.',
  awaiting_payment: () => 'Still waiting for payment on PayPal.'
}

export default function ClientDemo() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [bookings, setBookings] = useState(null)
  const [customer, setCustomer] = useState(null)
  const [memberships, setMemberships] = useState(null)
  const [view, setView] = useState('web')
  // Telegram and Alexa wait until the guided tour is done (lib/tourSteps setPhoneLock);
  // when they open, they glow for a moment.
  const [locked, setLocked] = useState(false)
  const [unlockedNow, setUnlockedNow] = useState(false)
  // Tapping a locked one: it shakes a little (like a locked door) and Web chat glows
  // once, pointing the way. No text: the lock and the motion say it.
  const [nudge, setNudge] = useState(null)    // the locked item that was tapped
  const nudgeTimer = useRef(null)
  const nudgeLocked = id => {
    clearTimeout(nudgeTimer.current)
    setNudge(null)
    // Off, then on again a moment later: a second tap restarts the animation.
    nudgeTimer.current = setTimeout(() => {
      setNudge(id)
      nudgeTimer.current = setTimeout(() => setNudge(null), 1700)
    }, 30)
  }
  useEffect(() => {
    setLocked(phoneLocked())
    let t
    const on = e => {
      setLocked(!!e.detail)
      if (!e.detail) { setUnlockedNow(true); clearTimeout(t); t = setTimeout(() => setUnlockedNow(false), 2600) }
    }
    window.addEventListener(PHONE_LOCK_EVENT, on)
    return () => { window.removeEventListener(PHONE_LOCK_EVENT, on); clearTimeout(t) }
  }, [])
  const [cityKey, setCityKey] = useState(0)     // bump → Near you reloads (visits change after bookings)
  const [ppNotice, setPpNotice] = useState('')  // back from PayPal after Change account / Save PayPal
  const [whoDone, setWhoDone] = useState(true)   // logged in with PayPal for this session
  const loadSession = useCallback(() => demoApi('/session').then(d => {
    if (!d || d.error) return
    setSession(d)
    // PayPal login is required (your own sandbox account or the demo's buyer): no skipping.
    setWhoDone(!!d.paypalLogin)
  }), [])
  // Guided demo: the script card (hidden with ×, back from the chat header) and
  // whether the judge's salon has been set up yet.
  const [session, setSession] = useState(null)
  const [scriptOn, setScriptOn] = useState(true)
  useEffect(() => {
    loadSession()
    try { if (localStorage.getItem('bp_script_hidden') === '1') setScriptOn(false) } catch {}
  }, [])
  function showScript(on) { setScriptOn(on); try { localStorage.setItem('bp_script_hidden', on ? '0' : '1') } catch {} }
  // Resuming the tour brings the script back with it.
  useEffect(() => {
    const onResume = () => showScript(true)
    window.addEventListener('bp-resume', onResume)
    return () => window.removeEventListener('bp-resume', onResume)
  }, [])
  // PayPal risk data for saved-PayPal payments said yes to in this chat.
  useEffect(() => { if (session?.fraudnet) loadFraudNet(session.fraudnet) }, [session?.fraudnet?.clientMetadataId])   // eslint-disable-line react-hooks/exhaustive-deps
  const guided = session?.mode === 'guided'
  const box = useRef(null)
  const textInput = useRef(null)
  // "How it works" overlay for the web chat: shown once, reopened with "?".
  const [tips, setTips] = useState(false)
  useEffect(() => {
    if (!session || session.mode === 'guided' || !whoDone) return
    try { if (!localStorage.getItem('bp_chat_tips')) setTips(true) } catch {}
  }, [session, whoDone])
  function closeTips() { setTips(false); try { localStorage.setItem('bp_chat_tips', '1') } catch {} }

  const loadBookings = useCallback(() => demoApi('/me').then(d => { if (d?.bookings) { setBookings(d.bookings); setCustomer(d.customer); setMemberships(d.memberships || []) } }), [])

  // Account pages hand changes to the assistant (it quotes the refund policy first).
  function askAssistant(text) {
    setView('web'); setInput(text)
    setTimeout(() => textInput.current?.focus(), 50)
  }
  const upcoming = (bookings || []).filter(b => b.status !== 'cancelled' && new Date(b.endTime || b.startTime).getTime() > Date.now())
  // Orders the chat has seen paid: their PayPal button turns into a "Paid" badge.
  const paidOrders = new Set(messages.filter(m => m.paid && m.order).map(m => m.order))
  const lastPayIdx = messages.findLastIndex(m => m.payment?.url && !paidOrders.has(m.payment.orderId))

  // Restore the conversation (it survives the trip to PayPal and back).
  useEffect(() => {
    let restored = []
    try { restored = JSON.parse(localStorage.getItem('bp_chat') || '[]') } catch {}
    setMessages(restored)
    loadBookings()
    const t = setInterval(loadBookings, 10_000)

    const q = new URLSearchParams(window.location.search)
    // ?view=mcp etc. (the Guide panel links here); also live via a 'bp-view' event.
    const start = q.get('view')
    if (NAV.some(g => g.items.some(n => n.id === start && !n.off))) setView(start)
    const go = e => setView(e.detail)
    window.addEventListener('bp-view', go)
    // The Guide's "Book here": put the request in the message box, ready to send (never sent for them).
    const ask = e => { setView('web'); setInput(String(e.detail || '').slice(0, 300)); setTimeout(() => textInput.current?.focus(), 50) }
    window.addEventListener('bp-ask', ask)
    const asked = q.get('ask')
    if (asked) { window.history.replaceState(null, '', '/demo/client'); ask({ detail: asked }) }
    // Back from Log in with PayPal.
    const login = q.get('login')
    if (login) {
      window.history.replaceState(null, '', '/demo/client')
      if (login !== 'ok') setNotice({ cancelled: 'Not logged in: you backed out on PayPal. You can log in any time from Profile or the Guide.', no_name: "PayPal didn't share a name, so nothing changed.", not_found: 'That PayPal login link expired. Try Log in with PayPal again.' }[login] || "Couldn't log in with PayPal just now. Check that Log in with PayPal is switched on for the app, then try again.")
      // Login goes straight on to saving PayPal (core/paypalLogin): say how that went.
      const saved = q.get('saved')
      if (login === 'ok' && saved) setNotice(saved === 'saved' || saved === 'same'
        ? 'Logged in, and your PayPal is saved: bookings pay in one click. You see the amount first, then press Pay.'
        : 'Logged in. PayPal wasn’t saved, so your first booking opens PayPal to pay (and offers to save it then).')
      loadSession().then(() => loadBookings())
      if (login === 'ok') { tourEvent('customer-login'); tourEvent('customer-who') }
    }
    // Back from PayPal after "Change account" / "Save PayPal now" on the Profile page.
    const pp = q.get('paypal')
    if (pp) {
      window.history.replaceState(null, '', '/demo/client')
      setView('profile')
      setPpNotice({ saved: 'PayPal saved. Bookings now pay in one step after you say yes to the amount.', same: "That's the PayPal you already had saved, so nothing changed. To switch, log in on PayPal with a different account.", cancelled: 'Nothing changed: your saved PayPal is as it was.' }[pp] || "PayPal wasn't saved. Nothing changed; try again.")
    }
    const joined = q.get('membership')
    if (joined) {
      window.history.replaceState(null, '', '/demo/client')
      const plan = q.get('plan') || 'your plan'
      const pack = q.get('kind') === 'pack'
      const text = {
        active: pack ? `${plan} is yours. Covered bookings cost nothing: just ask to book.` : `You're now a ${plan} member, billed monthly. Covered bookings cost nothing, so just ask to book.`,
        pending: `PayPal is still confirming ${plan}. It usually takes a few seconds.`,
        failed: `PayPal didn't confirm ${plan}. You were not charged.`,
        error: `Something went wrong confirming ${plan}. If PayPal charged you, it will be sorted out automatically.`,
        cancelled: `No charge was made for ${plan}.`
      }[q.get('membership')] || `Membership status: ${q.get('membership')}`
      setMessages(m => persist([...m, { role: 'assistant', content: text, system: true, subscribed: q.get('membership') === 'active', status: { kind: q.get('membership') === 'active' ? 'joined' : q.get('membership'), plan } }]))
      if (q.get('membership') === 'active') tourEvent('chat-subscribed')
      loadBookings()
    }
    const order = q.get('order') || q.get('token')
    if (order) {
      window.history.replaceState(null, '', '/demo/client')
      publicApi(`/pay/paypal/status?order=${encodeURIComponent(order)}`).then(r => {
        const status = r?.status || q.get('status')
        const text = (STATUS_TEXT[status] || (() => `Payment status: ${status}`))(r || {})
        setMessages(m => persist([...m, { role: 'assistant', content: text, system: true, paid: status === 'confirmed', order, status: { kind: status, amount: r?.amount ?? null, service: r?.serviceName || null, when: r?.when || null } }]))
        if (status === 'confirmed') tourEvent('chat-paid')
        loadBookings()
      })
    }
    return () => { clearInterval(t); window.removeEventListener('bp-view', go); window.removeEventListener('bp-ask', ask) }
  }, [loadBookings])

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [messages, busy])
  // Stay on the newest message when the chat gets shorter (the script card
  // grows, the window shrinks), so a PayPal button under the reply never hides.
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastH = el.clientHeight
    const ro = new ResizeObserver(() => {
      const shrank = el.clientHeight < lastH
      const nearBottom = el.scrollHeight - el.scrollTop - lastH < 80
      if (shrank && nearBottom) el.scrollTop = el.scrollHeight
      lastH = el.clientHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [session])

  async function send(e) {
    e?.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    await sendPayload({ text })
  }
  const paid = messages.some(m => m.paid)
  const subscribed = messages.some(m => m.subscribed)

  // One user turn: text and/or one attachment. The bubble appears at once; the
  // transcript / summary fills in when the server has processed the media.
  // Resolves true once the assistant has replied.
  async function sendPayload({ text = '', attachment = null, preview = null }) {
    setNotice('')
    const history = messages.filter(m => !m.system).map(m => ({ role: m.role, content: m.content }))
    const media = attachment ? { kind: attachment.kind, name: attachment.name, durationSec: attachment.durationSec, preview, pending: true } : null
    const mine = { role: 'user', content: text || (attachment ? `(${attachment.kind} sent)` : ''), text, media }
    const next = [...messages, mine]
    setMessages(next); setBusy(true)
    const d = await demoApi('/chat', { method: 'POST', body: { message: text, attachment, history } })
    setBusy(false)
    if (!d) return false
    if (d.error) {
      setNotice(d.error)
      setMessages(persist(next.map(m => m === mine ? { ...m, media: media && { ...media, pending: false, failed: true } } : m)))
      return false
    }
    const done = { ...mine, content: d.userContent || mine.content, media: media && { ...media, pending: false, preview: null, ...(d.media || {}) } }
    // A voice note gets a spoken reply (handlers/demo voiceReply): played here, kept out of saved history.
    const voice = d.voice?.data ? { url: URL.createObjectURL(new Blob([Uint8Array.from(atob(d.voice.data), c => c.charCodeAt(0))], { type: d.voice.mimeType })), play: true } : null
    const reply = { role: 'assistant', content: d.reply || '…', payment: d.payment || null, confirm: d.confirm || null, link: d.link || null, connect: d.connect || null, ...(voice ? { voice } : {}) }
    // Paid in one step with the saved PayPal: the same card a PayPal return gets.
    const paidCard = d.paid && { role: 'assistant', system: true, paid: true, content: '', status: { kind: d.paid.balance ? 'paid' : 'confirmed', amount: d.paid.amount ?? null, service: d.paid.service || null, when: d.paid.when || null, account: d.paid.account || null, allowanceLeft: d.paid.allowance ? d.paid.allowance.left : null } }
    const joinedCard = d.joined && { role: 'assistant', system: true, subscribed: true, content: `${d.joined.kind === 'pack' ? `${d.joined.plan} is yours.` : `You're now a ${d.joined.plan} member, charged monthly from your saved PayPal.`} Covered bookings cost nothing: just ask to book.`, status: { kind: 'joined', plan: d.joined.plan } }
    setMessages(persist([...next.slice(0, -1), done, reply, ...(paidCard ? [paidCard] : []), ...(joinedCard ? [joinedCard] : [])]))
    if (d.paid) tourEvent('chat-paid')
    if (d.joined) tourEvent('chat-subscribed')
    if (d.bookingsChanged) { loadBookings(); setCityKey(k => k + 1) }
    return true
  }

  // ── Voice notes ──
  const [rec, setRec] = useState(null)        // { handle, startedAt }
  const [recSecs, setRecSecs] = useState(0)
  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - rec.startedAt) / 1000)
      setRecSecs(s)
      if (s >= MAX_VOICE_SECONDS) stopRecording()
    }, 250)
    return () => clearInterval(t)
  })   // eslint-disable-line react-hooks/exhaustive-deps

  async function startRecording() {
    setNotice('')
    try {
      const handle = await startRecorder()
      setRecSecs(0); setRec({ handle, startedAt: Date.now() })
    } catch (err) {
      setNotice(err.name === 'NotAllowedError' ? 'Microphone access was blocked — allow it in the browser to send voice notes.' : (err.message || 'Could not start recording.'))
    }
  }
  async function stopRecording() {
    if (!rec) return
    const { handle } = rec
    setRec(null)
    try {
      const blob = await handle.stop()
      const { attachment } = await audioToAttachment(blob)
      if (attachment.durationSec < 1) { setNotice('That voice note was too short.'); return }
      await sendPayload({ text: input.trim(), attachment }); setInput('')
    } catch (err) {
      setNotice(err.message || 'Could not process the voice note.')
    }
  }
  function cancelRecording() { rec?.handle.cancel(); setRec(null) }

  // ── Photos / PDFs / Word, Excel and text files / audio files ──
  const fileInput = useRef(null)
  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const { attachment, preview } = await fileToAttachment(file)
      await sendPayload({ text: input.trim(), attachment, preview }); setInput('')
    } catch (err) {
      setNotice(err.message || 'Could not read that file.')
    }
  }

  return (
    <div className="client">
      <nav className="client-nav" aria-label="Customer menu">
        <div className="client-who">
          <span className="client-avatar" aria-hidden="true">{(customer?.name || session?.customerName || 'John Doe').split(' ').map(w => w[0]).join('').slice(0, 2)}</span>
          <div>
            <b>{customer?.name || session?.customerName || 'John Doe'}</b>
            <div className="muted small">{session?.paypalLogin ? 'Logged in with PayPal' : 'Customer · Austin, TX'}</div>
          </div>
        </div>
        {NAV.map(g => (
          <div className="client-group" key={g.title}>
            <div className="client-group-title">{g.title}</div>
            {g.items.map(n => (
              <button key={n.id} type="button" disabled={n.off}
                onClick={() => (n.phone && locked ? nudgeLocked(n.id) : setView(n.id))}
                aria-disabled={n.phone && locked ? true : undefined}
                className={`client-link ${view === n.id ? 'on' : ''} ${n.off ? 'off' : ''} ${n.phone && locked ? 'locked' : ''} ${n.phone && unlockedNow ? 'unlocked' : ''} ${nudge && nudge === n.id ? 'shake' : ''} ${nudge && n.id === 'web' ? 'point' : ''}`}
                aria-current={view === n.id ? 'page' : undefined}>
                <span>{n.label}</span>
                {n.phone && locked
                  ? <svg className="client-lock" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" /><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2.2" /></svg>
                  : n.id === 'bookings' && upcoming.length > 0
                    ? <span className="client-count">{upcoming.length}</span>
                    : n.sub && <span className="client-link-sub">{n.sub}</span>}
              </button>
            ))}
          </div>
        ))}
        <p className="client-nav-note">Every channel uses the same AI and the same booking engine.</p>
      </nav>

      <div className="client-view">
      {view === 'mcp' && <ConnectAI />}
      {view === 'telegram' && <TelegramConnect onUseWeb={() => setView('web')} />}
      {view === 'alexa' && <AlexaConnect onUseWeb={() => setView('web')} onUseVoice={() => setView('voice')} />}
      {view === 'voice' && (
        <section className="client-chat">
          <VoiceDevice onBookingsChanged={() => { loadBookings(); setCityKey(k => k + 1) }} />
        </section>
      )}
      <section className="client-chat" style={view !== 'web' ? { display: 'none' } : undefined}>
        <div className="client-chat-head">
          <span className="bot" aria-hidden="true">F</span>
          <div>
            <b>Flow</b>
            <div className="sub">Booking assistant for salons, barbers and spas in Austin</div>
          </div>
          <button type="button" className="chat-help-btn" onClick={() => setTips(true)} title="How it works" aria-label="How the web chat works">?</button>
        </div>
        {tips && (
          <div className="chat-tips-backdrop" role="dialog" aria-modal="true" aria-label="How the web chat works" onClick={e => { if (e.target === e.currentTarget) closeTips() }}>
            <div className="chat-tips">
              <h2>How the web chat works</h2>
              <ol>
                <li><b>Ask in plain words, in any language.</b> “Book me a haircut” or “¿un masaje cerca este fin de semana?”. Flow answers in your language and knows your usual.</li>
                <li><b>Send more than text.</b> 📎 a photo, PDF, Word, Excel or text file up to 4 MB (a style you want, a doctor&apos;s note, a list of guests), or a 🎙 voice note up to 1 minute.</li>
                <li><b>Pay with the PayPal button.</b> It&apos;s the sandbox: use the account you logged in with, or the demo&apos;s buyer (in <b>Inbox &amp; timeline → Guide</b>). The first payment also saves PayPal for one-step booking.</li>
                <li><b>See it everywhere.</b> My bookings, the messages in the Inbox, Under the hood, and the owner&apos;s calendar on the Business side.</li>
              </ol>
              <div className="chat-tips-foot">
                <button type="button" className="btn-sm" onClick={closeTips}>Got it</button>
              </div>
            </div>
          </div>
        )}
        {session && !whoDone && (
          <div className="chat-tips-backdrop" role="dialog" aria-modal="true" aria-label="Who's booking?">
            <div className="chat-tips who-card" data-tour="who">
              <h2>Who&apos;s booking?</h2>
              <p className="muted">Log in with PayPal to start. Flow books under that account&apos;s name, and PayPal then asks once to save it, so your bookings pay in one click. The chat, your inbox and the owner&apos;s calendar all use it. Sandbox, fake money only.</p>
              <PayPalLoginButton />
              <div className="who-or">No sandbox account of your own? Use the demo&apos;s test account on PayPal&apos;s login page:</div>
              <BuyerLogin buyer={session.sandboxBuyer} />
            </div>
          </div>
        )}
        <div className="client-msgs" ref={box}>
          {guided && !session.setupDone && (
            <div className="notice notice-warn client-unset">
              <b>Willow &amp; Co. isn&apos;t set up yet</b>, so your usual salon can&apos;t take bookings. Set it up with AI on the Business side first (about a minute).
              <div style={{ marginTop: 8 }}><Link href="/dashboard/build" className="btn-link btn-sm">Set it up with AI</Link></div>
            </div>
          )}
          {messages.length === 0 && guided && session.setupDone && (
            <div className="client-empty"><p>Hi {(customer?.name || session?.customerName || 'John').split(' ')[0]}! Send the first step of the script below, or type your own message in any language.</p></div>
          )}
          {messages.length === 0 && !guided && (
            <div className="client-empty">
              <p>Hi {(customer?.name || session?.customerName || 'John').split(' ')[0]}! Try:</p>
              {['Book me a haircut', 'Is there a massage place near me this weekend?', 'I need a beard trim tomorrow evening', 'What are my bookings?'].map(s => (
                <button key={s} className="client-suggest" onClick={() => setInput(s)}>{s}</button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role} ${m.system ? 'system' : ''}`}>
              {m.media
                ? <MediaBubble m={m} />
                : m.system
                ? <StatusCard m={m} />
                : <div className={`bubble ${m.voice?.url ? 'voice-reply' : ''}`}>
                    {m.voice?.url && <audio className="voice-reply-audio" controls src={m.voice.url} autoPlay={m.voice.play} aria-label="Spoken reply" />}
                    <RichText text={m.content} />
                  </div>}
              {m.payment?.url && paidOrders.has(m.payment.orderId) && <div className="paid-chip"><Icon kind="check" /> Paid with PayPal</div>}
              {m.payment?.url && !paidOrders.has(m.payment.orderId) && (
                // The newest unpaid button is what the tour's pay/subscribe step points at.
                <a className="paypal-btn" href={m.payment.url} data-tour={i === lastPayIdx ? (m.payment.kind === 'subscription' ? 'paypal-subscribe' : 'paypal-pay') : undefined}>
                  {m.payment.kind === 'subscription'
                    ? <>Subscribe {m.payment.amount != null ? `${formatMoney(m.payment.amount)}/month` : ''} with <b>PayPal</b></>
                    : <>Pay {m.payment.amount != null ? formatMoney(m.payment.amount) : ''} with <b>PayPal</b></>}
                </a>
              )}
              {m.confirm && i === messages.length - 1 && !busy && (
                <button className="paypal-btn saved-pay-btn" data-tour="paypal-pay" onClick={() => sendPayload({ text: `Yes, pay ${formatMoney(m.confirm.amount)} with my saved PayPal.` })}>
                  Yes, pay {formatMoney(m.confirm.amount)} with saved <b>PayPal</b>
                </button>
              )}
              {m.confirm && i === messages.length - 1 && !busy && <div className="pay-note">Uses {m.confirm.account}. Nothing is charged until you say yes.</div>}
              {m.link?.url && <a className="btn-secondary btn-sm chat-link-btn" href={m.link.url}>{m.link.label}</a>}
              {m.connect && i === messages.length - 1 && (
                // Link PayPal once (PAYPAL_ONE_LINK.md): log in, PayPal saves it, every payment after is a yes.
                <div className="connect-pp" data-tour="paypal-pay">
                  <PayPalLoginButton label="Connect PayPal" />
                  <div className="pay-note">One time: log in with PayPal and agree to save it. After that every booking, pack and membership pays here with a yes.</div>
                </div>
              )}
              {m.payment?.url && !paidOrders.has(m.payment.orderId) && <div className="pay-note">PayPal asks to confirm this one on its own page. {m.payment.savesPaypal ? 'Paying also saves your PayPal for one-step booking next time. ' : ''}{m.payment.kind === 'subscription' ? `${m.payment.plan || 'The membership'}: billed monthly; cancel any time by asking.` : m.payment.kind === 'pack' ? `${m.payment.plan || 'The pack'}: one payment.` : `Slot held for ${m.payment.holdMinutes || 10} min.`}</div>}
            </div>
          ))}
          {busy && <div className="msg assistant"><div className="bubble typing" role="status"><i className="pulse-dot" /> Processing…</div></div>}
        </div>
        {notice && <div className="client-notice">{notice}</div>}
        {guided && session.setupDone && scriptOn && (
          <ScriptCard sid={session.sid} busy={busy} paid={paid} subscribed={subscribed}
            onSendText={text => sendPayload({ text })} onSendAudio={attachment => sendPayload({ attachment })} onClose={() => showScript(false)} />
        )}
        {/* Bottom-left, with the tour's Resume pill: where everything guided comes back. */}
        {guided && session.setupDone && !scriptOn && <button type="button" className="script-fab" onClick={() => showScript(true)}>Script · <b>Show</b></button>}
        <form className="client-input" onSubmit={send}>
          <input ref={fileInput} type="file" accept={FILE_ACCEPT} onChange={onFile} hidden />
          <button type="button" className="icon-btn" title="Send a photo, PDF, Word, Excel or text file (up to 4 MB)" aria-label="Attach a file"
            onClick={() => fileInput.current?.click()} disabled={busy || !!rec}>📎</button>
          {rec ? (
            <div className="rec-bar" role="status">
              <span className="rec-dot" /> Recording {Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, '0')}
              <span className="muted small"> · max {MAX_VOICE_SECONDS}s</span>
              <button type="button" className="btn-sm btn-secondary" onClick={cancelRecording}>Cancel</button>
            </div>
          ) : (
            <input ref={textInput} value={input} onChange={e => setInput(e.target.value)} placeholder="Message Flow…" maxLength={1000} />
          )}
          {rec
            ? <button type="button" className="icon-btn rec-stop" title="Stop and send" aria-label="Stop and send voice note" onClick={stopRecording}>■</button>
            : <button type="button" className="icon-btn" title="Record a voice note" aria-label="Record a voice note" onClick={startRecording} disabled={busy}>🎙</button>}
          <button type="submit" disabled={busy || !!rec || !input.trim()}>Send</button>
        </form>
      </section>

      {/* At a glance next to the chat on wide screens; the same things have their
          own pages in the menu, so nothing is lost when this column is hidden. */}
      {CHAT_VIEWS.includes(view) && (
        <aside className="client-mine">
          <div className="client-h">Near you</div>
          <NearYou refreshKey={cityKey} />
          <div className="client-h" style={{ marginTop: 18 }}>Upcoming</div>
          {bookings === null && <p className="muted">Loading…</p>}
          {bookings !== null && upcoming.length === 0 && <p className="muted">No bookings yet. Ask the assistant for a time.</p>}
          {upcoming.map(b => <BookingCard key={b.appointmentId} b={b} />)}
        </aside>
      )}

      {view === 'bookings' && <MyBookings bookings={bookings} onAsk={askAssistant} />}
      {view === 'near' && <NearYouPage refreshKey={cityKey} onAsk={askAssistant} />}
      {view === 'payments' && <Payments bookings={bookings} />}
      {view === 'memberships' && <Memberships memberships={memberships} onAsk={askAssistant} />}
      {view === 'profile' && <Profile customer={customer} session={session} onAsk={askAssistant} goTo={setView} onChanged={loadBookings} notice={ppNotice} />}
      </div>
    </div>
  )
}

// A user turn that carried a voice note, photo, PDF or document: what was sent, then what
// the AI understood from it (transcript / summary).
function MediaBubble({ m }) {
  const md = m.media
  const label = md.kind === 'audio'
    ? `🎙 Voice note${md.durationSec ? ` · ${Math.floor(md.durationSec / 60)}:${String(md.durationSec % 60).padStart(2, '0')}` : ''}`
    : md.kind === 'pdf' || md.kind === 'doc' ? `📄 ${md.name || 'Document'}` : `📷 ${md.name || 'Photo'}`
  const understood = md.kind === 'audio' ? md.transcript : md.summary
  return (
    <div className="bubble media-bubble">
      {md.preview && <img src={md.preview} alt="" className="media-thumb" />}
      <div className="media-label">{label}</div>
      {m.text && <div>{m.text}</div>}
      {md.pending && <div className="media-note">{md.kind === 'audio' ? 'Transcribing…' : 'Reading…'}</div>}
      {md.failed && <div className="media-note">Not sent.</div>}
      {understood && <div className="media-note">{md.kind === 'audio' ? `“${understood}”` : `AI read it as: ${understood}`}</div>}
    </div>
  )
}

// Minimal, safe markdown for AI replies: **bold** and "* " / "- " bullet lines.
// Builds React elements (no HTML injection).
// A PayPal checkout link in a reply is noise: the PayPal button below carries it.
const CHECKOUT = /https?:\/\/(www\.)?(sandbox\.)?paypal\.com\/(checkoutnow|webapps\/billing|pay)\S*/i
function cleanReply(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g, (all, url) => (CHECKOUT.test(url) ? '' : all))
    .replace(new RegExp(CHECKOUT.source, 'gi'), '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// **bold**, [text](url) and bare links, inline.
function inlineParts(line, key) {
  return line.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+)/g).map((part, i) => {
    const k = `${key}-${i}`
    if (part.startsWith('**') && part.endsWith('**')) return <b key={k}>{part.slice(2, -2)}</b>
    const md = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)
    if (md) return <a key={k} href={md[2]} target="_blank" rel="noreferrer">{md[1]}</a>
    if (/^https?:\/\//.test(part)) return <a key={k} href={part} target="_blank" rel="noreferrer">{part.replace(/^https?:\/\//, '').slice(0, 40)}</a>
    return <span key={k}>{part}</span>
  })
}

function RichText({ text }) {
  const inline = inlineParts
  const lines = cleanReply(text).split('\n')
  const out = []
  let bullets = []
  const flush = () => { if (bullets.length) { out.push(<ul key={`ul-${out.length}`} className="bubble-list">{bullets}</ul>); bullets = [] } }
  lines.forEach((line, i) => {
    const m = line.match(/^\s*[*-]\s+(.*)$/)
    if (m) { bullets.push(<li key={i}>{inline(m[1], i)}</li>); return }
    flush()
    if (line.trim()) out.push(<div key={i}>{inline(line, i)}</div>)
    else if (out.length) out.push(<div key={i} className="bubble-gap" />)
  })
  flush()
  return out
}

// Results that come back from PayPal (and membership sign-ups), as a card.
const STATUS_LOOK = {
  confirmed: { tone: 'ok', icon: 'check', title: 'Payment received' },
  paid: { tone: 'ok', icon: 'check', title: 'Paid in full' },
  joined: { tone: 'ok', icon: 'check', title: 'Membership active' },
  active: { tone: 'ok', icon: 'check', title: 'Membership active' },
  slot_taken: { tone: 'warn', icon: 'alert', title: 'That time was taken' },
  refunded: { tone: 'info', icon: 'refund', title: 'Payment refunded' },
  cancelled: { tone: 'muted', icon: 'x', title: 'Payment cancelled' },
  pending: { tone: 'info', icon: 'clock', title: 'Payment processing' },
  declined: { tone: 'bad', icon: 'x', title: 'Payment declined' },
  failed: { tone: 'bad', icon: 'x', title: 'Payment didn\'t go through' },
  awaiting_payment: { tone: 'muted', icon: 'clock', title: 'Waiting for payment' }
}
function StatusCard({ m }) {
  const st = m.status || { kind: m.paid ? 'confirmed' : m.subscribed ? 'joined' : 'info' }
  const look = STATUS_LOOK[st.kind] || { tone: 'muted', icon: 'info', title: 'Update' }
  const body = String(m.content || '').replace(/^[^\p{L}\p{N}]+/u, '')   // older messages started with an emoji
  const detail = (st.kind === 'confirmed' || st.kind === 'paid') && (st.service || st.when) ? [st.service, st.when].filter(Boolean).join(' · ') : null
  const how = st.allowanceLeft != null ? `paid by your AI under your allowance (${formatMoney(st.allowanceLeft)} left this month)`
    : st.account ? `paid with your saved PayPal (${st.account})` : 'paid with PayPal'
  return (
    <div className={`status-card tone-${look.tone}`}>
      <span className="status-icon"><Icon kind={look.icon} /></span>
      <div className="status-body">
        <div className="status-title">{look.title}{(st.kind === 'confirmed' || st.kind === 'paid') && st.amount != null && <span className="status-amount">{formatMoney(st.amount)}</span>}</div>
        {detail
          ? <><div className="status-detail">{detail}</div><div className="status-note">{st.kind === 'paid' ? 'Fully paid' : 'Booking confirmed'} · {how} · receipt in your inbox</div></>
          : <div className="status-detail">{body}</div>}
      </div>
    </div>
  )
}

function Icon({ kind }) {
  const paths = {
    check: <path d="M5 12.5l4.2 4.2L19 7" />,
    alert: <><path d="M12 8v5" /><path d="M12 16.5v.5" /></>,
    refund: <><path d="M9 14l-4-4 4-4" /><path d="M5 10h9a5 5 0 010 10h-2" /></>,
    x: <><path d="M7 7l10 10" /><path d="M17 7L7 17" /></>,
    clock: <><circle cx="12" cy="12" r="7.5" /><path d="M12 8.5V12l2.5 1.5" /></>,
    info: <><path d="M12 11v5" /><path d="M12 8v.5" /></>
  }
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind] || paths.info}</svg>
}

function persist(list) {
  const trimmed = list.slice(-60)
  // Spoken replies live only in this page (a blob URL), so the saved chat keeps their text alone.
  try { localStorage.setItem('bp_chat', JSON.stringify(trimmed.map(({ voice, ...m }) => m))) } catch {}
  return trimmed
}
