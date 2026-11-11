'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { demoApi, ownerBusinessId } from '../../../lib/demo'
import { iconFor } from '../../../lib/kinds'
import McpConnect from '../../../lib/McpConnect'
import Draft from '../../../lib/SetupDraft'

// Set up a business the judge added (core/addedBusiness): describe it to
// Flow's AI and approve the draft, or let your own AI do it over MCP
// (create_business). Once set up, the customer can book it on every channel.

const EXAMPLE = {
  nails: 'Gel manicure $35, 45 min. Classic pedicure $45, 60 min, $10 deposit when booking. Mia does both, Jo does manicures. Open Tue–Sun 10am–7pm. Cancel 24 hours ahead for a full refund; later than that, no refund.',
  fitness: 'Personal training $70 for 60 min, paid when booking. Group strength class $20 for 45 min, paid at the gym. Coaches: Dee (both) and John K. (classes). Open Mon–Fri 6am–9pm. Full refund if you cancel 12 hours ahead.',
  pets: 'Small dog groom $55, 90 min. Large dog groom $80, 2 hours, 25% deposit. Nail trim $15, 15 min. Groomers: Lola and Ray. Open Mon–Sat 8am–5pm. Cancel 24h ahead for a full refund, 50% if later.'
}
const STARTER = 'Set up my business with Flow.'

export default function SetUpAdded() {
  const router = useRouter()
  const [st, setSt] = useState(null)
  const [how, setHow] = useState('here')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const businessId = typeof window === 'undefined' ? null : ownerBusinessId()

  const load = useCallback(() => {
    if (!businessId) { setSt({ error: 'Add a business first.' }); return }
    demoApi(`/businesses/setup?business=${encodeURIComponent(businessId)}`).then(d => setSt(d || { error: 'Could not load it.' }))
  }, [businessId])
  useEffect(() => { load() }, [load])
  // While your own AI works, watch for its draft and for it being created.
  useEffect(() => {
    if (how !== 'mcp' || !st || st.setupDone || st.error) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [how, st, load])

  async function makeDraft() {
    setBusy('draft'); setError('')
    const r = await demoApi('/businesses/setup/draft', { method: 'POST', body: { businessId, description } })
    setBusy('')
    if (r?.error || !r) { setError(r?.error || 'Could not draft it.'); return }
    load()
  }
  async function create() {
    setBusy('apply'); setError('')
    const r = await demoApi('/businesses/setup/apply', { method: 'POST', body: { businessId } })
    setBusy('')
    if (r?.error || !r) { setError(r?.error || 'Could not create it.'); return }
    load()
  }

  if (!st) return <p className="muted">Loading…</p>
  if (st.error) return <div className="notice notice-info">{st.error} <Link href="/dashboard/add">Add a business</Link></div>
  const b = st.business

  if (st.setupDone) {
    return (
      <div>
        <div className="page-head"><div>
          <h1><span aria-hidden="true">{iconFor(b.kind)}</span> {b.name} is open for booking</h1>
          <p className="page-lead">It&apos;s on the customer&apos;s map near {b.location?.neighborhood}. The customer can find and book it in web chat, by voice, or from their own AI, and pay with PayPal. Bookings land on your calendar here.</p>
        </div></div>
        <div className="card">
          {st.live && <Draft c={st.live} />}
          <div className="card-foot">
            <button type="button" onClick={() => router.push('/demo/client')}>Book it as the customer</button>
            <span className="muted small">Change it any time:</span>
            <button type="button" className="btn-sm btn-secondary" onClick={() => router.push('/dashboard/services')}>Services &amp; prices</button>
            <button type="button" className="btn-sm btn-secondary" onClick={() => router.push('/dashboard/resources')}>Staff</button>
            <button type="button" className="btn-sm btn-secondary" onClick={() => router.push('/dashboard/setup')}>Policies</button>
          </div>
        </div>
      </div>
    )
  }

  const draft = st.draft
  return (
    <div>
      <div className="page-head"><div>
        <h1><span aria-hidden="true">{iconFor(b.kind)}</span> Set up {b.name}</h1>
        <p className="page-lead">{b.kindLabel} near {b.location?.neighborhood}. Tell Flow what you offer and it builds the services, staff, hours and refund rules. You check the draft before anything is created.</p>
      </div></div>

      <section className="card">
        <div className="seg" role="tablist" aria-label="Who sets it up">
          <button type="button" role="tab" aria-selected={how === 'here'} className={how === 'here' ? 'on' : ''} onClick={() => setHow('here')}>With Flow&apos;s AI</button>
          <button type="button" role="tab" aria-selected={how === 'mcp'} className={how === 'mcp' ? 'on' : ''} onClick={() => setHow('mcp')}>With your own AI</button>
        </div>

        {how === 'here' ? (
          <>
            <div className="form-group" style={{ marginTop: 14 }}>
              <label htmlFor="biz-desc">Describe it: services with prices and minutes, who works there, hours, and the cancellation policy</label>
              <textarea id="biz-desc" rows={6} value={description} onChange={e => setDescription(e.target.value)} placeholder={`For example: ${EXAMPLE[b.kind] || EXAMPLE.nails}`} maxLength={4000} />
              <div className="field-hint">Paste a price list if you have one. Any language works.{EXAMPLE[b.kind] ? <> <button type="button" className="link-btn" onClick={() => setDescription(EXAMPLE[b.kind])}>Use the example</button></> : null}</div>
            </div>
            <div className="btn-row">
              <button type="button" onClick={makeDraft} disabled={!!busy || description.trim().length < 20}>{busy === 'draft' ? 'Drafting… (about 10 s)' : draft ? 'Draft again' : 'Draft it with AI'}</button>
            </div>
          </>
        ) : (
          <ol className="mcp-steps" style={{ marginTop: 14 }}>
            <li>
              <b>Connect your AI</b> with {b.name}&apos;s owner link.
              <McpConnect focus="business" compact onOpenFull={() => router.push('/dashboard/ai')} />
            </li>
            <li>
              <b>Ask it in one line.</b>
              <div className="starter">
                <code>{STARTER}</code>
                <button type="button" className="btn-sm btn-secondary" onClick={() => { navigator.clipboard?.writeText(STARTER); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <div className="muted small">Or pick the ready-made prompt <b>Set up my business</b> in your AI app. It asks you about the business, then shows you a draft before creating anything.</div>
            </li>
            <li>
              <b>Watch it here.</b>
              <div className={`mcp-status ${draft?.from === 'mcp' ? 'got' : ''}`}>
                {draft?.from === 'mcp' ? 'Your AI sent a draft (below). Approve it in your AI app, or here.' : <><i className="pulse-dot" /> Waiting for your AI…</>}
              </div>
            </li>
          </ol>
        )}
        {error && <p className="notice notice-warn" style={{ marginTop: 12 }}>{error}</p>}
      </section>

      {draft && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Check the draft</h2>
          <p className="card-lead">{draft.from === 'mcp' ? 'From your own AI.' : "From Flow's AI."} Nothing is created until you say so.</p>
          <Draft c={draft} />
          {draft.notes?.map(n => <p key={n} className="notice notice-info" style={{ marginTop: 12 }}>{n}</p>)}
          <div className="card-foot">
            <button type="button" onClick={create} disabled={!!busy}>{busy === 'apply' ? 'Creating…' : `Create ${b.name}`}</button>
            <span className="muted small">You can change anything later in Services, Staff and Policies.</span>
          </div>
        </section>
      )}
    </div>
  )
}
