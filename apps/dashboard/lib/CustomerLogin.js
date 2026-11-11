'use client'
import { useState } from 'react'
import { demoApi } from './demo'

// Who the customer is: Log in with PayPal, with
// the demo's sandbox buyer login right here for anyone without a sandbox account.
// Used by the "Who's booking?" card, the Guide and the Profile page.

export function CopyRow({ label, value }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="guide-copy">
      <span>{label}</span>
      <code>{value}</code>
      <button type="button" className="btn-sm btn-secondary" onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

export function BuyerLogin({ buyer }) {
  if (!buyer) return <p className="muted small">The demo&apos;s sandbox buyer isn&apos;t configured on this server.</p>
  return (
    <div className="guide-creds">
      <CopyRow label="Email" value={buyer.email} />
      {buyer.password && <CopyRow label="Password" value={buyer.password} />}
    </div>
  )
}

/** The PayPal login button. Opens PayPal's sandbox login page; it comes back to the customer side. */
export function PayPalLoginButton({ label = 'Log in with PayPal', className = '' }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function go() {
    setBusy(true); setError('')
    const d = await demoApi('/login/paypal', { method: 'POST' })
    if (d?.url) { window.location.href = d.url; return }
    setBusy(false); setError(d?.error || "Couldn't open PayPal. Try again.")
  }
  return (
    <>
      <button type="button" className={`pp-login ${className}`} onClick={go} disabled={busy}>
        {busy ? 'Opening PayPal…' : <>{label.replace(/PayPal$/, '')}<b>PayPal</b></>}
      </button>
      {error && <p className="small saved-pp-error">{error}</p>}
    </>
  )
}

/** Who's booking: logged in (name + masked email) or the way to log in. */
export function CustomerLogin({ session }) {
  const who = session?.paypalLogin
  return (
    <div className="cust-login">
      {who ? (
        <p className="small">Logged in with PayPal as <b>{who.name}</b>{who.email ? <> ({who.email})</> : null}. Bookings, messages and the owner&apos;s calendar use this name.</p>
      ) : (
        <p className="small">Not logged in yet. Log in with PayPal to book: your own sandbox account, or the demo&apos;s test account below.</p>
      )}
      <PayPalLoginButton label={who ? 'Log in with another PayPal' : 'Log in with PayPal'} />
      <div className="muted small cust-login-note">No sandbox account? Log in on PayPal with the demo&apos;s buyer (fake money only):</div>
      <BuyerLogin buyer={session?.sandboxBuyer} />
    </div>
  )
}
