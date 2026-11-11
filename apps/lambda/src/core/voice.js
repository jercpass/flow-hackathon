// @ts-check
'use strict'

// ─── Flow Voice (the voice assistant) ──────────────────────────────────────
// The voice assistant in the browser sends one small JSON request per turn and
// gets the reply to speak back:
//
//   request  { version: 1, session: { new, attributes: { history } },
//              request: { type: 'start' | 'say' | 'help' | 'stop' | 'end', text? } }
//   response { version: 1, session: { attributes }, reply: { speech, card?, reprompt?, end } }
//
// The conversation travels in session.attributes, so the server keeps no state.
// The thinking is the same Flow concierge as the web chat (same tools, same
// city, same history); only the reply style changes for speaking out loud.

const { routeMessage } = require('../services/aiRouter')
const trace = require('../services/trace')

const MAX_TURNS = 20
const TYPES = ['start', 'say', 'help', 'stop', 'end']

const VOICE_STYLE = `

You are SPEAKING out loud through a voice assistant right now:
- Talk like a friendly receptionist on the phone: one to three short, complete, natural sentences, in the language the customer spoke. No lists, labels ("Booked:", "Service:"), headings, markdown, emojis, links or symbols such as ·, /, brackets or dashes.
- Say dates the way people do ("Tuesday, November 3rd", "this Saturday"), never as numbers like 11/03 or 2026-11-03. Never read out IDs, codes or order numbers.
- Write times as 3 PM or 10:30 AM and prices as $40: the reply is also shown on screen, and the voice reads them naturally.
- Offer at most two or three options, and ask one question at a time.
- Payments come from the PayPal they linked once in Flow: ask "Pay $40 with your saved PayPal?" and pay only after a yes. If PayPal isn't linked yet (needsConnect), say so and that the Connect PayPal link is in their Flow inbox; nothing was booked or charged.`

class VoiceRequestError extends Error {
  constructor(message) { super(message); this.code = 'VOICE_INVALID' }
}

function validate(env) {
  if (!env || env.version !== 1 || typeof env.request !== 'object' || !env.request) throw new VoiceRequestError('Not a Flow Voice request')
  const type = env.request.type
  if (!TYPES.includes(type)) throw new VoiceRequestError(`Unsupported request type ${type}`)
  return type
}

