// @ts-check
'use strict'

// ─── The AI provider for the backend's thinking ─────────────────────────────
// The booking assistant and its tools, reading photos/PDFs, business setup and
// answers from documents go to ONE provider (Oct 21).
// AI_PROVIDER picks it; without it, Claude when an Anthropic key is set (it's
// the cheapest: Haiku), else Gemini. AI_MODEL / AI_BACKUP_MODEL override that
// provider's models only.
//
// Resilience stays inside that provider: each request is retried on 503/429,
// and if the main model is still down, the same provider's backup model
// answers. In a tool-calling chat the backup only takes over if no tool with a
// side effect ran (booking, cancelling…), so a booking step is never repeated;
// read-only lookups are safe to redo.
//
// Voice-note transcripts go to Groq's Whisper first (services/speechToText),
// with Gemini here as the backup; spoken replies are Amazon Polly (cloudTts).
// The knowledge base is Claude's Files API (services/rag); Gemini is only a backup.

const trace = require('./trace')
const log = require('../utils/logger')
const { withRetry } = require('../utils/retry')
const { modelName } = require('../utils/modelName')

const DEFAULTS = {
  gemini:    { main: 'gemini-3.5-flash', backup: 'gemini-3.5-flash-lite' },
  // Haiku is fast and the cheapest; Sonnet only steps in when Haiku is down.
  anthropic: { main: 'claude-haiku-5-5', backup: 'claude-sonnet-5-5' }
}

const MAX_TOOL_ROUNDS = 5

// Every AI call has a time limit, and each turn an overall budget, so a slow
// model can't hang a request (on AWS, API Gateway cuts requests off at 29 s).
// The backup model or the other provider is only tried while time is left.
const CALL_LIMIT_MS = 15000
const TURN_BUDGET_MS = 25000
const MIN_LEFT_FOR_ANOTHER_TRY_MS = 4000
function budget(ms = TURN_BUDGET_MS) {
  const end = Date.now() + ms
  return { left: () => end - Date.now(), callTimeout: () => Math.max(1000, Math.min(CALL_LIMIT_MS, end - Date.now())) }
}
const timeLeft = b => !b || b.left() >= MIN_LEFT_FOR_ANOTHER_TRY_MS

function provider() {
  const p = String(process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'gemini')).toLowerCase()
  if (!DEFAULTS[p]) throw new Error(`Unknown AI_PROVIDER "${p}" (use gemini or anthropic)`)
  return p
}

/**
 * Main and backup model ids for a provider. AI_MODEL / AI_BACKUP_MODEL only
 * apply to the main provider: a job that always runs on Google (voice-note
 * transcripts) must not be handed a Claude model id.
 */
function models(p = provider()) {
  const own = p === provider()
  return {
    main:   (own && process.env.AI_MODEL) || DEFAULTS[p].main,
    backup: (own && process.env.AI_BACKUP_MODEL) || DEFAULTS[p].backup
  }
}

// The timeline names models by product name (utils/modelName).
const modelLabel = modelName
const PROVIDER_NAME = { anthropic: 'Anthropic', gemini: 'Google Gemini' }
const cap = s => s.charAt(0).toUpperCase() + s.slice(1)

function errorReason(err) {
  const m = String(err?.message || '')
  if (/exceeded your current quota/i.test(m)) return 'quota used up'
  if (/credit balance|billing/i.test(m)) return 'billing'
  if (/rate|429/i.test(m)) return 'rate limited'
  if (/overloaded|high demand|529|503/i.test(m)) return 'overloaded'
  if (/not found|404/i.test(m)) return 'model not found'
  if (/aborted|timed? ?out/i.test(m)) return 'too slow (timed out)'
  return err?.status ? `HTTP ${err.status}` : 'error'
}

