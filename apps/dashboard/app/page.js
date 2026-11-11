'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { demoApi, publicApi, saveDemoSession, hasDemoSession } from '../lib/demo'
import { version } from '../package.json'

// Demo home page: explains everything BEFORE a session exists. Nothing is created
// until "Start session" is clicked, so bots and drive-by visits cost nothing.
export default function Home() {
  const router = useRouter()
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [ended, setEnded] = useState(false)

  useEffect(() => {
    if (hasDemoSession()) { router.replace('/demo/client'); return }
    setEnded(new URLSearchParams(window.location.search).get('ended') === '1')
    publicApi('/demo/info').then(setInfo)
  }, [router])

  // Guided: the salon starts unset and the tour walks through setting it up with
  // AI, booking it as the customer, then the owner's view. Explore: everything prebuilt.
  async function start(mode) {
    setError(''); setBusy(mode)
    const res = await demoApi('/session', { method: 'POST', body: { mode } })
    setBusy('')
    if (res?.sessionToken) {
      saveDemoSession(res)
      router.push(mode === 'guided' ? '/dashboard/build' : '/demo/client')
    } else {
      setError(res?.error || 'Could not start a session — please try again.')
    }
  }

  const L = info?.limits
  return (
    <div className="home-page">
    <main className="home">
      <header className="home-hero">
        <div className="home-hero-text">
          <div className="home-brand"><img className="home-logo" src="/icon.svg" alt="" width="34" height="34" />Flow</div>
          <div><span className="home-eyebrow">PayPal AI Hackathon 2026 edition · live demo</span></div>
          <h1>An AI booking agent for small businesses, <em>paid with PayPal.</em></h1>
          <p className="home-lead">
            Customers book and pay by chatting or talking, in any language. Owners run the business by asking.
            Refunds follow the business&apos;s own policy, automatically.
          </p>
          {ended && <p className="notice notice-info home-note">Your previous session ended and its data was deleted. Start a fresh one anytime.</p>}
          <div className="home-actions">
            <button className="home-start" onClick={() => start('guided')} disabled={!!busy}>{busy === 'guided' ? 'Starting…' : 'Start the guided demo'}</button>
            <button className="home-start home-start-alt" onClick={() => start('explore')} disabled={!!busy}>{busy === 'explore' ? 'Starting…' : 'Explore on my own'}</button>
          </div>
          {error && <p className="home-error">{error}</p>}
          <ul className="home-points">
            <li><Icon kind="check" /> Real AI and real PayPal sandbox payments</li>
            <li><Icon kind="check" /> No sign-up</li>
            <li><Icon kind="check" /> Guided tour in about 5 minutes</li>
          </ul>
        </div>

        {/* The Flow logo clip, with a booking floating over it. Decorative: the text says it all. */}
        <div className="home-stage" aria-hidden="true">
          <Stage />
          <span className="home-float home-float-ask">Book my usual haircut for Saturday</span>
          <span className="home-float home-float-paid"><Icon kind="check" /> Paid with PayPal · $40</span>
          <span className="home-float home-float-hood">Booked once, never charged twice <b>✓</b></span>
        </div>
      </header>

      <section className="home-features">
        <div className="home-feature">
          <div className="home-feature-icon"><Icon kind="chat" /></div>
          <h3>Book as the customer</h3>
          <p>Web chat with voice notes, photos and PDFs, a voice assistant, or your own AI, then Telegram and Alexa on your phone. Log in with PayPal; Flow knows your usual and takes payment with PayPal.</p>
        </div>
        <div className="home-feature">
          <div className="home-feature-icon"><Icon kind="store" /></div>
          <h3>Run the business</h3>
          <p>Bookings land on the calendar as PayPal confirms them, refunds follow the policy, and disputes are answered from the booking. Or run it all from your own AI.</p>
        </div>
        <div className="home-feature">
          <div className="home-feature-icon"><Icon kind="pulse" /></div>
          <h3>Watch it under the hood</h3>
          <p>A live timeline of every AI step, seat hold, PayPal order, capture and refund, plus every message sent.</p>
        </div>
      </section>

      <section className="home-grid">
        <div className="home-card">
          <h2>Two ways to try it, one session</h2>
          <div className="home-way">
            <span className="home-way-icon"><Icon kind="user" /></span>
            <p><b>Book as a customer.</b> Log in with PayPal and you&apos;re a regular in Austin. Ask for a haircut, a massage or a beard trim: Flow finds what&apos;s nearby, books it and takes payment with PayPal. Cancel and watch the policy refund.</p>
          </div>
          <div className="home-way">
            <span className="home-way-icon"><Icon kind="store" /></span>
            <p><b>Run the business.</b> Switch to the owner of Willow &amp; Co. and see the booking, the payment and every alert arrive.</p>
          </div>
          <p className="home-muted home-small">Switch sides anytime from the top bar. Both sides share the same data.</p>
        </div>

        <div className="home-card">
          <h2>Then take it with you</h2>
          <div className="home-way">
            <span className="home-way-icon"><Icon kind="send" /></span>
            <p><b>Telegram.</b> Text Flow&apos;s bot or send a voice note, and pay with the PayPal button it sends.</p>
          </div>
          <div className="home-way">
            <span className="home-way-icon"><Icon kind="ring" /></span>
            <p><b>Alexa.</b> &ldquo;Alexa, open Flow Bookings.&rdquo; Add your Amazon account on the Alexa page and book by voice.</p>
          </div>
          <div className="home-way">
            <span className="home-way-icon"><Icon kind="spark" /></span>
            <p><b>Your own AI.</b> Claude or ChatGPT books and pays through Flow, within limits you set.</p>
          </div>
          <p className="home-muted home-small">Same assistant, same PayPal, same bookings. They open after the guided tour, or anytime when you explore.</p>
        </div>

        <div className="home-card">
          <h2>Your session</h2>
          <ul className="home-checks">
            <li><Icon kind="check" /><span>You&apos;re the customer: log in with a PayPal sandbox account (fake money; the login card offers the demo&apos;s buyer). Your home is made up, in Austin; your real location is never used.</span></li>
            <li><Icon kind="check" /><span>Your own private copy of the demo city. Other visitors never see your bookings.</span></li>
            <li><Icon kind="check" /><span>Two inboxes beside the app, customer and owner: confirmations, receipt PDFs, refunds and alerts.</span></li>
            <li><Icon kind="check" /><span>Everything is deleted after 24 hours, or when you click <i>End session</i>.</span></li>
          </ul>
        </div>

        <div className="home-card">
          <h2>Fair use</h2>
          <p className="home-muted home-small">So the demo stays fast for everyone:</p>
          <div className="home-limits">
            <div><b>{L ? L.chatPerSessionPerHour : 40}</b><span>chat messages an hour</span></div>
            <div><b>{L ? L.checkoutsPerSessionPerHour : 5}</b><span>PayPal checkouts an hour</span></div>
            <div><b>{L ? L.sessionsPerIpPerDay : 10}</b><span>sessions a day per network</span></div>
          </div>
          <p className="home-muted home-small">If you hit a limit, the app tells you when to try again.</p>
        </div>
      </section>

      <div className="home-built">
        <em>Built with</em>
        <span>PayPal</span><span>Claude</span><span>AWS Lambda</span><span>Next.js</span><span>Bryntum</span><span>AG Grid</span><span>APIMatic</span>
      </div>

      <footer className="home-foot">
        Built for the PayPal AI Hackathon 2026 · Flow v{version}, hackathon edition
      </footer>
    </main>
    </div>
  )
}

