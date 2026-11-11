// @ts-check
'use strict'

// ─── Telegram webhooks (deployed) ─────────────────────────────────────────────
//   POST /telegram/webhook        Flow's demo bot
//   POST /telegram/bot/{botId}    a store's own bot (core/telegramBot.connectStoreBot)
// Telegram signs nothing, so setWebhook registers a secret it echoes back in
// X-Telegram-Bot-Api-Secret-Token; anything without the right one is refused.
// Always 200 after that, so Telegram never retries an update we already handled
// (core/telegramBot also drops duplicates by update_id). Locally, scripts/
// local-api.js long-polls instead, so no public URL is needed.

const crypto = require('crypto')
const bots = require('../core/telegramBot')
const { configured } = require('../services/telegram')

function secretOk(event, want) {
  const h = event.headers || {}
  const got = String(h['x-telegram-bot-api-secret-token'] || h['X-Telegram-Bot-Api-Secret-Token'] || '')
  if (!want || got.length !== want.length) return false
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

function parse(event) {
  try { return JSON.parse(event.body || '{}') } catch { return null }
}

exports.webhook = async (event) => {
  if (!configured() || !secretOk(event, process.env.TELEGRAM_WEBHOOK_SECRET || '')) return { statusCode: 401, body: '' }
  const update = parse(event)
  if (update) await bots.handleUpdate(update, bots.demoBot())
  return { statusCode: 200, body: '' }
}

exports.storeWebhook = async (event) => {
  const botId = event.pathParameters?.botId || (String(event.path || '').match(/\/telegram\/bot\/(\d+)/) || [])[1]
  const b = await bots.storeBot(botId)
  if (!b || !secretOk(event, b.secret)) return { statusCode: b ? 401 : 200, body: '' }   // an unknown bot: nothing to retry
  const update = parse(event)
  if (update) await bots.handleUpdate(update, b)
  return { statusCode: 200, body: '' }
}
