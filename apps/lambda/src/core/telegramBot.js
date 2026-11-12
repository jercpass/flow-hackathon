// @ts-check
'use strict'

// ─── Telegram channel ────────────────────────────
// A real messaging app on the same engine as web chat: text, voice notes, audio,
// photos and PDFs go through core/demoChat, so the AI, booking tools, PayPal and
// the Under the hood timeline are identical. One entry point, handleUpdate(),
// serves the local poller and the deployed webhooks.
//
// Two kinds of bot:
//   • Flow's demo bot (TELEGRAM_BOT_TOKEN): the web demo hands out
//     t.me/<bot>?start=<code>, and /start <code> ties the chat to that session.
//     It books across the whole demo city, like web chat.
//   • A store's own bot: the owner pastes its BotFather token on the Business
//     side. It belongs to that demo session and books that store only.
//
// Payments: a "Pay with PayPal" link button, or, with saved PayPal, a one-tap
// "Yes, pay $40 with saved PayPal" button (the same yes as web chat's button).

const crypto = require('crypto')
const demo = require('./demoSession')
const tg = require('../services/telegram')
const trace = require('../services/trace')
const { store } = require('../services/demoStore')
const { formatMoney } = require('../utils/money')
const log = require('../utils/logger')

const MAX_TEXT = 1000
const MAX_HISTORY = 40          // entries (20 turns)
const UPDATE_SEEN_MS = 24 * 60 * 60 * 1000
const DEMO = 'demo'             // the demo bot's id in keys

const demoUrl = () => process.env.DASHBOARD_URL || 'the Flow demo site'

const MSG = {
  notLinked: () => `👋 I'm the <b>Flow</b> demo assistant.\n\nTo start, open ${tg.esc(demoUrl())}, start a session, then choose <b>Telegram</b> in the menu and tap <b>Open in Telegram</b>. That links this chat to your private demo.`,
  ended: () => `This demo session has ended, so I've forgotten it.\n\nStart a new one at ${tg.esc(demoUrl())} and tap <b>Open in Telegram</b> again.`,
  storeEnded: () => `This store's demo has ended, so this bot is no longer connected to Flow.`,
  expiredLink: () => `That link has expired or was already used by a session that ended.\n\nOpen ${tg.esc(demoUrl())}, start a session and tap <b>Open in Telegram</b> again.`,
  help: (storeName) => [
    '<b>Things to try</b>',
    storeName ? `• "Book me a haircut" at ${tg.esc(storeName)}` : '• "Book me a haircut" (I know your usual)',
    storeName ? '• "What times are free on Saturday?"' : '• "Is there a massage place near me this weekend?"',
    '• Send a 🎙 voice note (up to 1 minute), a 📷 photo of a style you want, or a 📄 file: PDF, Word, Excel or text, up to 4 MB',
    '• "Cancel my booking" (I quote the refund policy first)',
    '',
    'Pay with the PayPal button I send (sandbox, fake money). /unlink disconnects this chat.'
  ].join('\n'),
  unsupported: () => 'I can read text, 🎙 voice notes (up to 1 minute), 📷 photos and 📄 files (PDF, Word, Excel or text, up to 4 MB). Try one of those!',
  groups: () => 'Message me directly to book. I only work in private chats.'
}

// ── Bots ─────────────────────────────────────────────────────────────────────

/** @typedef {{ id: string, client: ReturnType<typeof tg.bot>, username?: string|null, businessId?: string|null, sid?: string|null }} Bot */

/** Flow's demo bot. */
function demoBot() {
  return { id: DEMO, client: tg.demoBot(), username: null, businessId: null, sid: null }
}

/** A store's own bot, by id (null when not connected or its session ended). */
async function storeBot(botId) {
  if (!/^\d{4,20}$/.test(String(botId || ''))) return null
  const rec = await store().getKey(`TGBOT#${botId}`, 'BOT')
  if (!rec?.token) return null
  return { id: String(botId), client: tg.bot(rec.token), username: rec.username, businessId: rec.businessId, sid: rec.sid, secret: rec.secret }
}

/** The bot a customer's chat belongs to (for booking messages sent later). */
async function botFor(botId) {
  if (!botId || botId === DEMO) return tg.configured() ? demoBot() : null
  return storeBot(botId)
}

const chatKey = (b, chatId) => `TGC#${b.id}#${chatId}`

