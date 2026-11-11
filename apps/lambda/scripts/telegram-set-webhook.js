// Register the deployed webhook for Flow's demo Telegram bot (run once after deploying).
// Store bots set their own webhook when the owner connects them.
//   node scripts/telegram-set-webhook.js            → uses API_URL + TELEGRAM_WEBHOOK_SECRET
//   node scripts/telegram-set-webhook.js --delete   → back to polling (local dev)
require('./loadEnv').loadEnv()
const tg = require('../src/services/telegram')

;(async () => {
  if (process.argv.includes('--delete')) {
    await tg.demoBot().deleteWebhook()
    console.log('Webhook removed. scripts/local-api.js will long-poll instead.')
    return
  }
  const api = String(process.env.API_URL || '').replace(/\/$/, '')
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!/^https:\/\//.test(api)) throw new Error('API_URL must be the deployed https API (Telegram only calls https webhooks)')
  if (!secret) throw new Error('Set TELEGRAM_WEBHOOK_SECRET first (letters, digits, _ and -; up to 256 chars)')
  await tg.demoBot().setWebhook(`${api}/telegram/webhook`, secret)
  console.log(`Webhook set → ${api}/telegram/webhook as @${await tg.botUsername()}`)
})().catch(err => { console.error(err.message); process.exit(1) })
