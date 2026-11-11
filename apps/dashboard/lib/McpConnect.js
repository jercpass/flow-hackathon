'use client'
import { useEffect, useState } from 'react'
import { demoApi, ownerBusinessId } from './demo'

// "Connect your own AI": this session's MCP link for one role (the customer,
// or the owner), what it can do, per-app setup with only that app's snippet,
// and prompts to try. Links stop working when the session ends.
// compact: the Guide panel's version (link + copy + a way to the full page).

const ROLES = {
  customer: {
    title: 'Customer link',
    who: 'Your AI acts as you, the customer',
    can: ['Find salons, barbers and spas near you', 'Check open times and book', 'Pay with a PayPal link (also in the inbox)', 'Join memberships and buy packs (PayPal)', 'Knows your usual', 'Cancel with the policy refund', 'Payments, refunds and past visits'],
    prompts: ['Book my usual haircut for Saturday afternoon.', 'Is there a spa near me with a massage on Sunday?', 'What do I have booked this week?', 'Cancel my next booking. How much do I get back?']
  },
  business: {
    title: 'Owner link · Willow & Co.',
    who: 'Your AI runs the salon as the owner',
    can: ['Set the salon up from its documents', 'Change prices, services, staff, hours and refunds', 'Memberships and packs: plans, members, monthly revenue', 'Walk-ins, no-shows, balances, the knowledge base', 'Schedule, revenue and customers', 'Block time off, move or cancel bookings', 'Refunds (always quoted first)', 'Live PayPal fees, net and refunds'],
    prompts: ['Set up my salon with Flow.', 'Make Color & Gloss $130 and let Ben do it too.', "What's on this week's schedule, and how much did we make?", "Block Ana's lunch tomorrow 12 to 1.", "Check this week's PayPal payments: what did PayPal charge in fees?", "Refund the customer's last booking in full. Quote it first."]
  }
}

// Any other business the judge runs or added: named, not Willow's examples.
function ownerRole(info) {
  if (!info?.businessName || info.ownBusiness !== false) return ROLES.business
  return {
    title: `Owner link · ${info.businessName}`,
    who: 'Your AI runs the business as the owner',
    can: ['Set it up by asking you, if it isn\'t yet', 'Change prices, services, staff, hours and refunds', 'Schedule, revenue and customers', 'Walk-ins, no-shows, moves and cancels', 'Refunds (always quoted first)', 'Live PayPal fees, net and refunds'],
    prompts: ['Set up my business with Flow.', "What's on this week's schedule?", 'Raise every price by $5. Quote it first.', 'Block tomorrow 12 to 1 for lunch.']
  }
}

// The apps people actually use, by name (naming them is fine: organizers, Oct 29).
// local: works with a localhost link; the web apps need the hosted demo's link.
const APPS = [
  { id: 'claude-desktop', label: 'Claude Desktop', local: true },
  { id: 'claude-code', label: 'Claude Code', local: true },
  { id: 'cursor', label: 'Cursor', local: true },
  { id: 'vscode', label: 'VS Code', local: true },
  { id: 'claude-web', label: 'Claude.ai', local: false },
  { id: 'chatgpt', label: 'ChatGPT', local: false }
]

