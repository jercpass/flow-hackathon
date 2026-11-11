// @ts-check
'use strict'

// ─── One customer chat turn (demo) ───────────────────────────────────────────
// Shared by every typed channel (web chat, Telegram): an optional attachment
// (voice note → transcript, photo/PDF → summary) becomes text, then the city-wide
// concierge answers with the same AI and booking tools. The file is processed in
// memory and discarded; the AI only ever sees text.
//
// Throws { code: 'DEMO_LIMIT' } (fair-use), 'MEDIA_BUSY' (attachment couldn't be
// processed right now) or 'SESSION_DATA_MISSING'. Callers map these to their
// transport (HTTP status, Telegram message).

const demo = require('./demoSession')
const trace = require('../services/trace')
const log = require('../utils/logger')

const CHANNEL_LABEL = { web: 'web chat', telegram: 'Telegram' }

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * @param {any} session active demo session
 * @param {{ typed?: string, attachment?: any, history?: {role: string, content: string}[], channel?: string, ctxExtra?: object, onlyBusinessId?: string|null }} turn
 * @returns {Promise<{ reply: string, userContent: string, media: any, payment: any, bookingsChanged: boolean }>}
 */
async function chatTurn(session, { typed = '', attachment = null, history = [], channel = 'web', ctxExtra = {}, onlyBusinessId = null }) {
  await demo.checkChatLimits(session.sid)
  if (attachment) await demo.checkMediaLimit(session.sid)

  const { getBusiness } = require('../services/dynamo/businesses')
  const { getCustomer } = require('../services/dynamo/customers')
  const { routeMessage } = require('../services/aiRouter')
  const business = await getBusiness(session.businessId)
  const customer = await getCustomer(session.customerId)
  if (!business || !customer) throw fail('SESSION_DATA_MISSING', 'Session data missing — please start a new session')

  const label = CHANNEL_LABEL[channel] || channel
  const mediaSvc = require('../services/media')
  return trace.run(`sess:${session.sid}`, async () => {
    trace.event('session', attachment ? `Customer sent ${mediaSvc.withArticle(mediaSvc.attachmentLabel(attachment))} (${label})` : `Customer message (${label})`, { chars: typed.length })

    let message = typed
    let media = null
    if (attachment) {
      try {
        if (attachment.kind === 'audio') {
          const { text } = await mediaSvc.transcribeAudio({ ...attachment, hint: customer.name })
          media = { kind: 'audio', transcript: text, durationSec: attachment.durationSec }
          message = [typed, text].filter(Boolean).join('\n')
        } else {
          const { summary } = await mediaSvc.readAttachment(attachment, { businessName: business.name })
          media = { kind: attachment.kind, name: attachment.name, summary, ...(attachment.docType ? { docType: attachment.docType } : {}) }
          // A photo is kept for the session, so the picture itself can go on the booking (services/photos).
          const photoId = attachment.kind === 'image' ? await require('../services/photos').save(session, attachment) : null
          if (photoId) trace.event('media', 'Photo kept for this session, ready to go on the booking', { photo: photoId })
          message = attachment.kind === 'image'
            ? `${typed ? `${typed}\n` : ''}[The customer attached a photo${photoId ? ` (photo id ${photoId})` : ''}. What it shows: ${summary} — when booking, put a short description in the notes${photoId ? ` and pass photo_ids ["${photoId}"] so the business sees the picture itself` : ''}: in book_appointment, or add_booking_note if they already have one.]`
            : `${typed ? `${typed}\n` : ''}[The customer attached ${mediaSvc.withArticle(mediaSvc.attachmentLabel(attachment))} ("${attachment.name}"). What it shows: ${summary} — save what the business needs on the booking: notes in book_appointment, or add_booking_note if they already have one.]`
        }
      } catch (err) {
        log.error('demo_media_failed', err, { kind: attachment.kind, channel })
        trace.event('media', `Could not process the ${attachment.kind === 'audio' ? 'voice note' : 'file'} — asked the customer to retry`, { reason: require('../utils/retry').isTransient(err) ? 'AI provider busy' : 'error' })
        throw fail('MEDIA_BUSY', `Couldn't process that ${attachment.kind === 'audio' ? 'voice note' : 'file'} right now (the AI provider is busy). Please try again in a moment.`)
      }
    }
    if (media?.kind === 'audio' && !media.transcript) {
      return { reply: "I couldn't make out that voice note — could you try again or type it?", userContent: '🎙 (voice note — nothing intelligible)', media, payment: null, bookingsChanged: false }
    }

    const ctx = { ...(await require('./concierge').sessionContext(session, business, customer, channel, { onlyBusinessId })), ...ctxExtra }
    const { reply, toolEvents } = await routeMessage(business, history, message, [], ctx)
    const results = (toolEvents || []).map(e => e.result).filter(Boolean)
    const pay = results.find(r => r.paymentUrl)
    // Saved PayPal: paid in one step (a card in the chat), or a quote waiting for a yes (a reply button).
    const joined = results.find(r => r.joined && r.paid)
    const paidSaved = !joined && results.find(r => r.paidWithSaved && (r.booked || r.paid))
    // Not connected yet (PAYPAL_ONE_LINK.md): one link that logs in and saves PayPal.
    const connect = results.find(r => r.needsConnect)
    const quote = !paidSaved && results.find(r => r.needsConfirm && r.savedPaypal && r.amount != null)
    const change = results.find(r => r.changeUrl)
    return {
      reply,
      // What the caller should keep in its history for this user turn.
      userContent: message,
      media,
      payment: pay ? { url: pay.paymentUrl, amount: pay.amount, currency: pay.currency, service: pay.service, orderId: pay.orderId, holdMinutes: pay.holdMinutes, kind: pay.paymentKind || 'booking', plan: pay.plan?.name || null, savesPaypal: !!pay.savesPaypal } : null,
      paid: paidSaved ? { amount: paidSaved.amount, currency: paidSaved.currency, service: paidSaved.service, when: paidSaved.when, account: paidSaved.savedPaypal || null, balance: !!paidSaved.paid, allowance: paidSaved.paidUnder === 'allowance' ? { left: paidSaved.allowanceLeft } : null } : null,
      confirm: quote ? { amount: quote.amount, account: quote.savedPaypal } : null,
      link: change ? { url: change.changeUrl, label: 'Choose another PayPal account' } : null,
      connect: connect ? { url: connect.connectUrl || null } : null,
      joined: joined ? { plan: joined.service, kind: joined.kind, amount: joined.amount, currency: joined.currency, account: joined.savedPaypal || null } : null,
      bookingsChanged: (toolEvents || []).some(e => ['book_appointment', 'cancel_booking', 'reschedule_booking', 'pay_balance', 'my_saved_paypal', 'join_membership'].includes(e.name))
    }
  })
}

module.exports = { chatTurn }
