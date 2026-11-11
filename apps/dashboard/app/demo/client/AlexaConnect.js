'use client'
import { useCallback, useEffect, useState } from 'react'
import { demoApi } from '../../../lib/demo'

// "Book with Alexa": the skill "Flow Bookings" links to this demo session when
// you say its 4-digit code (core/alexa). Alexa is outside our UI, so the steps
// are spelled out, and the page updates by itself once Alexa is linked, like
// the Telegram page. Plan and setup: docs/alexa/README.md

const TRY = [
  'Book me a haircut tomorrow at 11',
  'Is there a massage place near me this weekend?',
  'What are my bookings?',
  'Cancel my next booking (it quotes the refund first)'
]

/** The session's Alexa code and link status; checks again every few seconds until linked. */
export function useAlexa() {
  const [alexa, setAlexa] = useState(null)
  const load = useCallback(() => demoApi('/alexa').then(d => { if (d && !d.error) setAlexa(d) }), [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!alexa?.configured || alexa.linked) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [alexa?.configured, alexa?.linked, load])
  return [alexa, load]
}

// The skill is in Amazon's beta, which has no public link: each tester's Amazon
// email is added (core/alexaBeta), then their invitation link works for them.
function BetaSignup({ beta, linked, onAdded }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const added = beta.added || []

  async function add(e) {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await demoApi('/alexa/beta', { method: 'POST', body: { email } })
    setBusy(false)
    if (r?.ok) { setEmail(''); onAdded() } else setError(r?.message || 'That didn’t work. Try again.')
  }

  return (
    <div className="card alexa-beta">
      <h2>{linked ? 'Add another Amazon account' : 'Use your own Echo or Alexa app'}</h2>
      <p className="muted small">{SKILL_TESTING} Enter the email of the Amazon account {linked ? 'that should get it' : 'your Alexa uses'}, and Flow adds it as a tester.</p>
      {/* The invitation link only works once the account is a tester, so it shows under each added email, not here. */}
      <ol className="alexa-beta-steps">
        <li><b>Join the test:</b> enter the email of your Amazon account below (the one on your Echo or Alexa app). Your invitation link appears here; open it on that account and tap <i>Accept</i>.</li>
        <li><b>Talk:</b> say &ldquo;Alexa, open Flow Bookings&rdquo;, then the code on this page.</li>
      </ol>
      {added.map(a => (
        <div key={a.email + a.at} className="alexa-beta-done">
          <span className="tg-check" aria-hidden="true">✓</span>
          <div>
            <b>{a.email} is on the tester list.</b>
            <div className="muted small">On the phone with that Amazon account, open the invitation and tap Accept (Amazon may email it too), then say “Alexa, open Flow Bookings” and the code.</div>
            {a.invitationUrl && <a className="btn-link btn-sm" href={a.invitationUrl} target="_blank" rel="noreferrer">Open the invitation</a>}
          </div>
        </div>
      ))}
      <form className="inline-form alexa-beta-form" onSubmit={add}>
        <input type="email" required placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} aria-label="Email of your Amazon account" />
        <button className="btn-sm" disabled={busy || !email}>{busy ? 'Adding…' : added.length ? 'Add another' : 'Add me'}</button>
      </form>
      {error && <p className="notice notice-warn" style={{ marginTop: 8 }}>{error}</p>}
      <p className="muted small" style={{ marginTop: 8 }}>Flow sends the email to Amazon only to add you to this skill&apos;s beta, and keeps a masked copy (like j***@gmail.com) for this session.</p>
    </div>
  )
}

const SKILL_TESTING = 'Flow Bookings is in testing on Alexa, so it works on Amazon accounts on its tester list.'

// "4824" → "4 8 2 4", and how to say it: "four eight two four".
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const spoken = code => String(code).split('').map(d => WORDS[d]).join(' ')

