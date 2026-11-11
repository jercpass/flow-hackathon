'use client'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../../lib/api'

// Connect PayPal: the owner links their own PayPal business account (PayPal's
// onboarding), customers' payments then land directly in it, and Flow can
// issue policy refunds on their behalf.
export default function PayPalPayments({ status, setStatus }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  // "Change account": show the connect choices while the current account stays connected.
  const [changing, setChanging] = useState(false)
  useEffect(() => { if (new URLSearchParams(window.location.search).get('change') === '1') setChanging(true) }, [])
  const handledReturn = useRef(false)

  // Back from PayPal onboarding: /dashboard/payments?paypal=return&merchantIdInPayPal=...
  useEffect(() => {
    if (handledReturn.current) return
    const q = new URLSearchParams(window.location.search)
    if (q.get('paypal') !== 'return') return
    handledReturn.current = true
    const body = {
      merchantId: q.get('merchantId'),
      merchantIdInPayPal: q.get('merchantIdInPayPal'),
      permissionsGranted: q.get('permissionsGranted'),
      consentStatus: q.get('consentStatus')
    }
    window.history.replaceState(null, '', '/dashboard/payments')
    setBusy('complete')
    api('/dashboard/payments/paypal/complete', { method: 'POST', body }).then(res => {
      setBusy('')
      if (res?.provider) setStatus(res)
      else setError(res?.error || 'Could not finish connecting PayPal')
    })
  }, [setStatus])

  async function connect() {
    setError(''); setBusy('connect')
    const res = await api('/dashboard/payments/paypal/connect', { method: 'POST' })
    if (res?.url) { window.location.href = res.url; return }
    setBusy(''); setError(res?.error || 'Could not start PayPal onboarding')
  }

  async function post(path, label) {
    setError(''); setBusy(label)
    const res = await api(path, { method: 'POST' })
    setBusy('')
    if (res?.provider) { setStatus(res); setChanging(false) }
    else setError(res?.error || 'Something went wrong')
  }

  // Say what disconnecting means before doing it.
  function disconnect() {
    const what = status.environment === 'sandbox'
      ? 'Payments will keep going to Flow\'s demo sandbox account until you pick an account.'
      : 'Customers won\'t be able to pay online until you connect an account again.'
    if (window.confirm(`Disconnect this PayPal account? ${what}`)) post('/dashboard/payments/paypal/disconnect', 'disconnect')
  }

  const sandbox = status.environment === 'sandbox'

  return (
    <div>
      <h1>PayPal</h1>
      <p className="page-lead">Customers pay for bookings with PayPal, straight into your account. Cancellations are refunded automatically by your policy. Flow takes no fee and never holds your money.</p>

      <div className="card" data-tour="paypal">
        <div className="pp-head">
          <span className="pp-mark">Pay<b>Pal</b></span>
          <div className="btn-row">
            {status.connected ? <span className="badge badge-green">Connected</span> : <span className="badge badge-gray">Not connected</span>}
            {sandbox && <span className="badge badge-yellow">Sandbox</span>}
          </div>
        </div>

        {busy === 'complete' && <p className="notice notice-info">Finishing your PayPal connection…</p>}

        {status.connected ? (
          <>
            <p className="pp-text">
              {status.demoAccount && !status.merchantId
                ? <>Payments go to <b>Flow&apos;s demo PayPal sandbox account</b>{status.email ? <> ({status.email})</> : null}, shared by every demo session (fake money). Refunds, invoices and memberships all run there, following your refund policy.</>
                : <>Payments go straight to your PayPal account{status.email ? <> (<b>{status.email}</b>)</> : null}. Cancellations are refunded from it automatically, following your refund policy.</>}
            </p>
            <dl className="pp-facts">
              <div><dt>{status.merchantId ? 'Merchant ID' : 'Account'}</dt><dd>{status.merchantId || 'Flow demo sandbox account'}{status.demoAccount && status.merchantId ? ' · shared demo account' : ''}</dd></div>
              <div><dt>Refunds</dt><dd>{status.canRefund ? 'Flow can refund on your behalf' : 'Not allowed yet'}</dd></div>
            </dl>
            {!status.canRefund && <p className="notice notice-warn">Refund permission wasn&apos;t granted. Reconnect to turn on automatic refunds.</p>}
            {changing ? (
              <div className="pp-change">
                <b>Switch to another account</b>
                <p className="muted small">Your current account stays connected until the new one is.</p>
                <div className="btn-row">
                  <button className="pp-connect" onClick={connect} disabled={!!busy || !status.platformReady}>
                    {busy === 'connect' ? 'Opening PayPal…' : 'Connect your own PayPal'}
                  </button>
                  {status.demoAvailable && !(status.demoAccount && !status.merchantId) && (
                    <button className="btn-secondary" onClick={() => post('/dashboard/payments/paypal/demo', 'demo')} disabled={!!busy}>
                      {busy === 'demo' ? 'Switching…' : 'Use the demo sandbox account'}
                    </button>
                  )}
                  <button className="btn-secondary" onClick={() => { setChanging(false); setError('') }} disabled={!!busy}>Keep current</button>
                </div>
              </div>
            ) : (
              <div className="card-foot">
                <button className="btn-secondary" onClick={() => { setChanging(true); setError('') }} disabled={!!busy}>Change account</button>
                <button className="btn-secondary pp-disconnect" onClick={disconnect} disabled={!!busy}>
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="pp-text">Connect your PayPal business account to get paid for bookings. You log in to PayPal and allow Flow to take payments and issue refunds for you.</p>
            <dl className="pp-facts">
              <div><dt>Right now</dt><dd>Payments go to {status.payoutTo}</dd></div>
            </dl>
            {!status.platformReady && <p className="notice notice-warn">PayPal isn&apos;t set up on this server yet, so connecting is turned off.</p>}
            <div className="card-foot">
              <button className="pp-connect" onClick={connect} disabled={!!busy || !status.platformReady}>
                {busy === 'connect' ? 'Opening PayPal…' : 'Connect PayPal'}
              </button>
              {status.demoAvailable && (
                <button className="btn-secondary" onClick={() => post('/dashboard/payments/paypal/demo', 'demo')} disabled={!!busy}>
                  {busy === 'demo' ? 'Linking…' : 'Use the demo sandbox account'}
                </button>
              )}
            </div>
          </>
        )}
        {error && <p className="notice notice-error" style={{ marginTop: 12 }}>{error}</p>}
      </div>

      <div className="section-title"><h2>How money moves</h2></div>
      <div className="pp-steps">
        <div className="card"><span className="pp-step">1</span><b>Customer pays</b><p className="muted small">The assistant sends a PayPal link. The slot is held while they pay.</p></div>
        <div className="card"><span className="pp-step">2</span><b>You get paid</b><p className="muted small">The booking is confirmed only after PayPal captures the payment, into your account.</p></div>
        <div className="card"><span className="pp-step">3</span><b>Refunds by policy</b><p className="muted small">Cancel early, get more back. The amount comes from your refund tiers, never from the AI.</p></div>
      </div>
    </div>
  )
}
