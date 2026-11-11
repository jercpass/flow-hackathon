'use client'
import { useEffect, useState } from 'react'
import { demoApi } from '../../../lib/demo'
import { formatMoney } from '../../../lib/money'
import NearYou from './NearYou'
import McpConnect from '../../../lib/McpConnect'
import { PayPalLoginButton } from '../../../lib/CustomerLogin'

// The customer's own pages (the "Your account" part of the customer's menu). Changes
// such as moving or cancelling a booking go through the assistant, so the
// business's refund policy is quoted before anything happens.

// The business's own time (the server formats it), else Austin's: never the visitor's time zone.
const when = (iso, b) => b?.when || new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// What happened to the money, in words.
function moneyStatus(b) {
  const paid = Number(b.amountPaid || 0), back = Number(b.refundAmount || 0)
  if (b.status !== 'cancelled') return { text: b.paymentStatus === 'partial' ? 'Deposit paid' : 'Paid', tone: 'ok' }
  if (back >= paid - 0.001 && back > 0) return { text: 'Cancelled · refunded in full', tone: 'ok' }
  if (back > 0) return { text: 'Cancelled · partly refunded', tone: 'ok' }
  if (b.refundStatus === 'failed' || b.refundStatus === 'pending') return { text: 'Cancelled · refund on its way', tone: 'warn' }
  if (b.paidWith === 'in_person') return { text: 'Cancelled · paid at the business, so it refunds you directly', tone: 'muted' }
  if (b.paidWith === 'membership') return { text: 'Cancelled · the use went back to the membership', tone: 'muted' }
  return { text: 'Cancelled · no refund under the policy', tone: 'muted' }
}
const isPast = b => new Date(b.endTime || b.startTime).getTime() < Date.now()

export function BookingCard({ b, onAsk }) {
  const active = b.status !== 'cancelled' && !isPast(b)
  // A deposit booking: the rest is paid with PayPal before the visit, from any channel.
  const left = Math.round((Number(b.totalAmount || 0) - Number(b.amountPaid || 0)) * 100) / 100
  const owes = active && b.paidWith === 'paypal' && Number(b.amountPaid) > 0 && left > 0.001
  return (
    <div className={`booking ${b.status}`}>
      <div className="muted small">{b.business}{b.staff ? ` · with ${b.staff}` : ''}</div>
      <div className="booking-top"><b>{b.service}</b><span className={`badge ${b.status === 'cancelled' ? 'badge-gray' : 'badge-green'}`}>{b.status}</span></div>
      <div>{when(b.startTime, b)}</div>
      <div className="muted small">
        {b.membershipPlan ? `Covered by ${b.membershipPlan}` : b.amountPaid ? `Paid ${formatMoney(b.amountPaid)} via PayPal${b.memberDiscountPct ? ` (${b.memberDiscountPct}% member discount)` : ''}` : 'Not paid'}
        {b.refundAmount ? ` · refunded ${formatMoney(b.refundAmount)}` : ''}
        {owes ? <> · <b>{formatMoney(left)} left to pay</b></> : null}
      </div>
      {b.customerNotes && <div className="muted small">📝 {b.customerNotes}</div>}
      {onAsk && active && (
        <div className="booking-actions">
          {owes && <button className="btn-sm" onClick={() => onAsk(`I'd like to pay the rest (${formatMoney(left)}) of my ${b.service} at ${b.business} on ${when(b.startTime, b)}.`)}>Pay the rest</button>}
          <button className="btn-sm btn-secondary" onClick={() => onAsk(`I'd like to move my ${b.service} at ${b.business} on ${when(b.startTime, b)} to another time.`)}>Move</button>
          <button className="btn-sm btn-secondary" onClick={() => onAsk(`Please cancel my ${b.service} at ${b.business} on ${when(b.startTime, b)}.`)}>Cancel</button>
        </div>
      )}
    </div>
  )
}