export default function AlexaConnect({ onUseWeb, onUseVoice }) {
  const [alexa, load] = useAlexa()
  const [busy, setBusy] = useState(false)

  async function unlink() {
    if (!confirm('Unlink Alexa from this demo session? Alexa will ask for the code again.')) return
    setBusy(true)
    await demoApi('/alexa', { method: 'DELETE' })
    setBusy(false)
    load()
  }

  return (
    <div className="client-page">
      <h1>Book with Alexa</h1>
      <p className="client-lead">Talk to Flow on an Echo or in the Alexa app. It&apos;s the same assistant as the web chat and the voice assistant, and your bookings, inbox and timeline show up here as you go.</p>
      <div className="try-web">
        <span><b>No Alexa handy?</b> Talk to the same assistant right here in your browser.</span>
        <button className="btn-sm" onClick={onUseVoice}>Try the voice assistant</button>
        <button className="btn-sm btn-secondary" onClick={onUseWeb}>Web chat</button>
      </div>

      {!alexa ? <p className="muted">Loading…</p> : !alexa.configured ? (
        <div className="card">
          <p className="notice notice-warn">The Alexa skill isn&apos;t set up on this server yet.</p>
          <p className="muted small" style={{ marginTop: 10 }}>Setup: create the skill and save its Skill ID in <code>/flowhq/alexa/skillId</code> (see docs/alexa/README.md). Until then, the voice assistant here works the same way.</p>
        </div>
      ) : alexa.linked ? (
        <div className="card tg-linked">
          <div className="tg-linked-row">
            <span className="tg-check" aria-hidden="true">✓</span>
            <div>
              <b>Alexa is linked</b>
              <div className="muted small">You&apos;re booking as {alexa.linked.as || 'you'} in this demo. Say “Alexa, open {alexa.skill}” any time.</div>
            </div>
          </div>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="btn-danger" onClick={unlink} disabled={busy}>{busy ? 'Unlinking…' : 'Unlink'}</button>
          </div>
        </div>
      ) : (
        <div className="card tg-connect">
          <ol className="tg-steps">
            <li>
              <b>Open Alexa</b>
              <p className="muted small">An Echo, or the Alexa app on your phone, signed in with an Amazon account that has {alexa.skill}. {alexa.beta?.available ? 'Not a tester yet? Add your Amazon account below.' : 'The skill is in testing, so it works on accounts invited as testers.'}</p>
            </li>
            <li>
              <b>Say “Alexa, open {alexa.skill}”</b>
              <p className="muted small">Alexa asks for your code.</p>
            </li>
            <li>
              <b>Say “my code is {spoken(alexa.code)}”</b>
              <p className="muted small">That links Alexa to you in this demo session. This page updates by itself.</p>
              <span className="tg-wait alexa-wait"><i /> Waiting for Alexa…</span>
            </li>
          </ol>
          <div className="alexa-code-box">
            <span className="muted small">Your code</span>
            <div className="alexa-code" aria-label={`Code ${spoken(alexa.code)}`}>{String(alexa.code).split('').map((d, i) => <span key={i}>{d}</span>)}</div>
            <span className="muted small">Works until this session ends</span>
          </div>
        </div>
      )}

      {/* Shown linked or not: a linked visitor may invite another account, or need their invitation link again. */}
      {alexa?.configured && alexa.beta?.available && <BetaSignup beta={alexa.beta} linked={!!alexa.linked} onAdded={load} />}

      {alexa?.configured && (
        <div className="tg-grid">
          <div className="card">
            <h2>Things to try</h2>
            <ul className="tg-list">{TRY.map(t => <li key={t}>“{t}”</li>)}</ul>
          </div>
          <div className="card">
            <h2>Good to know</h2>
            <ul className="tg-list">
              <li>With saved PayPal and within your AI spending limit, it books and pays in one go. Otherwise the PayPal link goes to your inbox.</li>
              <li>Alexa is a real service outside this demo: what you say passes through Amazon. Use fake details only.</li>
              <li>Ending the session unlinks Alexa, and so does saying &ldquo;Alexa, ask Flow Bookings to disconnect my account&rdquo;. No Echo? The voice assistant here works the same way.</li>
            </ul>
          </div>
        </div>
      )}

    </div>
  )
}
