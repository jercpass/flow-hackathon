'use client'
import { useEffect, useState } from 'react'

// A page that failed to open. Most often its code didn't download (a slow or
// dropped connection, or a tab opened before a new deploy): reload once by
// itself, then offer a retry instead of a blank "This page couldn't load".
const KEY = 'bp_chunk_retry'
const isChunkError = e => /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(`${e?.name} ${e?.message}`)

export default function PageError({ error, reset }) {
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    if (!isChunkError(error)) return
    // One automatic reload per page within a minute, so a real outage can't loop.
    let last = {}
    try { last = JSON.parse(sessionStorage.getItem(KEY) || '{}') } catch {}
    if (last.path === window.location.pathname && Date.now() - last.at < 60_000) return
    try { sessionStorage.setItem(KEY, JSON.stringify({ path: window.location.pathname, at: Date.now() })) } catch {}
    setRetrying(true)
    window.location.reload()
  }, [error])

  return (
    <div className="page-error">
      <h2>{retrying ? 'Opening the page again…' : 'This page didn’t finish loading'}</h2>
      {!retrying && (
        <>
          <p className="muted">The connection dropped while it loaded. Nothing in your session was lost.</p>
          <div className="page-error-actions">
            <button type="button" onClick={() => reset()}>Try again</button>
            <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>Reload the page</button>
          </div>
        </>
      )}
    </div>
  )
}