export default function McpConnect({ focus = 'customer', compact = false, onOpenFull }) {
  const [info, setInfo] = useState(null)
  const [app, setApp] = useState(null)
  // The owner link runs whichever business the Business side is showing.
  useEffect(() => {
    const biz = ownerBusinessId()
    demoApi(`/mcp${biz ? `?business=${encodeURIComponent(biz)}` : ''}`).then(d => d?.customer && setInfo(d))
  }, [])
  if (!info) return <p className="muted small">Loading your MCP link…</p>

  // Each side shows only its own link: the owner never sees the customer's, and the customer
  // never sees the owner's.
  const role = focus === 'business' ? 'business' : 'customer'
  const r = role === 'business' ? ownerRole(info) : ROLES[role]
  const link = info[role]
  const localOnly = /^http:\/\/(localhost|127\.0\.0\.1)/.test(link)
  const until = new Date(info.expiresAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })

  if (compact) {
    return (
      <div className="mcpc-compact">
        <div className="muted small">{r.title}: {r.who}</div>
        <LinkField value={link} />
        {onOpenFull && <button className="link-btn" onClick={onOpenFull}>Setup steps and prompts →</button>}
      </div>
    )
  }

  const current = app || (localOnly ? 'claude-desktop' : 'claude-web')
  const currentApp = APPS.find(a => a.id === current)
  const name = `flow-${role}`
  const snippets = {
    'claude-desktop': JSON.stringify({ mcpServers: { [name]: { command: 'npx', args: ['-y', 'mcp-remote', link] } } }, null, 2),
    'claude-code': `claude mcp add --transport http ${name} ${link}`,
    cursor: JSON.stringify({ mcpServers: { [name]: { url: link } } }, null, 2),
    vscode: JSON.stringify({ servers: { [name]: { type: 'http', url: link } } }, null, 2)
  }
  // One click where the app allows it. Cursor and VS Code open with Flow filled in
  // (their install links). Claude has an install link too: it opens "Add custom
  // connector" with the name and link filled in, so the person only clicks Add
  // (claude.com/docs/connectors/building/directory-vs-custom). A Claude connector
  // follows the account, so it covers Claude Desktop and the phone app; it runs
  // from Anthropic's cloud, so it can't reach a localhost link. ChatGPT has no
  // such link, so its button copies the link and opens the page it's pasted into.
  const connectorName = role === 'business' ? 'Flow Business' : 'Flow'
  const claudeInstall = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(connectorName)}&connectorUrl=${encodeURIComponent(link)}`
  const toClaude = { label: 'Connect to Claude', href: claudeInstall, newTab: true, note: `Claude opens with ${connectorName} and your link filled in. Click Add.` }
  const connect = {
    'claude-web': toClaude,
    'claude-desktop': localOnly ? null : toClaude,
    chatgpt: { label: 'Connect to ChatGPT', open: 'https://chatgpt.com/#settings/Connectors', copies: true },
    cursor: { label: 'Add to Cursor', href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${name}&config=${btoa(JSON.stringify({ url: link }))}` },
    vscode: { label: 'Add to VS Code', href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: 'http', url: link }))}` }
  }
  const claudeSteps = [`Connect to Claude opens Claude’s Add custom connector box with ${connectorName} and your link already filled in (sign in first if Claude asks).`, 'Click Add.', `In a chat, turn ${connectorName} on from the tools menu. It also shows up in Claude Desktop and the Claude phone app. (Free plans get one custom connector.)`]
  const steps = {
    'claude-desktop': localOnly
      ? ['In Claude Desktop, open Settings → Developer → Edit Config.', 'Paste this into claude_desktop_config.json.', 'Restart Claude Desktop. Flow’s tools appear in the chat’s tools menu. (Needs Node.js for npx.)']
      : [...claudeSteps, 'Or add it by hand: Settings → Developer → Edit Config, paste this, then restart Claude Desktop (needs Node.js):'],
    'claude-code': ['Run this in your terminal, then start claude and ask. /mcp shows the connection.'],
    cursor: ['Add to Cursor opens Cursor with Flow filled in. Click Install.', 'Or add it by hand in Settings → MCP (or ~/.cursor/mcp.json):'],
    vscode: ['Add to VS Code opens VS Code with Flow filled in. Click Install.', 'Or run “MCP: Add Server” from the Command Palette → HTTP and paste the link, or put this in .vscode/mcp.json:'],
    'claude-web': claudeSteps,
    chatgpt: ['ChatGPT has no link that fills this in, so Connect to ChatGPT copies your link and opens ChatGPT’s settings.', `In Apps (or Connectors) → Advanced settings, turn on Developer mode, then Create: name it ${connectorName}, paste the link as the MCP server URL, no authentication.`, `In a chat, pick Developer mode from the + menu and choose ${connectorName}. (Needs a paid ChatGPT plan.)`]
  }

  return (
    <div className="mcpc">
      <section className="mcpc-card mcpc-main">
        <div className="mcpc-head">
          <div>
            <div className="mcpc-title">{r.title}</div>
            <div className="muted small">{r.who}</div>
          </div>
          <span className="mcpc-live"><i /> Works until {until}</span>
        </div>
        <LinkField value={link} primary />
        <ul className="mcpc-can">{r.can.map(c => <li key={c}>{c}</li>)}</ul>
      </section>

      <section className="mcpc-card">
        <div className="mcpc-title">Set it up</div>
        <div className="mcpc-tabs" role="tablist">
          {APPS.map(a => (
            <button key={a.id} role="tab" aria-selected={current === a.id} className={current === a.id ? 'on' : ''} onClick={() => setApp(a.id)}>{a.label}</button>
          ))}
        </div>
        {!currentApp.local && localOnly && (
          <p className="mcpc-warn">This local demo uses a localhost link, which {currentApp.label} can&apos;t reach. Use Claude Desktop, Claude Code, Cursor or VS Code, or the hosted demo.</p>
        )}
        {connect[current] && !(localOnly && !currentApp.local) && <ConnectButton {...connect[current]} link={link} />}
        <ol className="mcpc-steps">{steps[current].map(s => <li key={s}>{s}</li>)}</ol>
        {snippets[current] && <Snippet value={snippets[current]} />}
      </section>

      <section className="mcpc-card">
        <div className="mcpc-title">Then try asking</div>
        <div className="mcpc-prompts">{r.prompts.map(p => <PromptChip key={p} text={p} />)}</div>
        <p className="muted small">Every call your AI makes shows up live in <b>Under the hood</b>.</p>
      </section>

      {role === 'business' && (
        <p className="mcpc-foot"><b>PayPal is built in.</b> The owner link reads live PayPal payments, fees and refunds and issues policy refunds through Flow&apos;s backend, on the account the salon connected. There&apos;s no PayPal token to paste.</p>
      )}
    </div>
  )
}

function useCopy() {
  const [done, setDone] = useState(false)
  return [done, value => { navigator.clipboard?.writeText(value)?.catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1200) }]
}

// copies: put the link on the clipboard, then open the page it gets pasted into.
// href: an install link that fills Flow in: an app's own (cursor://, vscode:), or
// Claude's prefilled "Add custom connector" page (newTab).
function ConnectButton({ label, open, href, newTab, note, copies, link }) {
  const [done, copy] = useCopy()
  if (href) {
    return (
      <div className="mcpc-connect">
        <a className="btn-link" href={href} {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}>{label}</a>
        {note && <span className="muted small">{note}</span>}
      </div>
    )
  }
  return (
    <div className="mcpc-connect">
      <button className="btn-link" onClick={() => { if (copies) copy(link); window.open(open, '_blank', 'noopener') }}>{label}</button>
      {done && <span className="muted small">Link copied. Paste it there.</span>}
    </div>
  )
}

function LinkField({ value, primary }) {
  const [done, copy] = useCopy()
  return (
    <div className="mcpc-link">
      <code title={value}>{value}</code>
      <button className={primary ? 'btn-sm' : 'btn-sm btn-secondary'} onClick={() => copy(value)}>{done ? 'Copied' : 'Copy link'}</button>
    </div>
  )
}

function Snippet({ value }) {
  const [done, copy] = useCopy()
  return (
    <div className="mcpc-snippet">
      <button className="btn-sm btn-secondary" onClick={() => copy(value)}>{done ? 'Copied' : 'Copy'}</button>
      <pre>{value}</pre>
    </div>
  )
}

function PromptChip({ text }) {
  const [done, copy] = useCopy()
  return (
    <button className="mcpc-prompt" onClick={() => copy(text)} title="Copy">
      <span>“{text}”</span><small>{done ? 'Copied' : 'Copy'}</small>
    </button>
  )
}