export function MyBookings({ bookings, onAsk }) {
  if (bookings === null) return <Page title="My bookings"><p className="muted">Loading…</p></Page>
  const upcoming = bookings.filter(b => b.status !== 'cancelled' && !isPast(b))
  const other = bookings.filter(b => !upcoming.includes(b))
  return (
    <Page title="My bookings" lead="Bookings from every channel (web chat, voice, your own AI) land here. Moving or cancelling goes through the assistant, which quotes the business's refund policy first.">
      <h2>Upcoming</h2>
      {upcoming.length
        ? <div className="booking-grid">{upcoming.map(b => <BookingCard key={b.appointmentId} b={b} onAsk={onAsk} />)}</div>
        : <div className="empty">Nothing booked yet. <button className="link-btn" onClick={() => onAsk('Book me a haircut')}>Ask the assistant for a time</button></div>}
      {other.length > 0 && (
        <>
          <h2 style={{ marginTop: 24 }}>Past and cancelled</h2>
          <div className="booking-grid">{other.map(b => <BookingCard key={b.appointmentId} b={b} />)}</div>
        </>
      )}
    </Page>
  )
}

export function NearYouPage({ refreshKey, onAsk }) {
  return (
    <Page title="Near you" lead="Every business in the demo city (including any you add on the Business side), by distance from your demo home. That's a made-up test address in Austin, not your location. Your visit history is what lets the assistant suggest “your usual”.">
      <NearYou refreshKey={refreshKey} detailed onBook={name => onAsk(`Book me at ${name}`)} />
    </Page>
  )
}

export function ConnectAI() {
  return (
    <Page title="Connect your own AI" lead="Use Flow from Claude, ChatGPT, Cursor or any AI app that speaks MCP. Your AI gets the same tools as the web chat: it finds places, books and pays for you.">
      <McpConnect focus="customer" />
    </Page>
  )
}

export function Payments({ bookings }) {
  if (bookings === null) return <Page title="Payments & refunds"><p className="muted">Loading…</p></Page>
  const paid = bookings.filter(b => Number(b.amountPaid) > 0)
  const total = paid.reduce((s, b) => s + Number(b.amountPaid), 0)
  const refunded = paid.reduce((s, b) => s + Number(b.refundAmount || 0), 0)
  return (
    <Page title="Payments & refunds" lead="You pay each business with PayPal (sandbox, fake money). If you cancel, the refund follows that business's policy and goes back to your PayPal automatically. Something you paid at the business itself is refunded there.">
      <div className="stat-grid">
        <div className="stat-card"><div className="label">Paid</div><div className="value">{formatMoney(total)}</div><div className="muted small">{paid.length} payment{paid.length === 1 ? '' : 's'}</div></div>
        <div className="stat-card"><div className="label">Refunded</div><div className="value">{formatMoney(refunded)}</div><div className="muted small">back to your PayPal</div></div>
        <div className="stat-card"><div className="label">Net spent</div><div className="value">{formatMoney(total - refunded)}</div><div className="muted small">after refunds</div></div>
      </div>
      {paid.length ? (
        <div className="pay-list">
          {paid.map(b => {
            const st = moneyStatus(b)
            return (
              <div key={b.appointmentId} className="pay-row">
                <div className="pay-main">
                  <div className="pay-what"><b>{b.service}</b> · {b.business}</div>
                  <div className="muted small">{when(b.startTime, b)}{b.moved ? ' · moved' : ''}</div>
                </div>
                <div className="pay-money">
                  <b>{formatMoney(b.amountPaid)}</b>
                  <span className="muted small">{b.paidWith === 'in_person' ? 'at the business' : b.paidWith === 'membership' ? 'membership' : 'PayPal'}</span>
                  {b.refundAmount ? <span className="small pay-back">{formatMoney(b.refundAmount)} refunded</span> : null}
                </div>
                <div className="pay-foot"><span className={`pay-status tone-${st.tone}`}>{st.text}</span></div>
              </div>
            )
          })}
        </div>
      ) : <p className="muted">No PayPal payments yet. Book something in Web chat and pay with the sandbox buyer from the Guide tab.</p>}
    </Page>
  )
}

