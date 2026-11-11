// @ts-check
'use strict'

// ─── Booking assistant ───────────────────────────────────────────────────────
// Builds the business's system prompt and runs the tool-calling chat on the one
// configured AI provider (services/ai: AI_PROVIDER, main + backup model). The
// tools themselves live in ./tools, shared with the voice and MCP channels.

const { getTools, executeTool, hasSideEffects } = require('./tools')
const ai = require('./ai')
const { formatMoney, currencyOf } = require('../utils/money')
const trace = require('./trace')
const log = require('../utils/logger')

// ── System prompt ───────────────────────────────────────────────────────────

// Render the structured refund schedule into one human-readable line the AI states
// verbatim. Tiers arrive widest-window-first; each {hoursBefore, refundPct} means
// "cancel at least hoursBefore in advance → refundPct% refund". A 0% no-show tail is
// implied so the AI never promises a refund for a no-show.
function formatRefundTiers(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return ''
  const sorted = [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore)
  const parts = sorted.map((t, i) =>
    i === 0
      ? `${t.hoursBefore}h+ before → ${t.refundPct}% refund`
      : `under ${sorted[i - 1].hoursBefore}h before → ${t.refundPct}% refund`
  )
  return `${parts.join('; ')}; no-show / after start → 0% refund`
}

function buildSystemPrompt(business, ragChunks) {
  const services = business.config.services
    .filter(s => s.active)
    .map(s => {
      let desc = `- ${s.name}: ${s.price ? formatMoney(s.price, currencyOf(business)) : 'price varies'}, ${s.duration ? `${s.duration} min` : 'duration varies'}`
      if (s.unitType === 'queue') desc += ' [token/queue system]'
      if (s.paymentMode && s.paymentMode !== 'none') desc += ` [${s.paymentMode}]`
      return desc
    })
    .join('\n')

  // 'Today' in the BUSINESS's timezone, not the server's.
  const tz = require('../utils/time').tzOf(business)
  const nowLocal = require('../utils/time').dayjs().tz(tz)
  const today = nowLocal.format('YYYY-MM-DD')
  const dayName = nowLocal.format('dddd')

  const hours = business.config.availability
    ? `Open: ${business.config.availability.open} to ${business.config.availability.close}`
    : ''

  // Details the business requires before a booking is confirmed. Phone defaults to
  // the WhatsApp number they're messaging from — only ask if a preferred one is wanted.
  const required = (business.config.requiredDetails || []).filter(d => d.required)
  const detailsLine = required.length
    ? `\nBefore confirming a booking, collect: ${required.map(d => d.label).join(', ')}. The phone number is the WhatsApp number they're messaging from unless they give a different one — don't ask for it again. Ask only for any details you don't already have.`
    : ''

  // Cancellation / reschedule / refund rules — short, always-relevant policies the
  // AI must state accurately. Structured (not RAG) so the AI always has the current
  // wording and never quotes a stale version.
  const pol = business.config.policies || {}
  const policyLines = [
    pol.cancellation && `Cancellation: ${pol.cancellation}`,
    pol.reschedule   && `Reschedule: ${pol.reschedule}`,
    formatRefundTiers(pol.refundTiers) && `Refund on cancellation: ${formatRefundTiers(pol.refundTiers)}`
  ].filter(Boolean)
  const policyBlock = policyLines.length
    ? `\nPolicies (state these accurately if asked; never invent terms not listed):\n${policyLines.join('\n')}`
    : ''

  // Source-of-truth precedence. Uploaded documents (RAG) can go stale or disagree
  // with the panel (e.g. an old PDF menu with old prices). The structured Services
  // and Policies are authoritative — tell the model which one wins so it never
  // quotes a conflicting document price/policy.
  const authorityLine = ragChunks?.length
    ? `\nIMPORTANT — source of truth: the Services and Policies above are authoritative. If "Business info" or any uploaded document gives a different price, duration, timing, or policy, IGNORE the document on that point and use the Services/Policies values above.`
    : ''

  return [
    `You are the booking assistant for ${business.name}, a ${business.type} business.`,
    `Today is ${dayName}, ${today}. Timezone: ${tz}.`,
    `You ONLY help with this business's services, bookings, prices, and hours. Politely refuse anything else.`,
    `\nServices:\n${services}`,
    hours,
    ragChunks?.length ? `\nBusiness info:\n${ragChunks.join('\n---\n')}` : '',
    detailsLine,
    policyBlock,
    authorityLine,
    `\nWhen a customer wants to book:`,
    `1. If they haven't specified a service, ask which one (or use list_services).`,
    `2. If they haven't specified a date/time, ask when.`,
    `3. Use check_availability to show open slots.`,
    `4. Once they confirm a slot, use book_appointment.`,
    `5. For queue services, use get_queue_token instead.`,
    `\nKeep responses short and conversational. Use the customer's language.`,
    `Write times as 9 AM, 2 PM, 10:30 AM (minutes only when not :00; never "2pm", "14:00" or a time without AM or PM).`,
    `Tone: ${business.config.ai_config?.tone || 'friendly and concise'}.`
  ].filter(Boolean).join('\n')
}

// ── Public API ──────────────────────────────────────────────────────────────

async function routeMessage(business, history, text, ragChunks, toolContext) {
  return trace.run(toolContext?.traceScope, () => routeMessageInner(business, history, text, ragChunks, toolContext))
}

