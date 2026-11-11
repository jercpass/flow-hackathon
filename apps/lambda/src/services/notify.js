// @ts-check
'use strict'

// ─── Customer and owner messages ──────────────────────────────────────────────
// Booking, payment and refund messages go wherever the person can be reached:
//   • the Flow web inbox (services/demoInbox): every demo customer has one,
//     and so does the owner of the session's salon. This is Flow's only mail;
//     nothing is sent to an outside email address.
// Never throws: a failed message must not undo a confirmed booking or refund.

const inbox = require('./demoInbox')
const log = require('../utils/logger')

/**
 * @param {object} p
 * @param {object} p.business
 * @param {object} p.customer   - the customer record ({ customerId, name, phone, demoSessionId })
 * @param {string} [p.channel]  - where the conversation happened (whatsapp | web | voice | speaker | mcp ...)
 * @param {string} p.text       - plain text body
 * @param {string} [p.subject]  - inbox subject line
 * @param {string} [p.html]     - inbox html body
 * @param {Array<{filename: string, content: Buffer, contentType?: string}>} [p.attachments] - files in the inbox message (the receipt PDF)
 * @returns {Promise<string[]>} where it was delivered: 'inbox' and/or 'telegram'
 */
async function notifyCustomer({ business, customer, channel, text, subject, html, kind, attachments, action }) {
  const sent = []
  const sid = inbox.customerInbox(customer)
  if (sid) {
    const subj = subject || `${business?.name || 'Flow'} booking update`
    try {
      await inbox.deliver({ sid, role: 'customer', to: customer.name || 'Customer', from: business?.name || 'Flow', subject: subj, text, html, kind, attachments, action })
      sent.push('inbox')
      require('./trace').event('inbox', `Sent to ${customer.name || 'the customer'}'s inbox: "${subj}"`, attachments?.length ? { attached: attachments.map(a => a.filename).join(', ') } : {})
    } catch (err) {
      log.error('notify_inbox_failed', err, { businessId: business?.businessId })
    }
  }
  // A customer who linked Telegram gets every update there too, from the bot they
  // use (Flow's demo bot or the store's own): confirmations, receipts, refunds.
  if (customer?.telegram?.chatId) {
    try {
      const b = await require('../core/telegramBot').botFor(customer.telegram.botId)
      if (b) {
        const tg = require('./telegram')
        await b.client.sendMessage(customer.telegram.chatId, `<b>${tg.esc(business?.name || 'Flow')}</b>\n${tg.esc(text)}`, action?.url ? { buttons: [{ text: action.label || 'Open', url: action.url }] } : {})
        const pdfFile = (attachments || []).find(a => /pdf/.test(a.contentType || '') && a.content)
        if (pdfFile) await b.client.sendDocument(customer.telegram.chatId, pdfFile.content, pdfFile.filename || 'receipt.pdf', '')
        sent.push('telegram')
        require('./trace').event('telegram', 'Telegram message sent', { kind: kind || 'update', withPdf: !!pdfFile })
      }
    } catch (err) {
      log.error('notify_telegram_failed', err, { businessId: business?.businessId })
    }
  }
  return sent
}

/**
 * Tell the business owner something happened (new booking, refund, cancel).
 * Goes to the owner's web inbox; never throws.
 */
async function notifyOwner({ business, subject, text, kind, attachments }) {
  const sid = inbox.ownerInbox(business)
  if (!sid) return false
  try {
    await inbox.deliver({ sid, role: 'owner', to: `${business.name} (owner)`, from: 'Flow', subject, text, kind, attachments, businessId: business.businessId })
    const trace = require('./trace')
    trace.forBusiness(business, async () => trace.event('inbox', `Sent to the owner's inbox: "${subject}"`, attachments?.length ? { attached: attachments.map(a => a.filename).join(', ') } : {}))
    return true
  } catch (err) {
    log.error('notify_owner_failed', err, { businessId: business?.businessId })
    return false
  }
}

module.exports = { notifyCustomer, notifyOwner }
