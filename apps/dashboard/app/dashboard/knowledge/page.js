'use client'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import Grid from '../../../lib/Grid'
import { TwoLines } from '../../../lib/GridCells'

// Knowledge base: the documents the assistant answers customers' questions from
// (FAQ, policies, aftercare), stored in Claude's Files API. See what's there, test
// a question the way a customer would ask it (Claude's answer and the quotes it
// came from), remove one document or all. The owner's own AI has the same:
// list_knowledge, add_knowledge, ask_knowledge, remove_knowledge.
export default function Knowledge() {
  const [docs, setDocs] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState(null)   // { question, answer, sources: [{ file, quote, page }], documents, model }
  const [pending, setPending] = useState(null) // a chosen file and what Claude will store, before saving
  const [showText, setShowText] = useState(false)

  const load = useCallback(() => api('/dashboard/knowledge').then(d => setDocs(d?.documents || [])), [])
  useEffect(() => { load() }, [load])

  // Choosing a file only shows what Claude will store; Save to Claude stores it.
  async function handleUpload(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { setError('File too large (max 10MB)'); return }
    setUploading(true); setError(''); setResult(null); setPending(null); setShowText(false)
    const reader = new FileReader()
    reader.onload = async () => {
      const body = { filename: file.name, contentType: file.type, fileBase64: reader.result.split(',')[1] }
      const res = await api('/dashboard/knowledge/preview', { method: 'POST', body })
      setUploading(false)
      if (res?.error) setError(res.error)
      else setPending({ body, preview: res })
    }
    reader.readAsDataURL(file)
  }

  async function save() {
    setUploading(true); setError('')
    const res = await api('/dashboard/knowledge', { method: 'POST', body: pending.body })
    setUploading(false)
    if (res?.error) { setError(res.error); return }
    setResult({ ...res, filename: pending.body.filename }); setPending(null); load()
  }

  async function ask(e) {
    e.preventDefault()
    if (question.trim().length < 3) return
    setAsking(true); setError('')
    const r = await api('/dashboard/knowledge/ask', { method: 'POST', body: { question: question.trim() } })
    setAsking(false)
    if (r?.error) setError(r.error)
    else setAnswer(r)
  }

  async function removeDoc(d) {
    if (!confirm(`Remove "${d.file}"? The assistant stops answering from it.`)) return
    const r = await api('/dashboard/knowledge/remove', { method: 'POST', body: { sourceHash: d.sourceHash } })
    if (r?.error) setError(r.error)
    else { setResult({ removed: d.file }); setAnswer(null); load() }
  }

  async function clearAll() {
    if (!confirm('Remove every document? The assistant forgets everything it learned from them.')) return
    await api('/dashboard/knowledge', { method: 'DELETE' })
    setResult({ cleared: true }); setAnswer(null); load()
  }

  const DOC_COLUMNS = [
    { headerName: 'Document', field: 'file', flex: 1, minWidth: 180, cellRenderer: p => <TwoLines a={<b>{p.value}</b>} b={p.data.preview} /> },
    { headerName: 'Kind', field: 'kind', width: 170, valueFormatter: p => `${p.value}${p.data.pages ? `, ${p.data.pages} page${p.data.pages === 1 ? '' : 's'}` : ''}${p.value === 'PDF' ? (p.data.storedAs === 'pdf' ? ' · as a PDF' : ' · as text') : ''}` },
    { headerName: 'Added', field: 'addedAt', width: 160, sort: 'desc', valueFormatter: p => (p.value ? new Date(p.value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—') },
    { headerName: '', colId: 'actions', width: 110, sortable: false, filter: false, resizable: false, cellRenderer: p => <button className="btn-sm btn-secondary saved-pp-remove" onClick={() => removeDoc(p.data)}>Remove</button> }
  ]
  const SOURCE_COLUMNS = [
    { headerName: 'From', field: 'file', width: 190, valueFormatter: p => (p.data.page ? `${p.value}, page ${p.data.page}` : p.value) },
    { headerName: 'Quoted from the document', field: 'quote', flex: 1, minWidth: 260, wrapText: true, autoHeight: true, cellClass: 'grid-wrap-text' }
  ]

  return (
    <div>
      <h1>Knowledge base</h1>
      <p className="page-lead">Documents about your business (FAQ, policies, aftercare), stored with Claude. When a customer asks, Claude reads them whole and answers, on every channel, quoting where it found the answer. Prices and services come from Services &amp; prices, not from here.</p>

      <div className="section-title"><h2>What the assistant knows</h2></div>
      {docs === null ? <div className="skel skel-block" aria-label="Loading" /> : docs.length ? (
        <div className="grid-wrap">
          <Grid rowData={docs} columnDefs={DOC_COLUMNS} domLayout="autoHeight" rowHeight={56} getRowId={r => r.data.sourceHash || r.data.file} />
        </div>
      ) : <div className="empty">Nothing yet. Add a document below, or ask your own AI to add_knowledge.</div>}

      <div className="card kb-ask">
        <h2>Test a question</h2>
        <p className="card-lead">Ask what a customer might ask. You see the answer they&apos;d get, and the lines it came from.</p>
        <form className="inline-form" onSubmit={ask}>
          <input value={question} onChange={e => setQuestion(e.target.value)} placeholder='e.g. "Is there parking?"' maxLength={200} disabled={!docs?.length} />
          <button type="submit" disabled={asking || question.trim().length < 3 || !docs?.length}>{asking ? 'Reading…' : 'Ask'}</button>
        </form>
        {answer && (answer.answer ? (
          <>
            <div className="kb-answer"><b>Answer</b>{answer.model ? <span className="muted small"> · {answer.model} read {answer.documents} document{answer.documents === 1 ? '' : 's'}</span> : null}<p>{answer.answer}</p></div>
            {answer.sources.length > 0 && <div className="grid-wrap" style={{ marginTop: 12 }}><Grid rowData={answer.sources} columnDefs={SOURCE_COLUMNS} domLayout="autoHeight" getRowId={r => `${r.data.file}-${r.data.quote.slice(0, 40)}`} /></div>}
          </>
        ) : <p className="muted small" style={{ marginTop: 10 }}>Your documents don&apos;t cover this yet: add one that does.</p>)}
      </div>

      <div className="card">
        <h2>Add a document</h2>
        <p className="card-lead">PDF, Word, Excel, text or a photo, up to 10 MB. You see what Claude will store before it&apos;s saved. A PDF with real text is kept as text (cheaper for Claude to read); a scan stays a PDF so Claude can see it.</p>
        {pending ? (
          <div className="kb-pending">
            <b>{pending.preview.file}</b>
            <div className="muted small">
              {pending.preview.from} → {pending.preview.storedAs === 'pdf' ? 'kept as a PDF' : 'saved as text'}
              {pending.preview.tokens ? <> · Claude reads about <b>{pending.preview.tokens.toLocaleString('en-US')}</b> tokens a question{pending.preview.pdfTokens ? ` (as a PDF: ${pending.preview.pdfTokens.toLocaleString('en-US')})` : ''}</> : null}
            </div>
            {pending.preview.text && <button type="button" className="link-btn" onClick={() => setShowText(s => !s)}>{showText ? 'Hide the text' : 'See the text'}</button>}
            {showText && <pre className="doc-text kb-pending-text">{pending.preview.text}</pre>}
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button type="button" onClick={save} disabled={uploading}>{uploading ? 'Saving…' : 'Save to Claude'}</button>
              <button type="button" className="btn-secondary" onClick={() => { setPending(null); setShowText(false) }} disabled={uploading}>Cancel</button>
            </div>
          </div>
        ) : (
          <label className={`dropzone ${uploading ? 'busy' : ''}`}>
            <input type="file" accept=".pdf,.docx,.xlsx,.txt,.csv,.md,.jpg,.jpeg,.png,.webp" onChange={handleUpload} disabled={uploading} hidden />
            <span className="dropzone-icon" aria-hidden="true">📄</span>
            <b>{uploading ? 'Reading your document…' : 'Choose a file'}</b>
            <span className="muted small">{uploading ? 'This takes a few seconds.' : 'PDF, Word, Excel, text, JPG or PNG'}</span>
          </label>
        )}
        {result?.added && <p className="notice notice-ok" style={{ marginTop: 12 }}>Added {result.filename || 'your file'}. Claude answers from it now.</p>}
        {result?.skipped && <p className="notice notice-info" style={{ marginTop: 12 }}>That file was already uploaded.</p>}
        {result?.removed && <p className="notice notice-ok" style={{ marginTop: 12 }}>Removed {result.removed}.</p>}
        {result?.cleared && <p className="notice notice-ok" style={{ marginTop: 12 }}>All documents were removed.</p>}
        {error && <p className="notice notice-error" style={{ marginTop: 12 }}>{error}</p>}
      </div>

      {docs?.length > 0 && (
        <div className="card danger-zone">
          <div>
            <b>Remove all documents</b>
            <p className="muted small">The assistant forgets everything it learned from them.</p>
          </div>
          <button className="btn-danger" onClick={clearAll}>Remove all</button>
        </div>
      )}
    </div>
  )
}
