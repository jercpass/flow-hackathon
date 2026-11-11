'use client'
import { useEffect, useRef, useState } from 'react'
import { demoApi } from '../../../lib/demo'
import { PayPalLoginButton } from '../../../lib/CustomerLogin'
import { formatMoney } from '../../../lib/money'
import { startRecorder, audioToAttachment, MAX_VOICE_SECONDS } from '../../../lib/media'
import clips from '../../../public/demo/voice/clips.json'

// Pre-recorded things to say (scripts/demo-assets.js), for judges who'd rather
// not talk to their laptop: the clip plays out loud, then goes to the assistant
// as a real recording.
const SAMPLES = clips.filter(c => c.use === 'voice')

// Flow Voice: talk to book. Each turn is one small request to the server
// (core/voice: start / say / help / stop / end; the conversation travels in the
// session). Speech-to-text runs in the browser when it can (Chrome/Edge);
// otherwise the recording goes to the server. Replies play as natural cloud
// TTS, falling back to the browser's own voice.
//
// A conversation: once you talk (tap the mic), Flow listens again after each
// reply until the conversation ends, you say "stop", stay silent, or type.
// Every wait has a way out (a time limit, or a guard on the spoken reply), so it
// never sticks on Speaking or Processing.

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null
const BARS = 11
const REPLY_TIMEOUT_MS = 45_000   // longer than the server's own limit: give up and say so

