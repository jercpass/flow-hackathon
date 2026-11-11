'use client'
import { useEffect, useRef, useState } from 'react'
import clips from '../../../public/demo/voice/clips.json'
import { audioToAttachment } from '../../../lib/media'
import { tourEvent } from '../../../lib/tourSteps'

// Guided demo, act 2: what the customer sends, step by step, docked above the chat box.
// Text steps send exactly the words shown. Voice steps are pre-recorded clips:
// play them, read them, then send them as real voice notes (transcribed like
// any other). The judge can always type their own message instead.

const TZ = 'America/Chicago'
const KEY = 'bp_script'

// Three days out in the salon's time zone: a 3 PM booking then is always more
// than 48 hours away, so the cancellation shows a real full refund.
function bookingDay(now = Date.now()) {
  return new Date(now + 3 * 86_400_000).toLocaleDateString('en-US', { weekday: 'long', timeZone: TZ })
}

// A week after that: the booking the new membership covers.
function laterDay(now = Date.now()) {
  return new Date(now + 10 * 86_400_000).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: TZ })
}

export function chatScript() {
  const clip = id => clips.find(c => c.id === id) || null
  return [
    { id: 'usual', kind: 'text', title: 'Ask for the usual', text: `Hi! Can I get my usual haircut on ${bookingDay()} afternoon?` },
    { id: 'time', kind: 'text', title: 'Pick a time', text: 'Yes, 3 PM please.' },
    { id: 'pay', kind: 'pay', pay: 'booking', title: 'Pay with your saved PayPal' },
    { id: 'chat-question', kind: 'voice', title: 'Ask about parking and colour', clip: clip('chat-question') },
    { id: 'chat-cancel', kind: 'voice', title: 'Cancel, by voice', clip: clip('chat-cancel') },
    { id: 'confirm', kind: 'text', title: 'Confirm the cancellation', text: 'Yes, cancel it.' },
    { id: 'packs', kind: 'text', title: 'Ask about packs and memberships', text: 'Does Willow have a haircut pack or a membership?' },
    // Name it: with only "the monthly membership" the AI once asked which shop's.
    { id: 'join', kind: 'text', title: 'Join the monthly membership', text: "I'll take the Willow Monthly membership." },
    { id: 'subscribe', kind: 'pay', pay: 'subscription', title: 'Join, paid from your saved PayPal' },
    { id: 'covered', kind: 'text', title: 'Book it: covered by the membership', text: `Great. Book my usual haircut on ${laterDay()} at 3 PM.` }
  ]
}

// Flow's spoken reply in the chat (demo/client page.js renders it with autoplay):
// wait until it has finished, so the guide never moves on while it's talking.
async function replyAudioDone() {
  let el = null
  for (let i = 0; i < 20 && !el; i++) {     // up to 2 s for the reply's player to appear
    el = [...document.querySelectorAll('audio.voice-reply-audio')].pop() || null
    if (!el) await new Promise(r => setTimeout(r, 100))
  }
  if (!el) return
  if (el.paused && el.currentTime === 0) await new Promise(r => setTimeout(r, 600))   // autoplay starting
  if (el.ended || el.paused || el.error) return
  const left = Number.isFinite(el.duration) ? el.duration - el.currentTime : 45
  await new Promise(resolve => {
    const done = () => { clearTimeout(t); el.removeEventListener('ended', done); el.removeEventListener('pause', done); resolve() }
    const t = setTimeout(done, (Math.min(left, 60) + 2) * 1000)
    el.addEventListener('ended', done)
    el.addEventListener('pause', done)
  })
}

function load(sid) {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s?.sid === sid) return s } catch {}
  return { sid, done: [], open: false }
}

