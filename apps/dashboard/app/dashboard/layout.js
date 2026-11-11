'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { api } from '../../lib/api'
import { demoApi } from '../../lib/demo'

// The demo owner's side: the day first (overview, calendar, bookings), then how
// the business is set up, then money and AI. There are no real accounts here,
// so no login, password or log out: the demo session is the only way in.
const GROUPS = [
  { title: null, items: [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/calendar', label: 'Calendar' },
    { href: '/dashboard/bookings', label: 'Bookings' },
  ]},
  { title: 'Business', items: [
    { href: '/dashboard/services', label: 'Services & prices' },
    { href: '/dashboard/resources', label: 'Staff' },
    { href: '/dashboard/setup', label: 'Policies' },
  ]},
  { title: 'Money', items: [
    { href: '/dashboard/payments', label: 'PayPal & payments' },
    { href: '/dashboard/memberships', label: 'Memberships' },
    { href: '/dashboard/disputes', label: 'Disputes' },
  ]},
  { title: 'AI & settings', items: [
    { href: '/dashboard/ai', label: 'AI & channels' },
    { href: '/dashboard/knowledge', label: 'Knowledge base' },
    { href: '/dashboard/settings', label: 'Settings' },
  ]},
]

export default function DashboardLayout({ children }) {
  const pathname = usePathname()
  const [name, setName] = useState('')
  const [session, setSession] = useState(null)
  useEffect(() => { api('/dashboard/settings').then(d => d?.name && setName(d.name)) }, [])
  // Guided demo: "Set up with AI" leads the menu until the salon exists, then
  // stays under Business so the judge can go back to it.
  useEffect(() => {
    const load = () => demoApi('/session').then(s => s && !s.error && setSession(s))
    load()
    const on = e => { if (String(e.detail).startsWith('setup-')) load() }
    window.addEventListener('bp-tour', on)
    return () => window.removeEventListener('bp-tour', on)
  }, [])
  const guided = session?.mode === 'guided'
  const groups = !guided ? GROUPS : session.setupDone
    ? GROUPS.map(g => (g.title === 'Business' ? { ...g, items: [{ href: '/dashboard/build', label: 'AI setup' }, ...g.items] } : g))
    : [{ title: null, items: [{ href: '/dashboard/build', label: 'Set up with AI', dot: true }] }, ...GROUPS]

  const initials = (name || 'F').split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div className="flow-shell">
      <nav className="flow-nav" aria-label="Business menu">
        <div className="client-who">
          <span className="client-avatar" aria-hidden="true">{name ? initials : ''}</span>
          <div style={{ minWidth: 0 }}>
            {name ? <b className="flow-name">{name}</b> : <span className="skel skel-text" aria-label="Loading" />}
            <div className="muted small">Owner</div>
          </div>
        </div>
        {groups.map((g, gi) => (
          <div className="client-group" key={gi}>
            {g.title && <div className="flow-group-title">{g.title}</div>}
            {g.items.map(n => (
              <Link key={n.href} href={n.href} className={`flow-link ${pathname === n.href ? 'on' : ''}`} aria-current={pathname === n.href ? 'page' : undefined}>
                {n.label}
                {n.dot && <span className="nav-dot" aria-label="to do" />}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <main className="flow-main">
        {children}
      </main>
    </div>
  )
}