// ── Linking (demo bot) ───────────────────────────────────────────────────────

/** The session's t.me start code for the demo bot (one per session). */
async function linkCodeFor(session) {
  if (session.telegramCode) {
    const existing = await store().getKey(`TGL#${session.telegramCode}`, 'LINK')
    if (existing?.sid === session.sid) return session.telegramCode
  }
  const code = crypto.randomBytes(18).toString('base64url')   // 24 chars of [A-Za-z0-9_-]
  await store().putKey(`TGL#${code}`, 'LINK', { sid: session.sid }, session.expiresAt)
  await store().updateSession(session.sid, { telegramCode: code })
  return code
}

/** What the web pages show: the demo bot's link, who's linked, and the session's store bots. */
async function linkStatus(session) {
  const stores = (session.telegramBots || []).map(b => ({ botId: b.botId, username: b.username, businessId: b.businessId, businessName: b.businessName || null, link: `https://t.me/${b.username}` }))
  const bot = await tg.botUsername()
  if (!tg.configured() || !bot) return { configured: false, stores }
  const code = await linkCodeFor(session)
  const t = session.telegram
  const current = t?.chatId ? await store().getKey(`TGC#${DEMO}#${t.chatId}`, 'CHAT') : null
  return {
    configured: true,
    bot,
    link: `https://t.me/${bot}?start=${code}`,
    linked: current?.sid === session.sid ? { username: t.username || null, firstName: t.firstName || null, linkedAt: t.linkedAt } : null,
    stores
  }
}

async function linkChat(b, chatId, from, session) {
  if (b.id === DEMO) {
    const old = session.telegram?.chatId
    if (old && old !== chatId) await store().deleteKey(`TGC#${DEMO}#${old}`, 'CHAT')
    await store().updateSession(session.sid, { telegram: { chatId, username: from?.username || null, firstName: from?.first_name || null, linkedAt: Date.now() } })
  }
  await store().putKey(chatKey(b, chatId), 'CHAT', { sid: session.sid }, session.expiresAt)
  // Booking messages, receipts and refunds reach this chat too (services/notify).
  await require('../services/dynamo/customers').updateCustomer(session.customerId, { telegram: { chatId, botId: b.id } })
  await trace.run(`sess:${session.sid}`, async () => trace.event('telegram', b.id === DEMO ? 'Telegram linked to this session' : `Telegram linked to the store's bot @${b.username}`, { user: from?.username ? `@${from.username}` : (from?.first_name || 'unknown') }))
}

/** Disconnect the demo bot's chat from this session (web "Unlink" button or /unlink). */
async function unlinkSession(session, { tell = true } = {}) {
  const chatId = session.telegram?.chatId
  if (chatId) {
    await store().deleteKey(`TGC#${DEMO}#${chatId}`, 'CHAT')
    if (tell && tg.configured()) await tg.demoBot().sendMessage(chatId, 'Unlinked from the Flow demo. Open the demo and tap <b>Open in Telegram</b> to link again.').catch(() => {})
  }
  await store().updateSession(session.sid, { telegram: null })
  await require('../services/dynamo/customers').updateCustomer(session.customerId, { telegram: null }).catch(() => {})
  await trace.run(`sess:${session.sid}`, async () => trace.event('telegram', 'Telegram unlinked', {}))
}

// ── A store's own bot ────────────────────────────────────────────────────────

const pollers = new Map()   // local runs only: botId → stop()

/**
 * The owner connects their store's bot (token from BotFather). The token is
 * checked with Telegram, kept server-side for the session's lifetime and never
 * shown again. Deployed, Telegram calls /telegram/bot/<id>; locally we poll.
 */