export default function ScriptCard({ sid, busy, paid, subscribed, onSendText, onSendAudio, onClose }) {
  const [steps] = useState(chatScript)
  const [st, setSt] = useState(() => ({ sid, done: [], open: false }))
  const [sending, setSending] = useState('')
  const [phase, setPhase] = useState('')    // 'playing' | 'sending' | 'listening' while a voice step runs
  const [error, setError] = useState('')
  useEffect(() => { setSt(load(sid)) }, [sid])
  const save = next => { setSt(next); try { localStorage.setItem(KEY, JSON.stringify(next)) } catch {} }
  const markDone = id => setSt(s => { const next = { ...s, done: [...new Set([...s.done, id])] }; try { localStorage.setItem(KEY, JSON.stringify(next)) } catch {} return next })

  // Paying happens on PayPal; the chat reports it back.
  useEffect(() => { if (paid && !st.done.includes('pay')) markDone('pay') }, [paid, st.done])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (subscribed && !st.done.includes('subscribe')) markDone('subscribe') }, [subscribed, st.done])   // eslint-disable-line react-hooks/exhaustive-deps

  const doneSet = new Set(st.done)
  const currentIndex = Math.max(0, steps.findIndex(s => !doneSet.has(s.id)))
  const allDone = steps.every(s => doneSet.has(s.id))

  async function send(step) {
    setError(''); setSending(step.id)
    try {
      let ok
      if (step.kind === 'text') ok = await onSendText(step.text)
      else {
        // Send only unlocks once the clip has played to the end (VoiceStep); after
        // sending, Flow's spoken reply plays out before the script and the guide move on.
        setPhase('sending')
        const blob = await (await fetch(step.clip.src)).blob()
        const { attachment } = await audioToAttachment(blob, 'voice-note')
        ok = await onSendAudio(attachment)
        if (ok) { setPhase('listening'); await replyAudioDone() }
      }
      if (ok) { markDone(step.id); tourEvent(`script:${step.id}`) }
    } catch (err) {
      setError(err.message || 'Could not send that.')
    }
    setSending(''); setPhase('')
  }

  const current = steps[currentIndex]
  return (
    <div className="script" data-tour="script">
      <div className="script-head">
        <span className="script-badge">Script</span>
        <b>{allDone ? 'All done. Keep chatting freely' : `Step ${currentIndex + 1} of ${steps.length}`}</b>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn-ghost btn-sm" onClick={() => save({ ...st, open: !st.open })} aria-expanded={st.open}>{st.open ? 'Show current step' : 'All steps'}</button>
        <button type="button" className="btn-ghost btn-sm script-x" onClick={onClose} aria-label="Hide the script" title="Hide (bring it back from Script in the bottom-left corner)">×</button>
      </div>

      {st.open ? (
        <ol className="script-list">
          {steps.map((s, i) => (
            <li key={s.id} className={doneSet.has(s.id) ? 'done' : i === currentIndex ? 'now' : ''}>
              <span className="script-n">{doneSet.has(s.id) ? '✓' : i + 1}</span>
              <div>
                <b>{s.title}</b>
                <div className="muted small">{s.kind === 'text' ? `“${s.text}”` : s.kind === 'voice' ? `🎙 “${s.clip?.text || ''}”` : s.pay === 'subscription' ? 'PayPal sandbox subscription (billed monthly)' : 'PayPal sandbox checkout'}</div>
              </div>
              {i !== currentIndex && !doneSet.has(s.id) && s.kind !== 'pay' && (
                <button type="button" className="btn-secondary btn-sm" onClick={() => send(s)} disabled={busy || !!sending || (s.kind === 'voice' && !s.clip)}>Send</button>
              )}
            </li>
          ))}
        </ol>
      ) : !allDone && (
        <div className="script-step" data-tour="script-step">
          <div className="script-title"><span className="script-n">{currentIndex + 1}</span>{current.title}</div>
          {current.kind === 'text' && (
            <div className="script-row">
              <div className="script-say">“{current.text}”</div>
              <button type="button" onClick={() => send(current)} disabled={busy || !!sending}>{sending === current.id ? 'Sending…' : 'Send'}</button>
            </div>
          )}
          {current.kind === 'voice' && (current.clip
            ? <VoiceStep key={current.clip.id} clip={current.clip} sending={sending === current.id} phase={phase} disabled={busy || !!sending} onSend={() => send(current)} />
            : <p className="muted small">This clip hasn&apos;t been recorded on this server yet. Type the message instead.</p>)}
          {current.kind === 'pay' && (
            <div className="script-pay">
              {/* PayPal was linked once, at the start (PAYPAL_ONE_LINK.md): no login here. */}
              {current.pay === 'subscription'
                ? <p>Press <b>Yes, pay with saved PayPal</b> under Flow&apos;s reply. The membership is paid from the PayPal you linked at the start, then each month (fake money).</p>
                : <p>Press <b>Yes, pay with saved PayPal</b> under Flow&apos;s reply. The PayPal you linked at the start pays it in one click (fake money).</p>}
              <p className="muted small">This step ticks itself when PayPal confirms {current.pay === 'subscription' ? 'the membership' : 'the payment'}.</p>
            </div>
          )}
          {error && <p className="notice notice-error" style={{ marginTop: 8 }}>{error}</p>}
        </div>
      )}
    </div>
  )
}

const PHASE = { sending: 'Sending…', listening: 'Flow is speaking…' }

// Keyed by clip (above), and the audio is checked against the clip too: the player
// once kept the first step's audio, so the cancel step played the parking question.
// The voice note plays by itself when its step comes up (once nothing else is
// going on), and has to be heard in full before it can be sent: Send unlocks
// when it has played to the end (stopping early doesn't count; ▶ plays it again).
function VoiceStep({ clip, sending, phase, disabled, onSend }) {
  const audio = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [heard, setHeard] = useState(false)
  const autoplayed = useRef(false)
  useEffect(() => () => audio.current?.pause(), [])
  useEffect(() => {
    if (disabled || autoplayed.current) return
    // The page has had clicks already, so the browser allows it; if not, ▶ is there.
    const t = setTimeout(() => { autoplayed.current = true; if (!audio.current?.currentTime) toggle() }, 400)
    return () => clearTimeout(t)
  }, [disabled])   // eslint-disable-line react-hooks/exhaustive-deps
  function toggle() {
    if (audio.current && !audio.current.src.endsWith(clip.src)) { audio.current.pause(); audio.current = null }
    if (!audio.current) {
      audio.current = new Audio(clip.src)
      audio.current.onended = () => { setPlaying(false); setHeard(true) }
    }
    if (playing) { audio.current.pause(); audio.current.currentTime = 0; setPlaying(false) } else { audio.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false)) }
  }
  return (
    <div className="script-voice">
      <button type="button" className="script-play" onClick={toggle} aria-label={playing ? 'Stop' : 'Play the voice note'}>{playing ? '■' : '▶'}</button>
      <div className="script-voice-body">
        <div className="script-say">“{clip.text}”</div>
        <div className="muted small">Voice note · {Math.round(clip.seconds)}s · pre-recorded, sent and transcribed like any voice note</div>
      </div>
      <button type="button" onClick={onSend} disabled={disabled || !heard || playing} title={heard ? undefined : 'Play the voice note to the end first'}>
        {sending ? PHASE[phase] || 'Sending…' : playing ? 'Playing…' : heard ? 'Send voice note' : 'Play it first'}
      </button>
    </div>
  )
}