// The provider account itself can't be used (no credit, bad key): every model
// on it fails the same way, so its backup model isn't worth a try.
function accountProblem(err) {
  // Not Gemini's per-model "exceeded your current quota": the backup model has its own quota.
  return err?.status === 401 || err?.status === 403 || /credit balance|invalid x-api-key|api key not valid|authentication_error|permission_error/i.test(String(err?.message || ''))
}

// Run fn(model) on the main model; if it fails (after its own retries) and
// fallback is still safe, run it once more on the backup model.
async function withBackup(p, fn, { area = 'ai', canFallback = () => true, budget: b } = {}) {
  const { main, backup } = models(p)
  try {
    return { ...(await fn(main)), model: main }
  } catch (err) {
    log.warn('ai_main_model_failed', { provider: p, model: main, status: err?.status, message: String(err?.message || '').slice(0, 200) })
    if (!backup || backup === main || !canFallback() || accountProblem(err) || !timeLeft(b)) throw err
    trace.event(area, `${cap(modelLabel(main))} unavailable → ${modelLabel(backup)}`, { reason: errorReason(err) })
    return { ...(await fn(backup)), model: backup, backupUsed: true }
  }
}

// The other provider, when its key is set (Claude ↔ Gemini).
function otherProvider(p) {
  if (p === 'anthropic') return process.env.GOOGLE_API_KEY ? 'gemini' : null
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : null
}

// If the provider can't answer at all (out of credit, down), the other one
// does, under the same rule as the backup model: in a chat only before any
// booking step ran. So the demo keeps working if, say, Anthropic credit runs out.
async function withFallback(p, run, { area = 'ai', canFallback = () => true, budget: b } = {}) {
  try {
    return await withBackup(p, run(p), { area, canFallback, budget: b })
  } catch (err) {
    const other = otherProvider(p)
    if (!other || !canFallback() || !timeLeft(b)) throw err
    const to = models(other).main
    trace.event(area, `${PROVIDER_NAME[p]} unavailable → ${modelLabel(to)}`, { reason: errorReason(err) })
    return { ...(await withBackup(other, run(other), { area, canFallback, budget: b })), providerFallback: other }
  }
}

const retrying = (area, model) => fn => withRetry(fn, {
  onRetry: (attempt, waitMs) => trace.event(area, `${cap(modelLabel(model))} busy — retrying`, { attempt, waitMs })
})

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Tool-calling chat. `tools` use the shared shape from services/tools
 * ({ name, description, parameters: { key: { type, description } }, required }).
 * @param {{ system: string, history?: { role: string, content: string }[], text: string,
 *           tools?: any[], runTool: (name: string, args: any) => Promise<any>,
 *           safeToRepeat?: (name: string) => boolean }} opts
 * @returns {Promise<{ reply: string, toolEvents: { name: string, result: any }[], usedTools: boolean, model: string, backupUsed?: boolean }>}
 */
async function chat({ system, history = [], text, note = null, tools = [], runTool, safeToRepeat = () => false }) {
  const p = provider()
  let sideEffects = 0
  const counted = (name, args) => { if (!safeToRepeat(name)) sideEffects++; return runTool(name, args) }
  const b = budget()
  return withFallback(p, prov => model => ADAPTERS[prov].chat({ model, system, history, text, note, tools, runTool: counted, retry: retrying('ai', model), timeout: b.callTimeout }),
    { canFallback: () => sideEffects === 0, budget: b })
}

/**
 * One-shot generation over text and inline files (images, PDFs, audio).
 * @param {{ parts: ({ text: string } | { data: Buffer|string, mimeType: string })[], system?: string,
 *           json?: boolean, maxTokens?: number, area?: string, provider?: string }} opts
 * @returns {Promise<{ text: string, model: string, provider: string, backupUsed?: boolean }>}
 */