// The customer's memberships and packs, and what the city's businesses offer. Joining
// and cancelling go through the assistant (PayPal link; quote before cancel).
export function Memberships({ memberships, onAsk }) {
  const [city, setCity] = useState(null)
  useEffect(() => { demoApi('/places').then(d => d?.places && setCity(d)) }, [])
  const offers = (city?.places || []).filter(p => p.memberships?.length)
  const mine = memberships || []
  return (
    <Page title="Memberships & packs" lead="Businesses can sell a monthly membership (charged monthly to your saved PayPal; cancel any time) or a pack (one payment). Bookings they cover cost nothing; members can get a discount on other services.">
      <div className="section-title"><h2>Yours</h2></div>
      {mine.length ? (
        <div className="member-grid">
          {mine.map(m => (
            <div key={`${m.business}-${m.plan}`} className="card member-card">
              <div className="member-top">
                <b>{m.plan}</b>
                <span className={`badge ${m.status === 'active' ? 'badge-green' : 'badge-gray'}`}>{m.status === 'cancelled' ? `ends ${m.ends}` : m.kind}</span>
              </div>
              <div className="muted small">{m.business}</div>
              <div className="member-uses">{m.uses_left}</div>
              {m.discount && <div className="muted small">Member discount: {m.discount}</div>}
              <div className="muted small">{m.kind === 'pack' ? `Use by ${m.valid_until}` : m.renews ? `Renews ${m.renews} · ${m.price}` : ''}</div>
              {m.kind !== 'pack' && m.status === 'active' && <button className="btn-sm btn-secondary" style={{ marginTop: 10 }} onClick={() => onAsk(`Please cancel my ${m.plan} membership at ${m.business}.`)}>Cancel membership</button>}
            </div>
          ))}
        </div>
      ) : <p className="muted">None yet. Ask the assistant “Do you have a membership or a pack?”</p>}

      <div className="section-title"><h2>On offer near you</h2></div>
      {city === null ? <p className="muted">Loading…</p> : (
        <div className="member-grid">
          {offers.flatMap(p => p.memberships.map(plan => (
            <div key={`${p.name}-${plan.name}`} className="card member-card">
              <div className="member-top"><b>{plan.name}</b><span className="badge badge-blue">{plan.price}</span></div>
              <div className="muted small">{p.name}</div>
              <div className="member-uses">{plan.includes}</div>
              {plan.discount && <div className="muted small">Plus {plan.discount}</div>}
              <div className="muted small">{plan.paid_with}</div>
              <button className="btn-sm" style={{ marginTop: 10 }} onClick={() => onAsk(`I'd like ${plan.kind === 'pack' ? 'to buy the' : 'to join'} ${plan.name} at ${p.name}.`)}>{plan.kind === 'pack' ? 'Buy with the assistant' : 'Join with the assistant'}</button>
            </div>
          )))}
        </div>
      )}
    </Page>
  )
}

export function Profile({ customer, session, onAsk, goTo, onChanged, notice }) {
  const [city, setCity] = useState(null)
  useEffect(() => { demoApi('/places').then(d => d?.places && setCity(d)) }, [])
  const usual = city?.places.filter(p => p.visits > 0).sort((a, b) => b.visits - a.visits)[0]
  const visits = city?.places.reduce((s, p) => s + (p.visits || 0), 0)
  // "Usual" = what the customer's past visits say: the place visited most, the stylist
  // seen most there, and the last service. Spelled out so the button is clear.
  const usualWhat = usual && `${usual.lastService || 'appointment'}${usual.usualStaff ? ` with ${usual.usualStaff}` : ''}`
  return (
    <Page title="Profile" lead="The customer you are in this demo. Everything here is wiped when the session ends.">
      <div className="card profile">
        <Row k="Name" v={<>{customer?.name || session?.customerName || 'John Doe'}{' '}
          {session?.paypalLogin
            ? <span className="muted small">· logged in with PayPal{session.paypalLogin.email ? ' (' + session.paypalLogin.email + ')' : ''}</span>
            : <span className="muted small">· the demo&apos;s sandbox buyer</span>}
          <div className="profile-login"><PayPalLoginButton label={session?.paypalLogin ? 'Log in with another PayPal' : 'Log in with PayPal'} className="pp-login-sm" /></div></>} />
        <Row k="Inbox" v={<>Flow inbox <span className="muted small">· confirmations and receipts arrive in the Inbox tab</span></>} />
        <Row k="Home" v={city
          ? <>{String(city.location.label).replace(/^Home · /, '')}, Austin <span className="demo-tag">Demo location</span><div className="muted small">Made up for testing. Your real location is never used.</div></>
          : '…'} />
        <Row k="Your usual" v={!city ? '…' : usual
          ? <>{usualWhat} at {usual.name} <span className="muted small">· from your {usual.visits} past visits there</span></>
          : 'None yet: book a few times and the assistant learns it'} />
        <Row k="Visits on record" v={visits ?? '…'} />
      </div>
      <SavedPaypalCard saved={customer?.savedPaypal} onChanged={onChanged} notice={notice} />
      <AllowanceCard allowance={customer?.allowance} terms={customer?.mandateTerms} payments={customer?.mandatePayments || []} hasSaved={!!customer?.savedPaypal?.saved} onChanged={onChanged} />
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Book the way you like</h2>
        <div className="profile-actions">
          {usual
            ? <button onClick={() => onAsk(`Book my usual: ${usualWhat} at ${usual.name}.`)}>Book my usual: {usualWhat}</button>
            : <button onClick={() => onAsk('Book me a haircut')}>Book an appointment</button>}
          <button className="btn-secondary" onClick={() => goTo('voice')}>Use the voice assistant</button>
          <button className="btn-secondary" onClick={() => goTo('mcp')}>Connect your own AI</button>
        </div>
      </div>
    </Page>
  )
}

