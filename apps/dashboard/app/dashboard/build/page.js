'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { demoApi } from '../../../lib/demo'
import { api } from '../../../lib/api'
import { tourEvent } from '../../../lib/tourSteps'
import McpConnect from '../../../lib/McpConnect'
import Draft from '../../../lib/SetupDraft'

// Guided demo, act 1: set Willow & Co. up with AI. The description and the
// salon's documents go to the same AI setup a real owner would use; the owner
// checks the draft and creates the salon; the FAQ and policy then become the
// assistant's knowledge base. If the AI can't help, the ready-made salon is
// one click away.
// Or the owner's own AI does it over MCP: this
// page then follows along live.

const USE = { setup: 'AI setup', knowledge: 'Knowledge base', both: 'Setup + knowledge' }

export default function BuildWithAI() {
  const [state, setState] = useState(null)
  const [description, setDescription] = useState('')
  const [picked, setPicked] = useState([])
  const [draft, setDraft] = useState(null)
  const [created, setCreated] = useState(null)       // { source, config, notes }
  const [knowledge, setKnowledge] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)           // { text, fallback }
  const [preview, setPreview] = useState(null)
  const [how, setHow] = useState('here')             // here | mcp (the owner's own AI)
  const [toStore, setToStore] = useState(null)       // what each document becomes in Claude, before saving
  const [storedText, setStoredText] = useState(null) // "See the text": the exact text Claude will keep

  // Step 4 shows what Claude will store before anything is saved.
  const knowKey = state ? state.docs.filter(d => d.use !== 'setup' && picked.includes(d.id)).map(d => d.id).join(',') : ''
  const learned = !!knowledge?.docs?.length
  useEffect(() => {
    if (!created || learned || !knowKey) { setToStore(null); return }
    let gone = false
    setToStore(null)
    demoApi('/setup/learn/preview', { method: 'POST', body: { docIds: knowKey.split(',') } }).then(d => { if (!gone) setToStore(d?.documents ? d : { error: d?.error || 'Could not read the documents.' }) })
    return () => { gone = true }
  }, [created, learned, knowKey])

  useEffect(() => {
    demoApi('/setup').then(d => {
      if (!d || d.error) { setError({ text: d?.error || 'Could not load the setup.' }); return }
      setState(d)
      setDescription(d.description)
      setPicked(d.docs.map(x => x.id))
      setDraft(d.draft)
      setKnowledge(d.knowledge)
      if (d.draft?.from === 'mcp') setHow('mcp')
      if (d.setupDone && d.mode === 'guided') setCreated({ source: d.setupSource, config: d.salon, notes: [] })
    })
  }, [])

  // Live: whatever the owner's own AI does over MCP (draft, create, learn)
  // shows up here and moves the tour on, like doing it on this page.
  const live = useRef({})
  useEffect(() => { live.current = { created, knowledge, draft } })
  useEffect(() => {
    const t = setInterval(async () => {
      const { created: c, knowledge: k, draft: dr } = live.current
      if (c && k?.docs?.length) return
      const d = await demoApi('/setup')
      if (!d || d.error) return
      if (!c && d.draft && JSON.stringify(d.draft) !== JSON.stringify(dr)) { setDraft(d.draft); if (d.draft.from === 'mcp') setHow('mcp'); tourEvent('setup-generated') }
      if (!c && d.setupDone) { setCreated({ source: d.setupSource, config: d.salon, notes: [] }); tourEvent('setup-generated'); tourEvent('setup-applied') }
      if (!k?.docs?.length && d.knowledge?.docs?.length) { setKnowledge(d.knowledge); tourEvent('setup-learned') }
    }, 4000)
    return () => clearInterval(t)
  }, [])

  if (!state) return error ? <p className="notice notice-error">{error.text}</p> : <p className="muted">Loading…</p>

  const docs = state.docs
  const setupDocs = docs.filter(d => d.use !== 'knowledge' && picked.includes(d.id))
  const knowDocs = docs.filter(d => d.use !== 'setup' && picked.includes(d.id))
  const toggle = id => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))

  async function generate() {
    setError(null); setBusy('generate')
    const d = await demoApi('/setup/generate', { method: 'POST', body: { description, docIds: picked } })
    setBusy('')
    if (!d) return
    if (d.error) { setError({ text: d.error, fallback: !!d.fallback || !!d.limit }); return }
    setDraft(d.draft)
    tourEvent('setup-generated')
  }

  async function create(source) {
    setError(null); setBusy(source)
    const d = await demoApi('/setup/apply', { method: 'POST', body: { source } })
    setBusy('')
    if (!d) return
    if (d.error) { setError({ text: d.error, fallback: true }); return }
    setCreated({ source: d.source, config: d.config, notes: d.notes || [] })
    if (source === 'template') setDraft(null)
    tourEvent('setup-generated')
    tourEvent('setup-applied')
  }

  async function learn() {
    setError(null); setBusy('learn')
    const d = await demoApi('/setup/learn', { method: 'POST', body: { docIds: knowDocs.map(x => x.id) } })
    setBusy('')
    if (!d) return
    if (d.error) { setError({ text: d.error }); return }
    setKnowledge(d)
    tourEvent('setup-learned')
  }

  const shown = created?.config || draft
  return (
    <div className="build">
      <div className="page-head">
        <h1>Set up your salon with AI</h1>
        {created && <span className="badge badge-green">Salon created</span>}
      </div>
      <p className="page-lead">Describe the business and add its documents. The AI drafts the services, prices, staff, hours and refund rules; you check them and create the salon. Nothing to type in by hand.</p>

      <div className="build-grid">
        <section className="card build-step build-describe" data-tour="describe">
          <StepHead n={1} title="Describe your business" done={!!draft || !!created} />
          <textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} maxLength={1500} disabled={!!created} aria-label="Business description" />
          <p className="field-hint">Prefilled for Willow &amp; Co. Edit it if you like: the AI only uses what&apos;s written here and in the documents.</p>
        </section>

        <aside className="card build-docs" data-tour="docs">
          <h2>Sample documents</h2>
          <p className="card-lead">Willow &amp; Co.&apos;s own files, ready to use. Open one to read it.</p>
          {docs.map(d => (
            <div key={d.id} className={`doc-row ${picked.includes(d.id) ? 'on' : ''}`}>
              <span className={`doc-icon ${d.kind}`} aria-hidden="true">{d.kind === 'pdf' ? 'PDF' : 'TXT'}</span>
              <div className="doc-body">
                <button type="button" className="doc-title" onClick={() => setPreview(d)}>{d.title}</button>
                <div className="muted small">{d.summary}</div>
                <span className="doc-use">{USE[d.use]}</span>
              </div>
              <label className="check doc-pick" title="Use this document">
                <input type="checkbox" checked={picked.includes(d.id)} onChange={() => toggle(d.id)} disabled={!!created && d.use === 'setup'} /> Use
              </label>
            </div>
          ))}
        </aside>

        <div className="build-steps">
          <section className="card build-step" data-tour="generate">
            <StepHead n={2} title="Let the AI draft it" done={!!draft || !!created} />
            {!created && (
              <div className="seg" role="tablist" aria-label="Where the AI works">
                <button type="button" role="tab" aria-selected={how === 'here'} className={how === 'here' ? 'on' : ''} onClick={() => setHow('here')}>Here</button>
                <button type="button" role="tab" aria-selected={how === 'mcp'} className={how === 'mcp' ? 'on' : ''} onClick={() => setHow('mcp')} data-tour="mcp-tab">From your own AI</button>
              </div>
            )}
            {!created && how === 'mcp' ? (
              <McpSetup draft={draft} />
            ) : (
              <>
                <p className="card-lead">Reads the description and {setupDocs.length ? setupDocs.map(d => d.title).join(', ') : 'no documents'}. The FAQ goes to the knowledge base in step 4.</p>
                {!created && (
                  <div className="btn-row">
                    <button type="button" onClick={generate} disabled={!!busy || !description.trim()}>{busy === 'generate' ? 'Drafting… (about 10 s)' : draft ? 'Draft again' : 'Generate draft'}</button>
                    <button type="button" className="btn-secondary" onClick={() => create('template')} disabled={!!busy}>{busy === 'template' ? 'Creating…' : 'Use the ready-made salon'}</button>
                  </div>
                )}
              </>
            )}
            {created && <p className="saved">{created.source === 'template' ? 'Created from the ready-made salon' : created.source === 'mcp' ? 'Created by your own AI (MCP)' : 'Drafted by the AI'}</p>}
            {error && (
              <div className="notice notice-warn build-error">
                {error.text}
                {error.fallback && !created && <div style={{ marginTop: 8 }}><button type="button" className="btn-sm" onClick={() => create('template')} disabled={!!busy}>Use the ready-made salon</button></div>}
              </div>
            )}
          </section>

          {(draft || created) && (
            <section className="card build-step" data-tour="draft">
              <StepHead n={3} title={created ? 'Your salon' : 'Check the draft'} done={!!created} />
              {shown ? <Draft c={shown} /> : <p className="card-lead">Your salon is set up. See <Link href="/dashboard/services">Services &amp; prices</Link>, <Link href="/dashboard/resources">Staff</Link> and <Link href="/dashboard/setup">Policies</Link>.</p>}
              {created?.notes?.map(n => <p key={n} className="notice notice-info" style={{ marginTop: 12 }}>{n}</p>)}
              {!created && (
                <div className="card-foot">
                  <button type="button" onClick={() => create(draft?.from === 'mcp' ? 'mcp' : 'ai')} disabled={!!busy}>{busy === 'ai' || busy === 'mcp' ? 'Creating…' : 'Create my salon'}</button>
                  <span className="muted small">You can change anything later in Services, Staff and Policies.</span>
                </div>
              )}
            </section>
          )}

          {created && (
            <section className="card build-step" data-tour="learn">
              <StepHead n={4} title="Teach it your FAQ" done={!!knowledge?.docs?.length} />
              <p className="card-lead">Claude keeps the documents and reads them whole when a customer asks, answering in your own words and quoting where it found them. Check what it will store, then save.</p>
              {knowledge?.docs?.length ? (
                <>
                  <ul className="learned">
                    {knowledge.docs.map(d => (
                      <li key={d.id}><b>{d.title}</b> · {d.fallback ? 'kept as plain FAQ text' : d.already ? 'already stored' : `stored in Claude ✓${d.pages ? ` (${d.pages} page${d.pages === 1 ? '' : 's'})` : ''}`}</li>
                    ))}
                  </ul>
                  {knowledge.fallback && <p className="notice notice-info">Claude was busy, so the documents were kept as plain FAQ text. The assistant still answers from them.</p>}
                  {!knowledge.fallback && <TryKnowledge />}
                </>
              ) : (
                <>
                  {knowDocs.length > 0 && (!toStore
                    ? <p className="muted small">Reading the documents…</p>
                    : toStore.error ? <p className="notice notice-error">{toStore.error}</p> : (
                      <ul className="kb-preview">
                        {toStore.documents.map(d => (
                          <li key={d.id}>
                            <div>
                              <b>{d.title}</b>
                              <div className="muted small">{d.error || <>{d.from} → {d.storedAs === 'pdf' ? 'kept as a PDF' : 'saved as text'}{d.tokens ? <> · Claude reads about <b>{d.tokens.toLocaleString('en-US')}</b> tokens a question{d.pdfTokens ? ` (as a PDF: ${d.pdfTokens.toLocaleString('en-US')})` : ''}</> : null}</>}</div>
                            </div>
                            {d.text && <button type="button" className="link-btn" onClick={() => setStoredText(d)}>See the text</button>}
                          </li>
                        ))}
                      </ul>
                    ))}
                  <div className="btn-row">
                    <button type="button" onClick={learn} disabled={!!busy || !knowDocs.length}>{busy === 'learn' ? 'Saving…' : 'Save to Claude'}</button>
                    <span className="muted small">{knowDocs.length ? knowDocs.map(d => d.title).join(' + ') : 'Pick the FAQ or the policy on the right'}</span>
                  </div>
                </>
              )}
            </section>
          )}

          {created && knowledge?.docs?.length > 0 && (
            <section className="card build-done">
              <h2>Willow &amp; Co. is live</h2>
              <p className="card-lead">Customers can book and pay now. Next: see where the money goes, then book as the customer.</p>
              <div className="btn-row">
                <Link href="/dashboard/payments" className="btn-link">PayPal →</Link>
                <Link href="/demo/client" className="btn-link setup-go">Book as the customer</Link>
              </div>
            </section>
          )}
        </div>
      </div>

      {preview && <DocPreview doc={preview} onClose={() => setPreview(null)} />}
      {storedText && <StoredText doc={storedText} onClose={() => setStoredText(null)} />}
    </div>
  )
}