// The logo clip loops; with reduced motion asked for, its first frame stands still instead.
function Stage() {
  const [still, setStill] = useState(false)
  useEffect(() => { setStill(window.matchMedia('(prefers-reduced-motion: reduce)').matches) }, [])
  return still
    ? <img src="/home/flow-f.jpg" alt="" />
    : <video src="/home/flow-f.mp4" poster="/home/flow-f.jpg" autoPlay muted loop playsInline preload="auto" />
}

// Line icons, drawn with the text colour.
function Icon({ kind }) {
  const paths = {
    check: <path d="M5 12.5l4.2 4.2L19 7" />,
    chat: <><path d="M20 12a8 8 0 01-11.6 7.1L4 20l1-4.2A8 8 0 1120 12z" /><path d="M9 11h6M9 14h4" /></>,
    store: <><path d="M4 9l1.5-4.5h13L20 9" /><path d="M4 9h16v1.5a2.7 2.7 0 01-5.3 0 2.7 2.7 0 01-5.4 0A2.7 2.7 0 014 10.5z" /><path d="M5.5 12.5V20h13v-7.5" /><path d="M10 20v-4h4v4" /></>,
    pulse: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
    user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0114 0" /></>,
    send: <><path d="M21 3L10 14" /><path d="M21 3l-6.5 18-4.5-7-7-4.5z" /></>,
    ring: <circle cx="12" cy="12" r="7" />,
    spark: <path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9z" />
  }
  return <svg className="home-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>
}
