'use client'
import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { demoApi } from '../../../lib/demo'

// "Book from Telegram": link the visitor's Telegram to this demo session with a
// t.me start link (button, or QR to scan with a phone), then they chat with the
// same assistant there. Telegram is outside our UI, so the steps are spelled
// out here. Stores the owner gave their own bot are listed too: those book that
// store only.

const TRY = [
  'Book me a haircut',
  'Is there a massage place near me this weekend?',
  'Send a 🎙 voice note or a 📷 photo of a style you want',
  'Cancel my booking (it quotes the refund first)'
]

export default function TelegramConnect({ onUseWeb }) {
  const [info, setInfo] = useState(null)
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => demoApi('/telegram').then(d => { if (d && !d.error) setInfo(d) }), [])
  useEffect(() => { load() }, [load])
  // Waiting for the visitor to tap Start in Telegram: check every few seconds.
  useEffect(() => {
    if (!info?.configured || info.linked) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [info?.configured, info?.linked, load])
  useEffect(() => {
    if (!info?.link) return
    QRCode.toDataURL(info.link, { margin: 1, width: 360, color: { dark: '#111827', light: '#ffffff' } }).then(setQr).catch(() => setQr(''))
  }, [info?.link])

  async function unlink() {
    if (!confirm('Disconnect Telegram from this demo session?')) return
    setBusy(true)
    await demoApi('/telegram', { method: 'DELETE' })
    setBusy(false)
    load()
  }

  return (
    <div className="client-page">
      <h1>Book from Telegram</h1>
      <p className="client-lead">Use Flow in the Telegram app on your phone or computer. It&apos;s the same assistant as the web chat, and your bookings, inbox and timeline show up here as you go.</p>
      <div className="try-web">
        <span><b>No phone handy?</b> The same assistant works right here in your browser.</span>
        <button className="btn-sm" onClick={onUseWeb}>Try the web chat</button>
      </div>

      {info?.stores?.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Stores with their own bot</h2>
          <ul className="tg-stores">
            {info.stores.map(s => (
              <li key={s.botId}>
                <div><b>{s.businessName || 'A store in this demo'}</b><div className="muted small">@{s.username} books this store only</div></div>
                <a className="tg-btn" href={s.link} target="_blank" rel="noreferrer">Open</a>
              </li>
            ))}
          </ul>
          <p className="muted small">Your first message links the chat to this demo session.</p>
        </div>
      )}

      {!info ? <p className="muted">Loading…</p> : !info.configured ? (
        <div className="card">
          <p className="notice notice-warn">Flow&apos;s own Telegram bot isn&apos;t set up on this server yet.{info.stores?.length ? ' The store bots above work.' : ' On the Business side, AI & channels, a store can connect its own bot.'}</p>
          <p className="muted small" style={{ marginTop: 10 }}>Setup: create a bot with @BotFather, then set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_BOT_USERNAME</code> in <code>apps/lambda/.env</code>.</p>
        </div>
      ) : info.linked ? (
        <div className="card tg-linked">
          <div className="tg-linked-row">
            <span className="tg-check" aria-hidden="true">✓</span>
            <div>
              <b>Telegram is linked</b>
              <div className="muted small">{info.linked.username ? `@${info.linked.username}` : info.linked.firstName || 'Your Telegram'} is linked to your bookings in this demo.</div>
            </div>
          </div>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <a className="tg-btn" href={`https://t.me/${info.bot}`} target="_blank" rel="noreferrer">Open the chat</a>
            <button className="btn-danger" onClick={unlink} disabled={busy}>{busy ? 'Unlinking…' : 'Unlink'}</button>
          </div>
        </div>
      ) : (
        <div className="card tg-connect">
          <ol className="tg-steps">
            <li>
              <b>Open the bot in Telegram</b>
              <p className="muted small">@{info.bot}. On a computer? Scan the code with your phone&apos;s camera instead.</p>
              <a className="tg-btn" href={info.link} target="_blank" rel="noreferrer">Open in Telegram</a>
            </li>
            <li>
              <b>Tap Start</b>
              <p className="muted small">That links Telegram to you in this demo session. This page updates by itself.</p>
              <span className="tg-wait"><i /> Waiting for you to tap Start…</span>
            </li>
            <li>
              <b>Chat like you would here</b>
              <p className="muted small">Text, 🎙 voice notes (up to 1 minute), 📷 photos and 📄 files (PDF, Word, Excel or text, up to 4 MB) all work. Pay with the PayPal button the bot sends.</p>
            </li>
          </ol>
          <div className="tg-qr">
            {qr ? <img src={qr} alt={`QR code that opens @${info.bot} in Telegram`} /> : <div className="tg-qr-empty" />}
            <span className="muted small">Scan to open on your phone</span>
          </div>
        </div>
      )}

      {(info?.configured || info?.stores?.length > 0) && (
        <div className="tg-grid">
          <div className="card">
            <h2>Things to try</h2>
            <ul className="tg-list">{TRY.map(t => <li key={t}>“{t}”</li>)}</ul>
          </div>
          <div className="card">
            <h2>Good to know</h2>
            <ul className="tg-list">
              <li>Confirmations, PDF receipts and refunds arrive in Telegram too.</li>
              <li>Telegram is a real app outside this demo: messages pass through Telegram&apos;s servers. Use fake details only.</li>
              <li>Ending the session disconnects the bot. Same fair-use limits as the web chat.</li>
            </ul>
          </div>
        </div>
      )}

    </div>
  )
}
