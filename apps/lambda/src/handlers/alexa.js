// @ts-check
'use strict'

// ─── Alexa skill endpoint ─────────────────────────────────────────────────────
// Deployed, the skill calls this Lambda directly (serverless.yml alexaSkill
// event; core/alexa checks ALEXA_SKILL_ID when it's set), so there's no HTTPS
// endpoint whose request signatures we'd have to verify. Locally, POST a skill
// request to /alexa on scripts/local-api.js to try it.

const { handle, runWork } = require('../core/alexa')

exports.handler = async (event) => {
  if (event?.warm) return { warm: true }   // keep-warm ping (serverless.yml custom.warm)
  // A long Alexa turn, finished off Alexa's clock (core/alexa.js, Long turns).
  if (event?.flowAlexaWork) return runWork(event.flowAlexaWork)
  return handle(event)
}

// Local only: the same request over HTTP (no signature check, so never deployed as a route).
exports.local = async (event) => {
  if (process.env.STAGE !== 'local') return { statusCode: 404, body: '' }
  let body = null
  try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 400, body: '' } }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await handle(body)) }
}
