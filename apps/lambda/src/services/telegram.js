// @ts-check
'use strict'

// ─── Telegram Bot API client ─────────────────────────────────────────────────
// Thin fetch wrapper (no SDK). One client per bot: Flow's demo bot (token from
// the environment) or a store's own bot (token the owner connected, see
// core/telegramBot). The token lives in the request URL, so URLs are never
// logged; errors carry Telegram's description and code only.

const API = 'https://api.telegram.org'

function fail(method, j, status) {
  return Object.assign(new Error(`Telegram ${method} failed: ${j.description || `HTTP ${status}`}`), { status: j.error_code || status, code: 'TELEGRAM_API' })
}

// One button a row: a link opens a page; data comes back as a button press.
const keyboard = buttons => ({ inline_keyboard: buttons.map(b => [b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: String(b.data).slice(0, 64) }]) })

/** A client for one bot. */
function bot(token) {
  if (!token) throw Object.assign(new Error('Telegram bot token missing'), { code: 'TELEGRAM_NOT_CONFIGURED' })

  async function call(method, body, { timeoutMs = 20000 } = {}) {
    const r = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const j = await r.json().catch(() => ({}))
    if (!j.ok) throw fail(method, j, r.status)
    return j.result
  }

  return {
    call,
    getMe: () => call('getMe'),
    /**
     * An HTML message, optionally with buttons (one per row): `url` opens a page,
     * `data` comes back as a button press (callback_query).
     * @param {number|string} chatId
     * @param {string} html  Telegram HTML subset; callers escape user/AI text
     * @param {{ buttons?: { text: string, url?: string, data?: string }[] }} [opts]
     */
    sendMessage(chatId, html, { buttons } = {}) {
      return call('sendMessage', {
        chat_id: chatId,
        text: String(html).slice(0, 4096),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(buttons?.length ? { reply_markup: keyboard(buttons) } : {})
      })
    },
    /**
     * A voice message (MP3 plays as one), optionally with the written reply as its
     * caption (up to 1024 characters, Telegram HTML) and the same buttons.
     */
    async sendVoice(chatId, buffer, { caption, buttons, mimeType = 'audio/mpeg' } = {}) {
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append('voice', new Blob([buffer], { type: mimeType }), mimeType === 'audio/mpeg' ? 'reply.mp3' : 'reply.ogg')
      if (caption) { form.append('caption', String(caption).slice(0, 1024)); form.append('parse_mode', 'HTML') }
      if (buttons?.length) form.append('reply_markup', JSON.stringify(keyboard(buttons)))
      const r = await fetch(`${API}/bot${token}/sendVoice`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
      const j = await r.json().catch(() => ({}))
      if (!j.ok) throw fail('sendVoice', j, r.status)
      return j.result
    },
    /**
     * A looping animation (a silent MP4 plays as a GIF) with an HTML caption and
     * buttons. The caption isn't cut (that could split a tag): Telegram refuses one
     * over 1024 visible characters, and the caller falls back to a text message.
     * `animation` is the file as a Buffer, or the file_id Telegram returned for it
     * earlier (that bot's own, so no re-upload).
     */
    async sendAnimation(chatId, animation, { caption, buttons, filename = 'flow.mp4', width, height } = {}) {
      const extra = {
        ...(caption ? { caption: String(caption), parse_mode: 'HTML' } : {}),
        ...(buttons?.length ? { reply_markup: keyboard(buttons) } : {})
      }
      if (typeof animation === 'string') return call('sendAnimation', { chat_id: chatId, animation, ...extra })
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append('animation', new Blob([animation], { type: 'video/mp4' }), filename)
      if (width && height) { form.append('width', String(width)); form.append('height', String(height)) }
      for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
      const r = await fetch(`${API}/bot${token}/sendAnimation`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
      const j = await r.json().catch(() => ({}))
      if (!j.ok) throw fail('sendAnimation', j, r.status)
      return j.result
    },
    sendChatAction: (chatId, action = 'typing') => call('sendChatAction', { chat_id: chatId, action }),
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: String(text).slice(0, 200) } : {}) }),
    /** Send a file (e.g. the PDF receipt). */
    async sendDocument(chatId, buffer, filename, caption) {
      const form = new FormData()
      form.append('chat_id', String(chatId))
      if (caption) form.append('caption', String(caption).slice(0, 1024))
      form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename || 'receipt.pdf')
      const r = await fetch(`${API}/bot${token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
      const j = await r.json().catch(() => ({}))
      if (!j.ok) throw fail('sendDocument', j, r.status)
      return j.result
    },
    /** Download a file the user sent (voice note, photo, document) as a Buffer. */
    async downloadFile(fileId) {
      const f = await call('getFile', { file_id: fileId })
      if (!f?.file_path) throw Object.assign(new Error('Telegram returned no file path'), { code: 'TELEGRAM_API' })
      const r = await fetch(`${API}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(30000) })
      if (!r.ok) throw Object.assign(new Error(`Telegram file download failed: HTTP ${r.status}`), { status: r.status, code: 'TELEGRAM_API' })
      return Buffer.from(await r.arrayBuffer())
    },
    getUpdates: (offset, timeoutSec = 25) => call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (timeoutSec + 10) * 1000 }),
    setWebhook: (url, secretToken) => call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }),
    deleteWebhook: () => call('deleteWebhook', { drop_pending_updates: false })
  }
}

// ── Flow's demo bot ──────────────────────────────────────────────────────────

function configured() { return !!process.env.TELEGRAM_BOT_TOKEN }
function demoBot() { return bot(process.env.TELEGRAM_BOT_TOKEN) }

let me = null
/** The demo bot's @username (env first, otherwise asked once from Telegram). */
async function botUsername() {
  if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, '')
  if (!configured()) return null
  if (!me) me = await demoBot().getMe().catch(() => null)
  return me?.username || null
}

// Telegram HTML needs only &, < and > escaped.
function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

/** The AI's light markdown (**bold**, "* " / "- " bullets) → Telegram HTML. */
function toHtml(text) {
  return String(text || '').split('\n').map(line => {
    const bullet = line.match(/^\s*[*-]\s+(.*)$/)
    const body = esc(bullet ? bullet[1] : line).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    return bullet ? `• ${body}` : body
  }).join('\n')
}

module.exports = { bot, configured, demoBot, botUsername, esc, toHtml }
