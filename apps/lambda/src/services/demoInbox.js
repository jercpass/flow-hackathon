// @ts-check
'use strict'

// ─── Flow web inbox ────────────────────────────────────────────────────────
// Each demo session has two inboxes: the customer's (John) and the owner's (the
// session's own salon). Messages Flow sends them are stored with the session
// and shown in the panel beside the app, attachments included. There are no
// email addresses: a message is addressed by session and role.

const { store } = require('./demoStore')

/** The session whose customer inbox this customer has, or null. */
function customerInbox(customer) {
  return customer?.demoSessionId || null
}

/** The session whose owner inbox this business has (only the session's own salon), or null. */
function ownerInbox(business) {
  return business?.demoSessionId && business.ownerInbox ? business.demoSessionId : null
}

// Attachments (the receipt PDF) are a few KB: kept with the message as base64.
const MAX_ATTACHMENT_BYTES = 200_000
function packAttachments(attachments) {
  return (attachments || []).filter(a => a?.content && a.content.length <= MAX_ATTACHMENT_BYTES).slice(0, 3)
    .map(a => ({ filename: String(a.filename || 'attachment').slice(0, 100), contentType: a.contentType || 'application/octet-stream', data: Buffer.from(a.content).toString('base64') }))
}

/**
 * Put one message in a session's inbox.
 * @param {{ sid: string, role: 'customer'|'owner', to?: string, from?: string, subject?: string, text?: string, html?: string|null, kind?: string, attachments?: any[], action?: { label: string, url: string } }} m
 */
async function deliver({ sid, role, to, from, subject, text, html, kind, attachments, businessId, action }) {
  await storeMessage(sid, { role, to, from, subject, text, html, kind, attachments: packAttachments(attachments), businessId, action })
  return true
}

// businessId: which business an owner message is for (the inbox can show one business at a time).
// action: one button under the message (e.g. "Review and approve $40"), an https or local link.
async function storeMessage(sid, { role, to, from, subject, text, html, kind, attachments, businessId, action }) {
  const ts = Date.now()
  await store().addMessage(sid, {
    id: Math.random().toString(36).slice(2, 10), ts, role, to: to || null, from: from || 'Flow',
    subject: String(subject || '(no subject)').slice(0, 200),
    text: String(text || '').slice(0, 20000),
    html: html ? String(html).slice(0, 100000) : null,
    kind: kind || 'general', read: false,
    ...(businessId ? { businessId } : {}),
    ...(action?.url && /^https?:\/\//.test(action.url) ? { action: { label: String(action.label || 'Open').slice(0, 80), url: String(action.url).slice(0, 500) } } : {}),
    ...(attachments?.length ? { attachments } : {})
  })
}

async function list(sid, { role, since } = {}) {
  const msgs = await store().listMessages(sid, since || null)
  return role ? msgs.filter(m => m.role === role) : msgs
}

module.exports = { customerInbox, ownerInbox, deliver, storeMessage, list }