async function generate({ parts, system, json = false, maxTokens = 2000, area = 'ai', provider: forced }) {
  const p = forced || provider()
  const b = budget()
  const run = prov => async model => ({ text: await ADAPTERS[prov].generate({ model, parts, system, json, maxTokens, retry: retrying(area, model), timeout: b.callTimeout }) })
  // A job forced onto Google (speech) has nowhere else to go; the rest can fall back.
  const r = forced ? await withBackup(p, run(p), { area, budget: b }) : await withFallback(p, run, { area, budget: b })
  return { ...r, provider: r.providerFallback || p }
}

/** Speech-to-text: Google-only, whatever AI_PROVIDER says. */
function transcribe({ data, mimeType, prompt }) {
  return generate({ provider: 'gemini', area: 'media', parts: [{ data, mimeType }, { text: prompt }] })
}

// ── Gemini ──────────────────────────────────────────────────────────────────

let _gemini = null
function geminiClient() {
  if (!_gemini) {
    const { GoogleGenerativeAI } = require('@google/generative-ai')
    _gemini = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY)
  }
  return _gemini
}

const b64 = d => Buffer.isBuffer(d) ? d.toString('base64') : String(d)
const geminiMime = m => (m === 'audio/x-wav' || m === 'audio/wave') ? 'audio/wav' : m

const gemini = {
  async chat({ model: id, system, history, text, note, tools, runTool, retry, timeout = () => CALL_LIMIT_MS }) {
    if (note) text = `${text}\n\n(${note})`
    const model = geminiClient().getGenerativeModel({
      model: id,
      systemInstruction: system,
      ...(tools.length ? { tools: [{ functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: 'OBJECT',
          properties: Object.fromEntries(Object.entries(t.parameters || {}).map(([k, v]) => [k, { type: v.type.toUpperCase(), description: v.description }])),
          required: t.required || []
        }
      })) }] } : {})
    })
    // The conversation is built explicitly instead of via startChat(): the legacy
    // SDK sends tool results with role "function", which current Gemini models
    // reject. The model's own turn is echoed back verbatim (it carries the thought
    // signatures newer models require) and tool results go back as a user turn.
    const contents = [
      ...history.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
      { role: 'user', parts: [{ text }] }
    ]
    const toolEvents = []
    let result
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      result = await retry(() => model.generateContent({ contents }, { timeout: timeout() }))
      const calls = result.response.functionCalls()
      if (!calls || !calls.length) return { reply: result.response.text() || '', toolEvents, usedTools: toolEvents.length > 0 }

      contents.push({ role: 'model', parts: result.response.candidates?.[0]?.content?.parts || calls.map(c => ({ functionCall: c })) })
      const responses = []
      for (const call of calls) {
        const toolResult = await runTool(call.name, call.args)
        toolEvents.push({ name: call.name, result: toolResult })
        // Gemini requires an object (Struct) here — wrap list results (e.g. list_services).
        responses.push({ functionResponse: { name: call.name, response: Array.isArray(toolResult) ? { items: toolResult } : (toolResult ?? {}) } })
      }
      contents.push({ role: 'user', parts: responses })
    }
    return { reply: 'I had trouble processing that. Could you try again?', toolEvents, usedTools: true, gaveUp: true }
  },

  async generate({ model: id, parts, system, json, retry, timeout = () => CALL_LIMIT_MS }) {
    const model = geminiClient().getGenerativeModel({
      model: id,
      ...(system ? { systemInstruction: system } : {}),
      ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {})
    })
    const result = await retry(() => model.generateContent(parts.map(p =>
      'text' in p ? { text: p.text } : { inlineData: { mimeType: geminiMime(p.mimeType), data: b64(p.data) } }), { timeout: timeout() }))
    return (result.response.text() || '').trim()
  }
}

// ── Anthropic (only when AI_PROVIDER=anthropic) ─────────────────────────────

let _anthropic = null
function anthropicClient() {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk')
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return _anthropic
}