const STARTER = 'Set up my salon with Flow.'

// "From your own AI": connect, ask in one line, watch. Flow hands the AI the
// description, the documents and the steps (MCP instructions + a ready-made
// prompt), so the judge doesn't need to know anything about MCP.
function McpSetup({ draft }) {
  const router = useRouter()
  const [copied, setCopied] = useState(false)
  const fromAi = draft?.from === 'mcp'
  return (
    <div className="mcp-setup">
      <ol className="mcp-steps">
        <li>
          <b>Connect your AI.</b> Add the owner link to your AI app: Claude Desktop, Claude Code, Cursor, VS Code, or Claude.ai and ChatGPT on the hosted demo.
          <McpConnect focus="business" compact onOpenFull={() => router.push('/dashboard/ai')} />
        </li>
        <li>
          <b>Ask it in one line.</b>
          <div className="starter">
            <code>{STARTER}</code>
            <button type="button" className="btn-sm btn-secondary" onClick={() => { navigator.clipboard?.writeText(STARTER); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <div className="muted small">Or pick the ready-made prompt <b>Set up my salon</b> in your AI app.</div>
        </li>
        <li>
          <b>Watch it here.</b>
          <div className={`mcp-status ${fromAi ? 'got' : ''}`}>
            {fromAi ? 'Your AI sent a draft (below). Approve it in your AI app, or here.' : <><i className="pulse-dot" /> Waiting for your AI…</>}
          </div>
        </li>
      </ol>
      <p className="muted small">Flow gives your AI the description and all four documents. It shows you a draft and asks before creating anything; then you can change prices, staff, hours or refunds just by asking. Claude.ai and ChatGPT need the hosted link; this local one works with Claude Desktop, Claude Code, Cursor and VS Code.</p>
    </div>
  )
}

function StepHead({ n, title, done }) {
  return (
    <div className="step-head">
      <span className={`step-n ${done ? 'done' : ''}`} aria-hidden="true">{done ? '✓' : n}</span>
      <h2>{title}</h2>
    </div>
  )
}

// "See the text": exactly what Claude will keep for this document.
function StoredText({ doc, onClose }) {
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`What Claude stores for ${doc.title}`} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal doc-modal">
        <div className="doc-modal-head">
          <div>
            <h2>{doc.title}</h2>
            <div className="muted small">What Claude stores · {doc.from} → saved as text{doc.tokens ? ` · about ${doc.tokens.toLocaleString('en-US')} tokens a question` : ''}</div>
          </div>
          <button type="button" className="btn-sm" onClick={onClose}>Close</button>
        </div>
        <pre className="doc-text">{doc.text}</pre>
      </div>
    </div>
  )
}