async function connectStoreBot(session, { token, businessId }) {
  const bid = businessId || session.businessId
  if (!demo.ownsBusiness(session, bid)) return { error: 'That business isn’t in this demo session.' }
  if (!/^\d{4,20}:[A-Za-z0-9_-]{30,}$/.test(String(token || '').trim())) return { error: 'That doesn’t look like a bot token. In Telegram, open @BotFather, send /newbot, then paste the token it gives you.' }
  const client = tg.bot(String(token).trim())
  let me
  try { me = await client.getMe() } catch { return { error: 'Telegram didn’t accept that token. Copy it again from @BotFather.' } }
  if (!me?.is_bot || !me.username) return { error: 'That token isn’t for a bot.' }
  const botId = String(me.id)

  // One bot per store in a session: connecting another replaces it.
  for (const old of (session.telegramBots || []).filter(x => x.businessId === bid && x.botId !== botId)) await disconnectStoreBot(session, old.botId)

  const secret = crypto.randomBytes(24).toString('hex')
  await store().putKey(`TGBOT#${botId}`, 'BOT', { token: String(token).trim(), username: me.username, businessId: bid, sid: session.sid, secret, connectedAt: Date.now() }, session.expiresAt)
  const fresh = await demo.getActiveSession(session.sid) || session
  const biz = await require('../services/dynamo/businesses').getBusiness(bid).catch(() => null)
  const list = [...(fresh.telegramBots || []).filter(x => x.botId !== botId), { botId, username: me.username, businessId: bid, businessName: biz?.name || null }]
  await store().updateSession(session.sid, { telegramBots: list })

  if (process.env.STAGE === 'local' || !process.env.API_URL) startPolling(await storeBot(botId))
  else await client.setWebhook(`${String(process.env.API_URL).replace(/\/$/, '')}/telegram/bot/${botId}`, secret)
  await trace.run(`sess:${session.sid}`, async () => trace.event('telegram', `Store bot connected: @${me.username}`, { business: bid }))
  return { connected: true, botId, username: me.username, link: `https://t.me/${me.username}` }
}

async function disconnectStoreBot(session, botId) {
  const b = await storeBot(botId)
  if (b && b.sid !== session.sid) return { error: 'That bot isn’t connected to this session.' }
  if (b) {
    if (pollers.has(b.id)) { pollers.get(b.id)(); pollers.delete(b.id) }
    else await b.client.deleteWebhook().catch(() => {})
    await store().deleteKey(`TGBOT#${botId}`, 'BOT')
  }
  const fresh = await demo.getActiveSession(session.sid) || session
  await store().updateSession(session.sid, { telegramBots: (fresh.telegramBots || []).filter(x => x.botId !== String(botId)) })
  return { disconnected: true }
}

// ── Media ────────────────────────────────────────────────────────────────────

/** A Telegram message's file → the same attachment shape web chat uploads. */
async function attachmentFrom(b, msg) {
  const media = require('../services/media')
  const docs = require('../services/docText')
  const tooBig = kind => new media.MediaError(kind === 'audio' ? `Voice notes can be up to ${media.MAX_VOICE_SECONDS / 60} minute. Send a shorter one, or type it.` : `That file is too large (max ${media.MAX_FILE_MB} MB).`)
  let pick = null
  if (msg.voice) pick = { kind: 'audio', file: msg.voice, mimeType: msg.voice.mime_type || 'audio/ogg', name: 'voice-note', durationSec: msg.voice.duration }
  else if (msg.audio) pick = { kind: 'audio', file: msg.audio, mimeType: msg.audio.mime_type || 'audio/mpeg', name: msg.audio.file_name || 'audio', durationSec: msg.audio.duration }
  else if (msg.photo?.length) {
    // Sizes come smallest first; take the largest that fits the limit.
    const fits = msg.photo.filter(p => !p.file_size || p.file_size <= media.LIMITS.image)
    const file = fits[fits.length - 1] || msg.photo[0]
    pick = { kind: 'image', file, mimeType: 'image/jpeg', name: 'photo.jpg' }
  } else if (msg.document) {
    const mt = String(msg.document.mime_type || '').toLowerCase()
    const name = msg.document.file_name || ''
    // Word, Excel and text files are known by their name first: phones often send them as octet-stream.
    const kind = docs.docTypeOf(name, mt) ? 'doc' : mt === 'application/pdf' ? 'pdf' : mt.startsWith('image/') ? 'image' : mt.startsWith('audio/') ? 'audio' : null
    if (!kind) throw new media.MediaError(docs.unsupportedMessage(name))
    pick = { kind, file: msg.document, mimeType: mt, name: name || kind }
  }
  if (!pick) return null
  // Checked before downloading: Telegram tells us the length and size up front.
  if (pick.kind === 'audio' && pick.durationSec > media.MAX_VOICE_SECONDS + 1) throw tooBig('audio')
  if (pick.file.file_size && pick.file.file_size > media.LIMITS[pick.kind]) throw tooBig(pick.kind)
  const buffer = await b.client.downloadFile(pick.file.file_id)
  return media.parseAttachment({ kind: pick.kind, mimeType: pick.mimeType, data: buffer.toString('base64'), name: pick.name, durationSec: pick.durationSec })
}