// The PayPal the customer saved for one-step booking.
// Change account and Save open PayPal (nothing is charged); Remove asks first.
function SavedPaypalCard({ saved, onChanged, notice }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  async function openPaypal() {
    setError(''); setBusy('change')
    const d = await demoApi('/paypal/saved/change', { method: 'POST' })
    if (d?.url) { window.location.href = d.url; return }
    setBusy(''); setError(d?.error || "Couldn't open PayPal. Try again.")
  }
  async function remove() {
    if (!window.confirm(`Remove ${saved.account}? Your next payment will open PayPal again.`)) return
    setError(''); setBusy('remove')
    const d = await demoApi('/paypal/saved/remove', { method: 'POST' })
    setBusy('')
    if (d?.removed) onChanged?.()
    else setError(d?.error || d?.message || "Couldn't remove it. Try again.")
  }
  if (!saved) return null
  return (
    <div className="card saved-pp">
      <div className="saved-pp-head">
        <div>
          <h2>PayPal</h2>
          <p className="muted small">
            {saved.saved
              ? <>Saved: <b>{saved.account}</b>. Bookings pay in one step after you say yes to the amount.</>
              : <>Not saved. Your next PayPal payment saves it (PayPal asks first), so later bookings pay in one step.</>}
          </p>
        </div>
        <span className={`badge ${saved.saved ? 'badge-green' : 'badge-gray'}`}>{saved.saved ? 'Saved' : 'Not saved'}</span>
      </div>
      <div className="btn-row">
        {saved.saved ? (
          <>
            <button className="btn-secondary btn-sm" onClick={openPaypal} disabled={!!busy}>{busy === 'change' ? 'Opening PayPal…' : 'Change account'}</button>
            <button className="btn-secondary btn-sm saved-pp-remove" onClick={remove} disabled={!!busy}>{busy === 'remove' ? 'Removing…' : 'Remove'}</button>
          </>
        ) : (
          <button className="btn-secondary btn-sm" onClick={openPaypal} disabled={!!busy}>{busy === 'change' ? 'Opening PayPal…' : 'Save PayPal now'}</button>
        )}
      </div>
      {notice && <p className="small saved-pp-done">{notice}</p>}
      <p className="muted small saved-pp-note">{saved.saved ? "Change account" : "Save PayPal now"} opens PayPal; nothing is charged. Sandbox: log in with the test buyer from the Guide tab.</p>
      {error && <p className="small saved-pp-error">{error}</p>}
    </div>
  )
}

