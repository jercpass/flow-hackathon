'use client'
import McpConnect from '../../../lib/McpConnect'
import StoreTelegram from '../../../lib/StoreTelegram'

// AI & channels: where customers reach the business, and how the owner can run
// it from their own AI agent (business MCP link, PayPal built in).
export default function AiChannels() {
  return (
    <div style={{ maxWidth: 820 }}>
      <h1>AI &amp; channels</h1>
      <div className="card" style={{ marginBottom: 24 }}>
        <h2>Where customers book</h2>
        <ul className="ai-list">
          <li><b>Web chat:</b> customers ask in plain words, send voice notes, photos and PDFs, pay with PayPal and get the receipt in their Flow inbox.</li>
          <li><b>Telegram:</b> the same assistant on their phone, through your store&apos;s own bot (below) or Flow&apos;s demo bot, with one-tap PayPal.</li>
          <li><b>Voice assistant and Alexa:</b> customers talk to book, in any language; with saved PayPal inside their AI spending limit, it books and pays in one go.</li>
          <li><b>Their own AI:</b> any MCP-capable assistant can find you, book and pay.</li>
        </ul>
        <p className="muted small">Every channel uses the same assistant, your prices, your staff&apos;s hours and your refund policy. Customers can write or speak in any language; the assistant answers in theirs.</p>
      </div>
      <StoreTelegram />
      <h2>Run the business from your AI</h2>
      <p className="muted" style={{ fontSize: 14, margin: '-6px 0 14px' }}>Connect Claude, ChatGPT, Cursor or any AI app that speaks MCP to your business with one link.</p>
      <McpConnect focus="business" />
    </div>
  )
}
