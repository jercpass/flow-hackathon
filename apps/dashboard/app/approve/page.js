'use client'
import { useEffect, useState } from 'react'
import { demoApi, getDemoToken } from '../../lib/demo'

// Approve in Flow: a payment the customer's
// own AI asked for, above their AI allowance. Only this browser's Flow session
// can see or approve it, so an AI that opens the link can't approve it itself.
export default function Approve() {
  const [id, setId] = useState(null)
  const [signedIn, setSignedIn] = useState(true)
  const [approval, setApproval] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => {
    const a = new URLSearchParams(window.location.search).get('a')
    setId(a)
    if (!getDemoToken()) { setSignedIn(false); return }
    if (!a) { setError('This approval link is missing its id.'); return }
    demoApi(`/approvals/${encodeURIComponent(a)}`).then(d => {
      if (d?.approval) setApproval(d.approval)
      else if (d?.error) setError(d.error)
    })
  }, [])

  async function decide(decision) {
    setBusy(decision); setError('')
    const d = await demoApi(`/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { decision } })
    setBusy('')
    if (d?.approval) setApproval(d.approval)
    else setError(d?.error || 'Something went wrong. Nothing was charged.')
  }

  const pending = approval?.status === 'pending'
  return (
    <main className="approve">
      <div className="approve-brand"><span className="home-mark" aria-hidden="true">F</span>Flow</div>
      <div className="approve-card">
        {!signedIn ? (
          <>
            <h1>Open this in your Flow</h1>
            <p className="muted">Only the browser signed in to your Flow can approve a payment your AI asked for. Open this link there, or start Flow and log in with PayPal first.</p>
            <a className="btn-link" href="/">Go to Flow</a>
          </>
        ) : error && !approval ? (
          <>
            <h1>Can&apos;t show this approval</h1>
            <p className="muted">{error}</p>
            <a className="btn-link" href="/demo/client">Back to Flow</a>
          </>
        ) : !approval ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <div className="approve-kicker">{pending ? 'Your AI is asking to pay' : STATUS[approval.status] || approval.status}</div>
            <div className="approve-amount">{approval.money}</div>
            <dl className="approve-facts">
              <dt>For</dt><dd>{approval.what}</dd>
              {approval.businessName && <><dt>At</dt><dd>{approval.businessName}</dd></>}
              <dt>From</dt><dd>Your saved PayPal ({approval.account})</dd>
              {approval.customerName && <><dt>Signed in as</dt><dd>{approval.customerName}</dd></>}
            </dl>
            {pending ? (
              <>
                <p className="muted small">It&apos;s above the AI spending allowance you set, so it waits for you. Nothing is charged unless you approve. Expires {new Date(approval.expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.</p>
                <div className="approve-actions">
                  <button type="button" className="btn-secondary" onClick={() => decide('decline')} disabled={!!busy}>{busy === 'decline' ? 'Declining…' : 'Decline'}</button>
                  <button type="button" onClick={() => decide('approve')} disabled={!!busy}>{busy === 'approve' ? 'Paying with PayPal…' : `Approve and pay ${approval.money}`}</button>
                </div>
              </>
            ) : (
              <>
                {approval.message && <p className={`notice ${approval.status === 'approved' ? 'notice-ok' : 'notice-info'}`}>{approval.message}</p>}
                {approval.paymentUrl
                  ? <a className="btn-link" href={approval.paymentUrl}>Pay {approval.money} with PayPal</a>
                  : <>
                      <p className="muted small">You can go back to your AI: it can check this with Flow now.</p>
                      <a className="btn-link" href="/demo/client">Open Flow</a>
                    </>}
              </>
            )}
            {error && <p className="notice notice-error">{error}</p>}
          </>
        )}
      </div>
      <p className="approve-foot">PayPal sandbox: fake money only.</p>
    </main>
  )
}

const STATUS = { approved: 'Approved and paid', declined: 'Declined', expired: 'Expired', failed: 'Didn’t go through', working: 'Processing…' }