// What the customer's AI may pay without asking,
// as signed terms with an end date and the kinds of places they cover, plus each
// payment made under them (PAYPAL_GAPS.md §3). Only set here: no AI tool can change it.
const PLACES = [['salon', 'Salons'], ['barber', 'Barbers'], ['spa', 'Spas']]
const untilText = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
function AllowanceCard({ allowance, terms, payments, hasSaved, onChanged }) {
  const [form, setForm] = useState(null)   // { perBooking, perMonth, days, places } while editing
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!allowance) return null
  const a = allowance
  async function save(on) {
    setBusy(true); setError('')
    const d = await demoApi('/allowance', { method: 'POST', body: on ? { on: true, perBooking: Number(form.perBooking), perMonth: Number(form.perMonth), days: Number(form.days), categories: form.places } : { on: false } })
    setBusy(false)
    if (d?.allowance) { setForm(null); onChanged?.() } else setError(d?.error || "Couldn't save it. Try again.")
  }
  return (
    <div className="card saved-pp allowance" data-tour="allowance">
      <div className="saved-pp-head">
        <div>
          <h2>AI spending allowance</h2>
          <p className="muted small">
            {a.on
              ? <>Your AI may pay up to <b>{formatMoney(a.perBooking)}</b> a booking and <b>{formatMoney(a.perMonth)}</b> a month with your saved PayPal, without asking you each time, at <b>{a.places || 'any place on Flow'}</b>{a.expiresAt ? <>, {a.expired ? 'ended' : 'until'} <b>{untilText(a.expiresAt)}</b></> : null}. <b>{formatMoney(a.left)}</b> left this month.</>
              : <>Let your AI (web chat, voice or your own AI app) pay with your saved PayPal without asking you each time, up to limits you set. Anything above them still needs your yes.</>}
          </p>
        </div>
        <span className={`badge ${a.on && !a.expired ? 'badge-green' : 'badge-gray'}`}>{a.on ? (a.expired ? 'Ended' : 'On') : 'Off'}</span>
      </div>
      {a.on && <div className="allow-meter" aria-label={`${formatMoney(a.spent)} of ${formatMoney(a.perMonth)} used this month`}><span style={{ width: `${Math.min(100, (a.spent / a.perMonth) * 100)}%` }} /></div>}
      {form ? (
        <div className="allow-form">
          <label>Per booking, up to <span className="allow-input">$<input type="number" min="1" max="500" step="1" value={form.perBooking} onChange={e => setForm(f => ({ ...f, perBooking: e.target.value }))} /></span></label>
          <label>Per month, up to <span className="allow-input">$<input type="number" min="1" max="2000" step="1" value={form.perMonth} onChange={e => setForm(f => ({ ...f, perMonth: e.target.value }))} /></span></label>
          <label>For <select value={form.days} onChange={e => setForm(f => ({ ...f, days: e.target.value }))}>{[7, 30, 90].map(d => <option key={d} value={d}>{d} days</option>)}</select></label>
          <div className="allow-places" role="group" aria-label="Where it can pay">
            <span>At</span>
            {PLACES.map(([id, label]) => (
              <label key={id} className="allow-place">
                <input type="checkbox" checked={form.places.includes(id)} onChange={e => setForm(f => ({ ...f, places: e.target.checked ? [...f.places, id] : f.places.filter(x => x !== id) }))} /> {label}
              </label>
            ))}
          </div>
          <div className="btn-row">
            <button className="btn-sm" onClick={() => save(true)} disabled={busy || !form.places.length}>{busy ? 'Saving…' : 'Sign and save'}</button>
            <button className="btn-sm btn-secondary" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="btn-row">
          {hasSaved
            ? <button className="btn-secondary btn-sm" onClick={() => setForm({ perBooking: a.perBooking || 50, perMonth: a.perMonth || 150, days: 30, places: a.categories?.length ? a.categories : PLACES.map(([id]) => id) })}>{a.on ? 'Change limits' : 'Turn on'}</button>
            : <span className="muted small">Save PayPal first (above): the allowance pays with it.</span>}
          {a.on && <button className="btn-secondary btn-sm saved-pp-remove" onClick={() => save(false)} disabled={busy}>Turn off</button>}
        </div>
      )}
      {a.on && payments.length > 0 && (
        <div className="allow-paid">
          <b className="small">Paid under it</b>
          <ul>{payments.map(p => (
            <li key={p.id} className="small">
              <span>{formatMoney(p.amount, p.currency)} · {p.what} at {p.business}</span>
              <span className="muted">{p.status === 'paid' ? 'paid' : 'not charged'} · {p.id}</span>
            </li>
          ))}</ul>
        </div>
      )}
      {a.on && terms && (
        <details className="allow-terms">
          <summary className="small">Signed terms {terms.mandateId}{terms.valid ? ' ✓' : ''}</summary>
          <pre>{JSON.stringify(terms, null, 2)}</pre>
        </details>
      )}
      <p className="muted small saved-pp-note">Flow signs these terms and checks every payment against them. Each payment made under them is written down first and sent to PayPal as a payment Flow started on terms you agreed to. Every payment lands in your inbox, and refunds follow the business&apos;s policy as usual. Your AI can see these limits but can&apos;t change them.</p>
      {error && <p className="small saved-pp-error">{error}</p>}
    </div>
  )
}

function Row({ k, v }) {
  return <div className="profile-row"><div className="profile-k">{k}</div><div>{v}</div></div>
}

function Page({ title, lead, children }) {
  return (
    <div className="client-page">
      <h1>{title}</h1>
      {lead && <p className="muted client-lead">{lead}</p>}
      {children}
    </div>
  )
}