// Chat is short answers and tool calls: low effort keeps thinking (and tokens) small.
// AI_EFFORT=medium|high raises it without a code change.
const CHAT_EFFORT = () => (['low', 'medium', 'high'].includes(process.env.AI_EFFORT) ? process.env.AI_EFFORT : 'low')
// Thinking counts toward max_tokens, so this is room, not cost: only what's
// generated is billed. 1024 could cut a reply or a tool call off mid-way.
const CHAT_MAX_TOKENS = 4096
const UNSEEN_DRAFT = '(The customer has not seen the text you wrote with those tool calls; only your final reply reaches them. Answer from the tool results as if for the first time: don\'t mention, repeat or correct that text.)'

const anthropic = {
  async chat({ model, system, history, text, note, tools, runTool, retry, timeout = () => CALL_LIMIT_MS }) {
    // The time note is a second block on the new message only, so earlier turns
    // and the system prompt stay byte-identical (cacheable).
    const current = note ? [{ type: 'text', text }, { type: 'text', text: `(${note})` }] : text
    const messages = [...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })), { role: 'user', content: current }]
    const toolDefs = tools.map(t => ({ name: t.name, description: t.description, input_schema: { type: 'object', properties: t.parameters || {}, required: t.required || [] } }))
    const toolEvents = []
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await retry(() => anthropicClient().messages.create({
        model,
        max_tokens: CHAT_MAX_TOKENS,
        output_config: { effort: CHAT_EFFORT() },
        // Two cache points: tools + system (the big, stable part: the city,
        // services, rules) and, automatically, the conversation so far, so each
        // tool round re-reads the previous one from cache.
        cache_control: { type: 'ephemeral' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        ...(toolDefs.length ? { tools: toolDefs } : {}),
        messages
      }, { timeout: timeout(), maxRetries: 0 }))
      for (const k of Object.keys(usage)) usage[k] += Number(resp.usage?.[k] || 0)
      // A declined request goes to the backup model (withBackup), like any failure.
      if (resp.stop_reason === 'refusal') throw Object.assign(new Error('the model declined'), { code: 'REFUSED' })
      const toolBlocks = resp.content.filter(b => b.type === 'tool_use')
      // Cut off mid tool call: the call can't be trusted, so don't run it.
      if (resp.stop_reason === 'max_tokens' && toolBlocks.length) throw Object.assign(new Error('reply cut off mid tool call'), { code: 'MAX_TOKENS' })
      if (!toolBlocks.length) return { reply: resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), toolEvents, usedTools: toolEvents.length > 0, usage }

      messages.push({ role: 'assistant', content: resp.content })
      const results = []
      for (const block of toolBlocks) {
        const result = await runTool(block.name, block.input)
        toolEvents.push({ name: block.name, result })
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) })
      }
      // Only the last round's text reaches the customer. Text written beside a tool
      // call stays in the history (editing it would break thinking), so say it went
      // unseen: otherwise the model "corrects my earlier message", a message the
      // customer never got.
      if (resp.content.some(b => b.type === 'text' && b.text.trim())) results.push({ type: 'text', text: UNSEEN_DRAFT })
      messages.push({ role: 'user', content: results })
    }
    return { reply: 'I had trouble processing that. Could you try again?', toolEvents, usedTools: true, gaveUp: true, usage }
  },

  async generate({ model, parts, system, maxTokens, retry, timeout = () => CALL_LIMIT_MS }) {
    const content = parts.map(p => {
      if ('text' in p) return { type: 'text', text: p.text }
      if (p.mimeType === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(p.data) } }
      if (String(p.mimeType).startsWith('image/')) return { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: b64(p.data) } }
      throw new Error(`${p.mimeType} is not supported by the anthropic provider`)
    })
    const resp = await retry(() => anthropicClient().messages.create({
      model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content }]
    }, { timeout: timeout(), maxRetries: 0 }))
    if (resp.stop_reason === 'refusal') throw new Error('the model declined')
    return resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
  }
}

const ADAPTERS = { gemini, anthropic }

module.exports = { chat, generate, transcribe, provider, models, modelLabel, aiLabel: id => cap(modelLabel(id)), errorReason, anthropicClient }
