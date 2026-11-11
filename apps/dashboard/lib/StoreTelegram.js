'use client'
import { useCallback, useEffect, useState } from 'react'
import { demoApi, ownerBusinessId } from './demo'

// The owner connects this store's own Telegram bot:
// paste the token from @BotFather; Flow checks it, keeps it server-side and
// points the bot at this store. Customers who message it book this store only.
// Customers need no code: opening t.me/<bot> and tapping Start (Telegram sends
// /start) links their chat to this store (core/telegramBot sessionFor).

const shareText = name => `Book ${name || 'with us'} on Telegram: open this, tap Start, and say what you'd like.`

function ShareBot({ link, username, storeName }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard blocked: the link is selectable */ }
  }
  async function share() {
    try { await navigator.share({ title: storeName || `@${username}`, text: shareText(storeName), url: link }) } catch { /* cancelled */ }
  }
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  return (
    <div className="tg-share">
      <b>Share it with your customers</b>
      <div className="inline-form tg-share-row">
        <input readOnly value={link} onFocus={e => e.target.select()} aria-label="Your bot's link" />
        <button type="button" className="btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
      </div>
      <div className="btn-row">
        <a className="btn-link btn-sm" href={`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText(storeName))}`} target="_blank" rel="noreferrer">Share on Telegram</a>
        {canShare && <button type="button" className="btn-secondary btn-sm" onClick={share}>Share…</button>}
        <a className="btn-link btn-sm btn-secondary" href={link} target="_blank" rel="noreferrer">Open the bot</a>
      </div>
      <p className="muted small"><b>How customers connect:</b> they open the link (or search <b>@{username}</b> in Telegram) and tap <b>Start</b>. That&apos;s all: no code and no sign-up. The bot greets them, books this store only, takes PayPal and sends receipts in the chat. Put the link on your website, Instagram bio or a sign at the counter.</p>
    </div>
  )
}

export default function StoreTelegram() {
  const [status, setStatus] = useState(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => demoApi('/telegram').then(d => { if (d && !d.error) setStatus(d) }), [])
  useEffect(() => { load() }, [load])

  const [sessionBiz, setSessionBiz] = useState(null)
  useEffect(() => { demoApi('/session').then(d => setSessionBiz(d?.businessId || null)) }, [])
  const businessId = ownerBusinessId() || sessionBiz
  const mine = (status?.stores || []).find(s => s.businessId === businessId)

  async function connect(e) {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await demoApi('/telegram/bots', { method: 'POST', body: { token: token.trim(), businessId } })
    setBusy(false)
    if (r?.connected) { setToken(''); load() } else setError(r?.error || 'Couldn’t connect that bot.')
  }
  async function disconnect() {
    if (!confirm(`Disconnect @${mine.username} from this store?`)) return
    setBusy(true)
    await demoApi(`/telegram/bots/${mine.botId}`, { method: 'DELETE' })
    setBusy(false); load()
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h2>Your store&apos;s Telegram bot</h2>
      {!status ? <p className="muted">Loading…</p> : mine ? (
        <>
          <p>Connected: <a href={mine.link} target="_blank" rel="noreferrer"><b>@{mine.username}</b></a>. Customers who message it book this store, pay with PayPal and get their receipts there.</p>
          <ShareBot link={mine.link} username={mine.username} storeName={mine.businessName} />
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button type="button" className="btn-secondary btn-sm pp-disconnect" onClick={disconnect} disabled={busy}>Disconnect</button>
          </div>
        </>
      ) : (
        <form onSubmit={connect}>
          <p className="muted small" style={{ marginBottom: 10 }}>
            Give this store its own bot in two minutes: in Telegram, open <b>@BotFather</b>, send <b>/newbot</b>, pick a name, then paste the token it gives you. The token is checked and kept on Flow&apos;s server; it&apos;s never shown again.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" autoComplete="off" placeholder="Bot token from @BotFather" value={token} onChange={e => setToken(e.target.value)} style={{ flex: 1 }} />
            <button type="submit" disabled={busy || token.trim().length < 20}>{busy ? 'Connecting…' : 'Connect'}</button>
          </div>
          {error && <p className="notice notice-error" style={{ marginTop: 10 }}>{error}</p>}
          <p className="muted small" style={{ marginTop: 10 }}>Once it&apos;s connected you get the bot&apos;s link to share. Customers just open it and tap <b>Start</b>: no code, no sign-up.</p>
        </form>
      )}
    </div>
  )
}