// "Try it": ask what a customer would, and see Claude's answer with the lines it came from.
function TryKnowledge() {
  const [q, setQ] = useState('Is there parking?')
  const [busy, setBusy] = useState(false)
  const [r, setR] = useState(null)
  async function ask(e) {
    e.preventDefault()
    if (q.trim().length < 3) return
    setBusy(true)
    setR(await api('/dashboard/knowledge/ask', { method: 'POST', body: { question: q.trim() } }))
    setBusy(false)
  }
  return (
    <div className="kb-try">
      <b>Try it</b>
      <form className="inline-form" onSubmit={ask}>
        <input value={q} onChange={e => setQ(e.target.value)} maxLength={200} aria-label="A question a customer might ask" />
        <button type="submit" className="btn-sm" disabled={busy || q.trim().length < 3}>{busy ? 'Reading…' : 'Ask'}</button>
      </form>
      {r?.error && <p className="notice notice-error">{r.error}</p>}
      {r && !r.error && (r.answer ? (
        <div className="kb-answer">
          <p style={{ margin: 0 }}>{r.answer}</p>
          {r.sources?.map((s, i) => <div key={i} className="muted small" style={{ marginTop: 6 }}>“{s.quote}” · {s.file}{s.page ? `, page ${s.page}` : ''}</div>)}
        </div>
      ) : <p className="muted small">The documents don&apos;t cover that.</p>)}
    </div>
  )
}

function DocPreview({ doc, onClose }) {
  const file = `/demo/docs/${doc.id}.${doc.kind === 'pdf' ? 'pdf' : 'txt'}`
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={doc.title} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal doc-modal">
        <div className="doc-modal-head">
          <div>
            <h2>{doc.title}</h2>
            <div className="muted small">{doc.filename} · used for {USE[doc.use].toLowerCase()}</div>
          </div>
          <div className="btn-row">
            <a className="btn-link btn-sm setup-go" href={file} download={doc.filename}>Download</a>
            <button type="button" className="btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
        {doc.kind === 'pdf'
          ? <iframe title={doc.title} src={file} className="doc-frame" />
          : <pre className="doc-text">{doc.text}</pre>}
      </div>
    </div>
  )
}