async function routeMessageInner(business, history, text, ragChunks, toolContext) {
  // Customer names never reach the AI: with a
  // vault in the context, everything going in is tokenized and the reply decoded.
  const vault = toolContext?.pii
  if (vault?.size) return privately(vault, business, history, text, ragChunks, toolContext)
  // The city-wide concierge brings its own prompt; a business's assistant uses its config.
  const system = toolContext?.systemPrompt || buildSystemPrompt(business, ragChunks)
  const { main } = ai.models()
  // The concierge looks documents up through business_info when asked, so an
  // up-front passage count would only mislead there.
  trace.event('ai', `Asked ${ai.modelLabel(main)}`, toolContext?.catalog
    ? { tools: 'search, availability, booking, payments' }
    : { knowledgeChunks: (ragChunks || []).length })
  const t0 = Date.now()
  // Steps that changed something (booked, paid, cancelled), kept so a failure
  // later in the turn can still tell the customer what happened.
  const done = []
  try {
    const result = await ai.chat({
      system,
      history,
      text,
      note: toolContext?.timeNote || null,
      tools: getTools(toolContext),
      runTool: async (name, args) => {
        // With a name vault (privately), the tool gets real names and the AI the tokenized result.
        if (toolContext?.runToolHook) {
          const { real, shown } = await toolContext.runToolHook(name, args, (n, a) => executeTool(n, a, toolContext))
          if (hasSideEffects(name) && acted(real)) done.push({ name, args, result: real })
          return shown || real
        }
        const result = await executeTool(name, args, toolContext)
        if (hasSideEffects(name) && acted(result)) done.push({ name, args, result })
        return result
      },
      safeToRepeat: name => !hasSideEffects(name)
    })
    // Ran out of tool rounds after something went through: same as a failure below.
    if (result.gaveUp && done.length) result.reply = doneReply(done)
    // "usage", not "tokens": the trace hides any field named like a secret (/token/).
    trace.event('ai', `${ai.aiLabel(result.model)} replied`, { toolCalls: result.toolEvents.length, chars: result.reply.length, ...(result.usage ? { usage: tokenSummary(result.usage) } : {}) }, Date.now() - t0)
    return result
  } catch (err) {
    log.error('ai_chat_failed', err, { businessId: business?.businessId })
    // Something already went through: say what, instead of "try again", which
    // would invite the same booking and charge a second time.
    if (done.length) {
      trace.event('ai', 'AI stopped after a step went through: told the customer what was done', { reason: ai.errorReason(err), steps: done.map(d => d.name) })
      return { reply: doneReply(done), toolEvents: done, usedTools: true, model: main }
    }
    trace.event('ai', 'AI unavailable — apology sent', { reason: ai.errorReason(err) })
    return { reply: 'Sorry, I had a technical issue. Please try again in a moment.', toolEvents: [], usedTools: false, model: main }
  }
}

// The same turn with names as tokens: the prompt, history, message and every
// tool result go in tokenized; tool arguments are decoded just before the tool
// runs (an unknown token is refused); the reply is decoded before any channel
// shows or speaks it. The tool results returned to the caller stay real.
async function privately(vault, business, history, text, ragChunks, toolContext) {
  const { PROMPT_NOTE } = require('./pii')
  const system = `${vault.tokenize(toolContext.systemPrompt || buildSystemPrompt(business, ragChunks))}\n\n${PROMPT_NOTE}`
  const ctx = {
    ...toolContext,
    pii: null,
    systemPrompt: system,
    runToolHook: async (name, args, run) => {
      const unknown = vault.unknownTokens(args)
      if (unknown.length) return { real: { error: 'That name token isn\'t one this conversation has. Use the tokens exactly as they appear.' }, shown: null }
      const real = await run(name, vault.detokenizeDeep(args))
      return { real, shown: vault.tokenizeDeep(real) }
    }
  }
  const tokenHistory = (history || []).map(h => ({ ...h, content: vault.tokenizeDeep(h.content) }))
  trace.event('ai', 'Customer names go to the AI as tokens, never as names', { names_hidden: vault.size, decoded: 'only for the person reading or hearing the reply' })
  const out = await routeMessageInner(business, tokenHistory, vault.tokenize(text), ragChunks, ctx)
  const reply = vault.detokenize(out.reply, '')
  return { ...out, reply }
}

// Did the step change anything? A quote waiting for a yes, an error, or an
// explicit "not done" didn't. A PayPal link did (the customer can still pay it).
function acted(r) {
  if (!r || r.error || r.needsConfirm || r.needsConfirmation || r.simulated) return false
  if (r.booked === false && !r.paymentUrl) return false
  return !['cancelled', 'rescheduled', 'refunded', 'paid', 'saved', 'sent'].some(k => r[k] === false)
}

// The tools' own messages ("Booked and paid: $18 …"), which code wrote, not the AI.
function doneReply(done) {
  const lines = done.map(d => d.result.message).filter(m => typeof m === 'string' && m.trim())
  const what = lines.length ? lines.join('\n') : 'Your request went through.'
  return `${what}\nI lost my connection right after, so there's no need to ask again. Check My bookings for the details.`
}

// "in 9,800 (8,900 cached) · out 120": what the turn cost, cache hits included.
function tokenSummary(u) {
  const n = x => Number(x || 0).toLocaleString('en-US')
  const cached = Number(u.cache_read_input_tokens || 0)
  const input = Number(u.input_tokens || 0) + cached + Number(u.cache_creation_input_tokens || 0)
  return `in ${n(input)}${cached ? ` (${n(cached)} cached)` : ''} · out ${n(u.output_tokens)}`
}

module.exports = { routeMessage, buildSystemPrompt, executeTool, tokenSummary }