function request(type, attributes, text) {
  return { version: 1, session: { new: type === 'start', attributes: attributes || {} }, request: { type, ...(text ? { text } : {}) } }
}
// A spoken "stop" or "help" is a command, not something to book.
function commandFor(said) {
  const s = said.trim().toLowerCase().replace(/[.!?]+$/, '')
  if (/^(stop|cancel|goodbye|bye|that's all|that is all)$/.test(s)) return 'stop'
  if (/^(help|what can you do|what can i say)$/.test(s)) return 'help'
  return null
}

const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" />
  </svg>
)

export default function VoiceDevice({ onBookingsChanged }) {
  const [phase, setPhase] = useState('off')        // off | idle | listening | recording | thinking | speaking
  const [attrs, setAttrs] = useState({})
  const [log, setLog] = useState([])
  const [interim, setInterim] = useState('')
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState('')
  const [recSecs, setRecSecs] = useState(0)
  const recRef = useRef(null)
  const recorderRef = useRef(null)
  const audioRef = useRef(null)
  const logRef = useRef(null)
  // Refs, because the reply's callbacks run later than the render that made them:
  // the conversation so far, whether we're in a spoken back-and-forth, and the
  // spoken reply (Chrome drops onend for an utterance nothing holds on to).
  const attrsRef = useRef({})
  const handsFree = useRef(false)
  const utterRef = useRef(null)
  const setConversation = a => { attrsRef.current = a; setAttrs(a) }

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [log, interim])
  useEffect(() => () => { recRef.current?.abort?.(); recorderRef.current?.cancel?.(); audioRef.current?.pause?.(); window.speechSynthesis?.cancel() }, [])
  useEffect(() => {
    if (phase !== 'recording') return
    const t0 = Date.now()
    const t = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); setRecSecs(s); if (s >= MAX_VOICE_SECONDS) stopRecording() }, 250)
    return () => clearInterval(t)
  })   // eslint-disable-line react-hooks/exhaustive-deps

  // Play the reply, then move on exactly once: to 'after', and listen again if
  // we're in a spoken conversation. A guard timer covers a voice that never says
  // it finished.
  // lang: the reply's language (from the server), so the browser's fallback voice matches it.
  function speak(text, audio, after, lang) {
    window.speechSynthesis?.cancel()
    audioRef.current?.pause?.()
    let finished = false
    let guard = null
    const done = () => {
      if (finished) return
      finished = true
      clearTimeout(guard)
      setPhase(after)
      if (after === 'idle' && handsFree.current) setTimeout(() => listen(), 300)
    }
    const words = String(text || '').split(/\s+/).length
    guard = setTimeout(done, Math.max(5000, words * 450 + 3000))
    if (!text && !audio?.data) { done(); return }
    setPhase('speaking')
    let fellBack = false
    const browserVoice = () => { if (!fellBack) { fellBack = true; fallbackVoice(text, done, lang) } }
    if (audio?.data) {
      const el = new Audio(`data:${audio.mimeType};base64,${audio.data}`)
      audioRef.current = el
      el.onended = done
      el.onerror = browserVoice
      // Now we know how long it is: the guard waits for that, not a guess.
      el.onloadedmetadata = () => { if (Number.isFinite(el.duration)) { clearTimeout(guard); guard = setTimeout(done, el.duration * 1000 + 2500) } }
      el.play().catch(browserVoice)
    } else {
      browserVoice()
    }
  }
  function fallbackVoice(text, done, lang) {
    if (!text || !window.speechSynthesis) { done(); return }
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang || 'en-US'
    u.onend = done
    u.onerror = done
    utterRef.current = u
    window.speechSynthesis.speak(u)
  }

  async function send(req, { audio = null, said = null } = {}) {
    setPhase('thinking'); setNote('')
    if (said) setLog(l => [...l, { who: 'you', text: said }])
    // A reply that never comes mustn't leave it on Processing.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REPLY_TIMEOUT_MS)
    let d
    try {
      d = await demoApi('/voice', { method: 'POST', signal: ctrl.signal, body: { voice: req, ...(audio ? { audio } : {}) } })
    } finally {
      clearTimeout(timer)
    }
    if (ctrl.signal.aborted && !d?.voice) d = { error: 'That took too long. Tap to talk and try again.' }
    if (!d || d.error) { handsFree.current = false; setNote(d?.error || 'Something went wrong. Tap to talk and try again.'); setPhase('idle'); return }
    if (d.transcript) setLog(l => [...l, { who: 'you', text: d.transcript }])
    const reply = d.voice?.reply || {}
    const ended = !!reply.end
    if (ended) handsFree.current = false
    setConversation(ended ? {} : (d.voice?.session?.attributes || {}))
    if (d.speech) setLog(l => [...l, { who: 'flow', text: d.speech, card: reply.card || null, payment: d.payment || null, connect: d.connect || null }])
    if (d.bookingsChanged) onBookingsChanged?.()
    speak(d.speech, d.audio, ended ? 'off' : 'idle', d.lang)
  }

  // The first tap starts Flow (and unlocks audio in the browser).
  function wake() {
    setLog([])
    setConversation({})
    handsFree.current = true   // tapped the mic: a spoken conversation
    send(request('start'))
  }

  function tap() {
    if (phase === 'off') return wake()
    // Tapping while it speaks stops the reply and listens straight away.
    if (phase === 'speaking') { audioRef.current?.pause?.(); window.speechSynthesis?.cancel(); handsFree.current = true; setPhase('idle'); setTimeout(() => listen(), 150); return }
    if (phase === 'listening') { recRef.current?.stop(); return }
    if (phase === 'recording') return stopRecording()
    if (phase === 'idle') { handsFree.current = true; return listen() }
  }

  function sayText(text) {
    const cmd = commandFor(text)
    if (cmd === 'stop') handsFree.current = false
    send(cmd ? request(cmd, attrsRef.current) : request('say', attrsRef.current, text), { said: text })
  }

  function listen() {
    setNote(''); setInterim('')
    if (!SR) return startFallbackRecording('This browser has no built-in speech recognition — recording instead.')
    const rec = new SR()
    rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false
    let finalText = ''
    let lastText = ''   // Chrome sometimes ends without marking the words final
    rec.onresult = e => {
      let text = ''
      for (const r of e.results) { text += r[0].transcript; if (r.isFinal) finalText = text }
      lastText = text
      setInterim(text)
    }
    rec.onerror = e => {
      if (recRef.current !== rec) return
      recRef.current = null
      setInterim('')
      // Silence ends the back-and-forth until the next tap (no endless listening).
      if (e.error === 'no-speech' || e.error === 'aborted') { handsFree.current = false; setNote(e.error === 'no-speech' ? "I didn't hear anything. Tap to talk when you're ready." : ''); setPhase('idle'); return }
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { handsFree.current = false; setNote('Microphone access is blocked: allow it, or type below.'); setPhase('idle'); return }
      if (e.error === 'audio-capture') { handsFree.current = false; setNote('No microphone found: type below instead.'); setPhase('idle'); return }
      startFallbackRecording('Browser speech recognition failed, so recording instead.')   // network etc.
    }
    rec.onend = () => {
      if (recRef.current !== rec) return
      recRef.current = null
      const said = (finalText || lastText || '').trim()
      setInterim('')
      if (said) sayText(said)
      else { handsFree.current = false; setPhase('idle') }
    }
    recRef.current = rec
    setPhase('listening')
    try { rec.start() } catch { recRef.current = null; handsFree.current = false; setPhase('idle') }   // already running
  }

  async function startFallbackRecording(why) {
    try {
      recorderRef.current = await startRecorder()
      setNote(why || ''); setRecSecs(0); setPhase('recording')
    } catch (err) {
      setNote(err.name === 'NotAllowedError' ? 'Microphone access is blocked — allow it, or type below.' : (err.message || 'No microphone available — type below.'))
      setPhase('idle')
    }
  }
  async function stopRecording() {
    const r = recorderRef.current
    recorderRef.current = null
    if (!r) return
    setPhase('thinking')
    try {
      const { attachment } = await audioToAttachment(await r.stop())
      send(request('say', attrsRef.current), { audio: attachment })
    } catch (err) {
      handsFree.current = false
      setNote(err.message || 'Could not use that recording.'); setPhase('idle')
    }
  }

  async function sayClip(clip) {
    if (phase === 'thinking' || phase === 'listening' || phase === 'recording') return
    audioRef.current?.pause?.(); window.speechSynthesis?.cancel()
    setNote(''); setInterim(`Playing: “${clip.text}”`); setPhase('thinking')
    try {
      const blob = await (await fetch(clip.src)).blob()
      const el = new Audio(URL.createObjectURL(blob))
      audioRef.current = el
      await new Promise(resolve => { el.onended = resolve; el.onerror = resolve; el.play().catch(resolve) })
      setInterim('')
      const { attachment } = await audioToAttachment(blob, 'voice-request')
      handsFree.current = false   // a recorded sample isn't you talking
      send(request('say', attrsRef.current), { audio: attachment })
    } catch (err) {
      setInterim(''); setNote(err.message || 'Could not play that sample.'); setPhase(phase === 'off' ? 'off' : 'idle')
    }
  }

  function sendTyped(e) {
    e.preventDefault()
    const text = typed.trim()
    if (!text || phase === 'thinking') return
    setTyped('')
    handsFree.current = false   // typing: don't open the mic after the reply
    if (phase === 'listening') { const r = recRef.current; recRef.current = null; r?.abort?.() }
    sayText(text)
  }

  const label = {
    off: 'Tap to talk to Flow',
    idle: 'Tap to talk',
    listening: 'Listening… tap when done',
    recording: `Recording ${recSecs}s… tap to send`,
    thinking: 'Processing…',
    speaking: 'Speaking… tap to stop'
  }[phase]

  return (
    <div className="voice">
      <div className="voice-stage">
        <div className="vcard">
          <div className="vcard-top"><b>Flow Voice</b><span className={`vstate vstate-${phase}`}>{{ off: 'ready', idle: 'your turn', listening: 'listening', recording: 'recording', thinking: 'processing', speaking: 'speaking' }[phase]}</span></div>
          <div className={`vbars vbars-${phase}`} aria-hidden="true">
            {Array.from({ length: BARS }, (_, i) => <span key={i} style={{ '--i': i, '--h': `${[30, 50, 70, 85, 60, 95, 60, 85, 70, 50, 30][i]}%` }} />)}
          </div>
          <button className={`vmic vmic-${phase}`} onClick={tap} disabled={phase === 'thinking'} aria-label={label}>
            <MicIcon /><span>{label}</span>
          </button>
          {interim && <div className="vinterim">“{interim}”</div>}
          {note && <div className="vnote">{note}</div>}
        </div>
        <p className="muted small" style={{ textAlign: 'center', maxWidth: 420 }}>
          Talk to book, in any language. The same Flow assistant as the chat; PayPal links go to your inbox.
          Try: <i>“Book me a haircut”</i> or <i>“Find a massage near me this weekend.”</i>
        </p>
      </div>

      <div className="voice-log" ref={logRef}>
        {log.length === 0 && <p className="muted small">Your conversation shows here.</p>}
        {log.map((m, i) => (
          <div key={i} className={`vlog ${m.who}`}>
            <span className="vlog-who">{m.who === 'you' ? 'You' : 'Flow'}</span>
            <span>{m.text}</span>
            {m.payment?.url && (
              <div className="vlog-card">
                <b>{m.card?.title || 'Pay to confirm'}</b>
                <div className="muted small">The PayPal link is also in your inbox.</div>
                <a className="paypal-btn" href={m.payment.url}>{m.payment.kind === 'subscription' ? 'Subscribe' : 'Pay'} {m.payment.amount != null ? formatMoney(m.payment.amount) : ''}{m.payment.kind === 'subscription' ? '/month' : ''} with <b>PayPal</b></a>
              </div>
            )}
            {m.connect && (
              <div className="vlog-card">
                <b>Connect your PayPal once</b>
                <div className="muted small">Then every booking pays from it with a yes, here, in the chat, on Telegram or Alexa.</div>
                <PayPalLoginButton label="Connect PayPal" />
              </div>
            )}
          </div>
        ))}
      </div>

      {SAMPLES.length > 0 && (
        <div className="voice-samples" data-tour="voice-samples">
          <span className="muted small">Or play a recorded request:</span>
          {SAMPLES.map(c => (
            <button key={c.id} type="button" className="chip-toggle" onClick={() => sayClip(c)} disabled={phase === 'thinking'} title={`“${c.text}”`}>▶ {c.label}</button>
          ))}
        </div>
      )}

      <form className="voice-type" onSubmit={sendTyped}>
        <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="No mic? Type what you'd say…" maxLength={500} />
        <button type="submit" disabled={!typed.trim() || phase === 'thinking'}>Say it</button>
      </form>
    </div>
  )
}