// ── Conversation history (server-side; Telegram has no client to keep it) ────

async function loadHistory(b, sid) {
  const h = await store().getKey(`S#${sid}`, `TGH#${b.id}`)
  return Array.isArray(h?.turns) ? h.turns : []
}
async function saveHistory(b, session, turns) {
  await store().putKey(`S#${session.sid}`, `TGH#${b.id}`, { turns: turns.slice(-MAX_HISTORY) }, session.expiresAt)
}

// ── Updates ──────────────────────────────────────────────────────────────────

/** Handle one Telegram update for one bot (from a poller or a webhook). Never throws. */
async function handleUpdate(update, b = demoBot()) {
  try {
    if (!update || typeof update.update_id !== 'number') return
    // A retry of one we handled (the claim is first-come, so the owner is unique per call).
    const seen = await store().claimKey(`TGU#${b.id}#${update.update_id}`, 'U', crypto.randomBytes(6).toString('hex'), Date.now() + UPDATE_SEEN_MS)
    if (!seen.claimed) return
    if (update.callback_query) return void await onButton(b, update.callback_query)
    const msg = update.message
    if (!msg?.chat) return                                   // edits, reactions, channel posts…
    const chatId = msg.chat.id
    if (msg.chat.type !== 'private') return void await b.client.sendMessage(chatId, MSG.groups())

    const text = String(msg.text || msg.caption || '').trim()
    if (/^\/help(\s|$|@)/.test(text)) return void await b.client.sendMessage(chatId, MSG.help(await storeName(b)))
    if (b.id === DEMO && /^\/start(\s|$|@)/.test(text)) return void await onStart(b, chatId, msg, text)

    const isStart = /^\/start(\s|$|@)/.test(text)
    // /start welcomes below, so linking a new chat mustn't welcome it too.
    const session = await sessionFor(b, chatId, msg, { welcome: !isStart })
    if (!session) return
    if (/^\/unlink(\s|$|@)/.test(text)) {
      if (b.id === DEMO) return void await unlinkSession(session)
      await store().deleteKey(chatKey(b, chatId), 'CHAT')
      return void await b.client.sendMessage(chatId, 'Unlinked. Send any message to start again.')
    }
    if (isStart) return void await welcome(b, chatId, session)
    await onMessage(b, chatId, msg, text, session)
  } catch (err) {
    log.error('telegram_update_failed', err, { updateId: update?.update_id, bot: b?.id })
    const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id
    if (chatId) await b.client.sendMessage(chatId, 'Sorry, something went wrong on my side. Please try again in a moment.').catch(() => {})
  }
}

// The session a chat books in: the demo bot needs a /start link first; a store's
// bot belongs to its session, so the first message (usually the /start sent by
// opening t.me/<bot> and tapping Start) links the chat right away.
async function sessionFor(b, chatId, msg, { welcome: greet = true } = {}) {
  if (b.id !== DEMO) {
    const session = b.sid ? await demo.getActiveSession(b.sid) : null
    if (!session) { await b.client.sendMessage(chatId, MSG.storeEnded()); return null }
    const link = await store().getKey(chatKey(b, chatId), 'CHAT')
    if (link?.sid !== session.sid) {
      await linkChat(b, chatId, msg?.from, session)
      if (greet) await welcome(b, chatId, session)
    }
    return session
  }
  const link = await store().getKey(chatKey(b, chatId), 'CHAT')
  const session = link ? await demo.getActiveSession(link.sid) : null
  if (!session) {
    if (link) await store().deleteKey(chatKey(b, chatId), 'CHAT')
    await b.client.sendMessage(chatId, link ? MSG.ended() : MSG.notLinked())
    return null
  }
  return session
}

async function storeName(b) {
  if (b.id === DEMO || !b.businessId) return null
  const biz = await require('../services/dynamo/businesses').getBusiness(b.businessId).catch(() => null)
  return biz?.name || null
}

async function onStart(b, chatId, msg, text) {
  const code = text.split(/\s+/)[1] || ''
  if (!code) {
    const link = await store().getKey(chatKey(b, chatId), 'CHAT')
    const session = link ? await demo.getActiveSession(link.sid) : null
    return session ? welcome(b, chatId, session) : b.client.sendMessage(chatId, MSG.notLinked())
  }
  const l = /^[A-Za-z0-9_-]{16,64}$/.test(code) ? await store().getKey(`TGL#${code}`, 'LINK') : null
  const session = l ? await demo.getActiveSession(l.sid) : null
  if (!session) return b.client.sendMessage(chatId, MSG.expiredLink())
  await linkChat(b, chatId, msg.from, session)
  return welcome(b, chatId, session)
}