// What a speaker should actually say: no markdown, links, bullets, emoji or
// symbols. A list becomes a spoken list ("3 PM, 4 PM"); a dot, bar, dash or
// bracket becomes a pause (a comma), so nothing is read out as a symbol.
function speakable(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[\u2705\u2713\u2714\u274C\u2B50]|[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/^\s*[-*\u2022]\s+/, '')
    .replace(/\n\s*[-*\u2022]\s+/g, ', ')
    .replace(/[#*_`>]/g, '')
    .replace(/([^\s.?!:,])[ \t]*\n+\s*/g, '$1. ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s*[\u00B7|]\s*/g, ', ')
    .replace(/\s+[\u2014\u2013]\s+/g, ', ')
    .replace(/\(([^)]*)\)/g, ', $1,')
    .replace(/\s+,/g, ',')
    .replace(/,(\s*,)+/g, ',')
    .replace(/([.?!:])\s*,\s*/g, '$1 ')
    .replace(/,\s*([.?!])/g, '$1')
    .replace(/,\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 600)
}

function response({ speech, cardTitle, cardText, reprompt, end, attributes }) {
  return {
    version: 1,
    session: { attributes: attributes || {} },
    reply: {
      speech,
      ...(cardText ? { card: { title: cardTitle || 'Flow', text: cardText } } : {}),
      ...(reprompt ? { reprompt } : {}),
      end: !!end
    }
  }
}

// What the timeline says for the turns that aren't a sentence from the customer.
const OPENED = { start: 'opened', help: 'the customer asked for help', stop: 'closed' }

/**
 * Handle one voice request. On Under the hood it ends with "<via> replied" and
 * what was said; the caller already logged what it heard.
 * @param {object} env - the request (see the top of this file)
 * @param {object} c - { business, customer, ctx, via? } — the concierge context from the demo session; via names the channel ('Flow Voice' or 'Alexa')
 * @returns {Promise<{ voice: object, speech: string, payment: object|null, bookingsChanged: boolean }>}
 */
async function handle(env, c) {
  const via = c.via || 'Flow Voice'
  if (OPENED[env?.request?.type]) trace.event('session', `${via}: ${OPENED[env.request.type]}`, {})
  const out = await turn(env, c)
  if (out.speech) trace.event('session', `${via} replied`, { reply: out.speech.slice(0, 200) })
  return out
}

async function turn(env, { business, customer, ctx }) {
  const type = validate(env)
  const first = (customer.name || 'there').split(' ')[0]
  const history = Array.isArray(env.session?.attributes?.history) ? env.session.attributes.history.slice(-MAX_TURNS * 2) : []

  if (type === 'start') {
    const speech = `Hi ${first}! Flow here. What would you like to book?`
    return { voice: response({ speech, reprompt: 'You can say, book me a haircut.', attributes: { history } }), speech, payment: null, bookingsChanged: false }
  }
  if (type === 'end') {
    return { voice: response({ speech: '', end: true }), speech: '', payment: null, bookingsChanged: false }
  }
  if (type === 'stop') {
    const speech = `Okay. Bye for now, ${first}!`
    return { voice: response({ speech, end: true }), speech, payment: null, bookingsChanged: false }
  }
  if (type === 'help') {
    const speech = 'You can say things like: book me a haircut, find a massage near me this weekend, or what are my bookings?'
    return { voice: response({ speech, reprompt: 'What would you like to book?', attributes: { history } }), speech, payment: null, bookingsChanged: false }
  }

  const utterance = String(env.request.text || '').trim().slice(0, 500)
  // Nothing heard (or Alexa's fallback, which carries no words): say what works.
  if (!utterance) {
    const speech = "Sorry, I didn't catch that. You can say things like: book me a haircut tomorrow at eleven, find a spa near me, or what are my bookings?"
    return { voice: response({ speech, reprompt: 'What would you like to book?', attributes: { history } }), speech, payment: null, bookingsChanged: false }
  }

  const voiceCtx = { ...ctx, channel: 'speaker', systemPrompt: `${ctx.systemPrompt}${VOICE_STYLE}` }
  const { reply, toolEvents } = await routeMessage(business, history, utterance, [], voiceCtx)
  const speech = speakable(reply) || 'Sorry, something went wrong. Please try again.'
  const pay = (toolEvents || []).map(e => e.result).find(r => r && r.paymentUrl) || null
  // Not connected yet: the connect link went to the Flow inbox (tools connectFirst).
  const connect = (toolEvents || []).map(e => e.result).find(r => r && r.needsConnect) || null
  const attributes = { history: [...history, { role: 'user', content: utterance }, { role: 'assistant', content: reply }].slice(-MAX_TURNS * 2) }
  return {
    voice: response({
      speech,
      cardTitle: pay ? `Pay to confirm: ${pay.service || pay.plan?.name || 'Flow'}` : connect ? 'Connect your PayPal' : 'Flow',
      cardText: pay ? `${speech}\nThe PayPal link is in your Flow inbox, or tap Pay below.` : connect ? `${speech}\nThe Connect PayPal link is in your Flow inbox.` : speech,
      reprompt: 'Anything else?',
      attributes
    }),
    speech,
    payment: pay ? { url: pay.paymentUrl, amount: pay.amount, currency: pay.currency, service: pay.service, holdMinutes: pay.holdMinutes, kind: pay.paymentKind || 'booking' } : null,
    connect: connect ? { url: connect.connectUrl || null } : null,
    bookingsChanged: (toolEvents || []).some(e => ['book_appointment', 'cancel_booking', 'reschedule_booking'].includes(e.name))
  }
}

module.exports = { handle, speakable, validate, VoiceRequestError }