// The welcome comes with Flow's short logo animation (assets/telegram-welcome.mp4,
// 640×360, silent, so Telegram loops it like a GIF). It uploads once per bot; then
// Telegram's file_id for it is reused (a file_id belongs to the bot that sent it).
const WELCOME_ANIMATION = require('path').join(__dirname, '../assets/telegram-welcome.mp4')
const animationIds = new Map()   // bot id → file_id
let animationFile
function welcomeAnimation(botId) {
  if (animationIds.has(botId)) return animationIds.get(botId)
  if (animationFile === undefined) {
    try { animationFile = require('fs').readFileSync(WELCOME_ANIMATION) } catch { animationFile = null }
  }
  return animationFile
}
// What Telegram counts against the 1024-character caption: the text, not the tags.
const visibleLength = html => String(html).replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot);/g, '_').length

// Who you're booking as, and Log in with PayPal if you haven't yet (then your
// saved PayPal pays in one tap).
async function welcome(b, chatId, session) {
  const name = await storeName(b)
  const loggedIn = !!session.paypalLogin
  let loginUrl = null
  if (!loggedIn) loginUrl = (await require('./paypalLogin').start(session).catch(() => null))?.url || null
  const lines = [
    name ? `✅ Hi! I'm <b>${tg.esc(name)}</b>'s booking assistant, run by Flow.` : `✅ Linked! You're <b>${tg.esc(session.customerName)}</b> in Flow's Austin demo.`,
    loggedIn ? `You're logged in with PayPal as <b>${tg.esc(session.customerName)}</b>.` : 'Log in with PayPal first: you book under your PayPal name, and PayPal offers to save it so bookings pay in one tap.',
    'Everything here shows up in the web demo too: My bookings, the inbox, the owner\'s calendar and Under the hood.',
    '',
    MSG.help(name)
  ]
  const html = lines.join('\n')
  const opts = loginUrl ? { buttons: [{ text: 'Log in with PayPal', url: loginUrl }] } : {}
  const animation = welcomeAnimation(b.id)
  if (animation && visibleLength(html) <= 1024) {
    try {
      const sent = await b.client.sendAnimation(chatId, animation, { caption: html, ...opts, width: 640, height: 360, filename: 'flow.mp4' })
      const fileId = sent?.animation?.file_id || sent?.document?.file_id
      if (fileId) animationIds.set(b.id, fileId)
      return sent
    } catch (e) {
      // Never lose the welcome over the animation: send it as text instead.
      animationIds.delete(b.id)
      log.warn('telegram_welcome_animation_failed', { bot: b.id === DEMO ? DEMO : 'store', code: e.code, status: e.status })
    }
  }
  return b.client.sendMessage(chatId, html, opts)
}

// A button press is sent as the customer's message, like web chat's buttons:
// the saved-PayPal "yes", or asking for a PayPal link instead.
async function onButton(b, cq) {
  const chatId = cq.message?.chat?.id
  await b.client.answerCallback(cq.id).catch(() => {})
  if (!chatId) return
  const data = String(cq.data || '')
  const m = data.match(/^pay:(\d+(?:\.\d{1,2})?)$/)
  if (!m && data !== 'link') return
  const session = await sessionFor(b, chatId, { from: cq.from })
  if (!session) return
  await onMessage(b, chatId, { from: cq.from }, m ? `Yes, pay ${formatMoney(Number(m[1]))} with my saved PayPal.` : "I'd rather pay on PayPal. Send me a PayPal link instead.", session)
}

async function onMessage(b, chatId, msg, text, session) {
  let attachment = null
  try {
    attachment = await attachmentFrom(b, msg)
  } catch (err) {
    if (err.code === 'MEDIA_INVALID') return b.client.sendMessage(chatId, tg.esc(err.message))
    throw err
  }
  if (!text && !attachment) return b.client.sendMessage(chatId, MSG.unsupported())
  b.client.sendChatAction(chatId, 'typing').catch(() => {})

  const history = await loadHistory(b, session.sid)
  let turn
  try {
    turn = await require('./demoChat').chatTurn(session, {
      typed: text.slice(0, MAX_TEXT), attachment, history, channel: 'telegram',
      onlyBusinessId: b.id === DEMO ? null : b.businessId, ctxExtra: { telegramChatId: chatId }
    })
  } catch (err) {
    if (err.code === 'DEMO_LIMIT' || err.code === 'MEDIA_BUSY') return b.client.sendMessage(chatId, tg.esc(err.message))
    if (err.code === 'SESSION_DATA_MISSING') return b.client.sendMessage(chatId, MSG.ended())
    throw err
  }
  await saveHistory(b, session, [...history, { role: 'user', content: turn.userContent }, { role: 'assistant', content: turn.reply }])

  const heard = turn.media?.kind === 'audio' && turn.media.transcript ? `<i>🎙 “${tg.esc(turn.media.transcript)}”</i>\n\n` : ''
  const buttons = []
  if (turn.payment?.url) buttons.push({ text: `${turn.payment.kind === 'subscription' ? 'Subscribe' : 'Pay'} ${turn.payment.amount != null ? formatMoney(turn.payment.amount, turn.payment.currency) : ''} with PayPal`.replace('  ', ' '), url: turn.payment.url })
  if (turn.confirm?.amount != null) buttons.push({ text: `Yes, pay ${formatMoney(turn.confirm.amount)} with saved PayPal`, data: `pay:${turn.confirm.amount}` })
  // Not connected yet: the one link (log in + save PayPal); after that every payment is a yes here.
  if (turn.connect?.url) buttons.push({ text: 'Connect PayPal', url: turn.connect.url })
  const html = heard + tg.toHtml(turn.reply || '…')

  // Asked by voice (say, while driving): the answer comes back by voice too, spoken
  // by Amazon Polly in the reply's language, with the text and buttons as its
  // caption so Pay is still one tap. If Polly or the upload fails, the text goes.
  let spoken = null
  if (heard && turn.reply) {
    b.client.sendChatAction(chatId, 'record_voice').catch(() => {})
    spoken = await trace.run(`sess:${session.sid}`, () => require('../services/cloudTts').voiceMessage(require('./voice').speakable(turn.reply)))
  }
  let asVoice = false
  if (spoken) {
    try {
      const fits = html.length <= 1024
      await b.client.sendVoice(chatId, spoken.buffer, { mimeType: spoken.mimeType, ...(fits ? { caption: html, buttons } : {}) })
      if (!fits) await b.client.sendMessage(chatId, html, buttons.length ? { buttons } : {})
      asVoice = true
    } catch (err) {
      log.warn('telegram_voice_reply_failed', { err: String(err.message).slice(0, 160) })
    }
  }
  if (!asVoice) await b.client.sendMessage(chatId, html, buttons.length ? { buttons } : {})
  const sent = asVoice ? (b.id === DEMO ? 'Voice reply sent on Telegram' : `Voice reply sent by @${b.username}`) : (b.id === DEMO ? 'Reply sent on Telegram' : `Reply sent by @${b.username}`)
  await trace.run(`sess:${session.sid}`, async () => trace.event('telegram', sent, { chars: (turn.reply || '').length, ...(asVoice ? { voice: spoken.voice } : {}), ...(buttons.length ? { buttons: buttons.map(x => x.text).join(', ') } : {}) }))
}

// ── Local polling (no public URL needed) ─────────────────────────────────────

/** Long-poll one bot's updates until stopped; used by scripts/local-api.js and local store bots. */
function startPolling(b, { onError = err => log.warn('telegram_poll_error', { message: err.message, bot: b?.id }) } = {}) {
  if (!b) return () => {}
  if (pollers.has(b.id)) return pollers.get(b.id)
  let stopped = false
  const stop = () => { stopped = true }
  pollers.set(b.id, stop)
  ;(async () => {
    await b.client.deleteWebhook().catch(onError)
    let offset = 0
    while (!stopped) {
      try {
        const updates = await b.client.getUpdates(offset, 25)
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1)
          if (!stopped) await handleUpdate(u, b)
        }
      } catch (err) {
        onError(err)
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  })()
  return stop
}

module.exports = { handleUpdate, demoBot, storeBot, botFor, linkStatus, linkCodeFor, unlinkSession, connectStoreBot, disconnectStoreBot, attachmentFrom, startPolling, MSG }
