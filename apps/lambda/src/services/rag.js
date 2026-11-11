// @ts-check
'use strict'

// ─── Knowledge base on Claude's Files API ─
// Add: each document is uploaded once to Claude's Files API. PDFs stay PDFs, so
// Claude sees the layout and cites pages; Word, Excel and text files become
// text (services/docText); a photo is read by Claude once and kept as its text.
// One row per document in the knowledge table holds the file ID, which never
// leaves the server: the Files API workspace is shared, so this mapping is what
// keeps one business's documents from another's.
//
// Ask: one Claude call reads all of a business's documents with citations on
// and answers the question, quoting its sources. The documents come first and
// carry the cache point, so the next question about the same business reads
// them from cache.
//
// (The name stays "rag" so every caller keeps working.)

const crypto = require('crypto')
const { saveChunk, getChunksForBusiness, deleteChunk } = require('./dynamo/knowledgeChunks')
const docText = require('./docText')
const ai = require('./ai')
const log = require('../utils/logger')

const MAX_DOCS = 20
const DEMO_FILE_TTL_S = 25 * 3600       // demo sessions last 24 h; the files go a little after
const ASK_TIMEOUT_MS = 20000
const NOT_COVERED = 'NOT_IN_DOCUMENTS'
const KIND_LABEL = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', text: 'Text', photo: 'Photo' }

const isDoc = r => !!r?.fileId
const claude = () => {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('The knowledge base needs Claude: ANTHROPIC_API_KEY is not set.'), { code: 'NO_CLAUDE' })
  return ai.anthropicClient()
}
const claudeModel = () => ai.models('anthropic').main

/** The documents of a business, oldest first: a stable order keeps the cached prefix the same. */
async function documentsOf(businessId) {
  return (await getChunksForBusiness(businessId)).filter(isDoc)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.sourceHash).localeCompare(String(b.sourceHash)))
}

// Files API names: 1–255 characters, none of < > : " | ? * \ / or control characters.
const safeName = name => String(name || 'document').replace(/[<>:"|?*\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'document'
const preview = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)

// ── Add ─────────────────────────────────────────────────────────────────────

// Claude reads a PDF twice: its text and a picture of every page (measured on
// the demo FAQ: 2,949 tokens as a PDF, 1,410 as text). So a PDF that has real
// text is stored as that text, with a page mark before each page so quotes can
// still name the page. A scan (little text per page) stays a PDF for Claude to see.
const MIN_CHARS_PER_PAGE = 80
const pageMark = n => `[Page ${n}]`

/** Each page's text, in order (pdf-parse renders pages one after another). */
async function pdfPages(buffer) {
  const pages = []
  const render = page => page.getTextContent().then(content => {
    let lastY = null
    let text = ''
    for (const item of content.items) {
      text += lastY === null || lastY === item.transform[5] ? item.str : `\n${item.str}`
      lastY = item.transform[5]
    }
    pages.push(text)
    return text
  })
  // A fresh copy: small Buffers sit at an offset in Node's shared pool, which pdf-parse ignores.
  const info = await require('pdf-parse')(new Uint8Array(buffer), { pagerender: render }).catch(() => null)
  return { pages, count: info?.numpages || pages.length }
}

/** The PDF's pages as one text with page marks, and where each page starts in it. */
function withPageMarks(pages) {
  const pageStarts = []
  let text = ''
  pages.forEach((p, i) => {
    if (text) text += '\n\n'
    pageStarts.push(text.length)
    text += `${pageMark(i + 1)}\n${String(p).replace(/\r\n?/g, '\n').trim()}`
  })
  return { text, pageStarts }
}

/** What to upload for this file: the document's text, or (for a scan) the PDF itself. */
async function prepare(buffer, filename, contentType) {
  const type = String(contentType || '').toLowerCase()
  if (type === 'application/pdf' || /\.pdf$/i.test(filename)) {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'That file is not a valid PDF.' }
    const { pages, count } = await pdfPages(buffer)
    const chars = pages.reduce((n, p) => n + p.replace(/\s/g, '').length, 0)
    if (pages.length && chars / pages.length >= MIN_CHARS_PER_PAGE) {
      const { text, pageStarts } = withPageMarks(pages)
      return { kind: 'pdf', storedAs: 'text', upload: Buffer.from(text, 'utf8'), mime: 'text/plain', name: `${safeName(filename)}.txt`, pages: count, pageStarts, text, preview: preview(pages.join(' ')) }
    }
    return { kind: 'pdf', storedAs: 'pdf', upload: buffer, mime: 'application/pdf', name: safeName(filename), pages: count, text: null, preview: preview(pages.join(' ')) || 'A scanned PDF: Claude reads its pages as pictures.' }
  }
  if (type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(filename)) {
    // Claude writes the photo's text out once; questions then read that text.
    const text = (await ai.generate({ parts: [
      { data: buffer, mimeType: type.startsWith('image/') ? type : 'image/jpeg' },
      { text: 'This photo was added to a small business\'s knowledge base (for example a price list, a sign or a menu). Write out all of its text and what it shows, as plain text. Include service names, prices, hours and any other business information. Output only that text.' }
    ] })).text
    if (!String(text || '').trim()) return { error: 'No text could be read from that photo.' }
    return { kind: 'photo', storedAs: 'text', upload: Buffer.from(text, 'utf8'), mime: 'text/plain', name: `${safeName(filename)}.txt`, text, preview: preview(text) }
  }
  const docType = docText.docTypeOf(filename, type)
  if (!docType) return { error: docText.unsupportedMessage(filename) }
  let text
  try { text = docText.extractText(buffer, docType) } catch (err) { return { error: err.message } }
  if (!text) return { error: 'There is no text in that file.' }
  const name = /\.(txt|md|csv|tsv)$/i.test(filename) ? safeName(filename) : `${safeName(filename)}.txt`
  return { kind: docType, storedAs: 'text', upload: Buffer.from(text, 'utf8'), mime: 'text/plain', name, text, preview: preview(text) }
}

// How many tokens Claude reads for this document on each question. count_tokens
// is free; without Claude, about 4 characters a token.
let baseline = null
async function tokensFor(block) {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const client = ai.anthropicClient()
  const count = content => client.messages.countTokens({ model: claudeModel(), messages: [{ role: 'user', content }] }).then(r => r.input_tokens)
  const q = { type: 'text', text: '?' }
  if (baseline === null) baseline = await count([q])
  return Math.max(1, (await count([block, q])) - baseline)
}
const textBlock = text => ({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: text } })
const pdfBlock = buffer => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } })

/**
 * What adding this file would store, without storing it: the owner sees it
 * before saving ("PDF, 1 page → saved as text, about 400 tokens").
 * @returns {Promise<{ file: string, kind: string, from: string, storedAs: 'text'|'pdf', pages: number|null, tokens: number|null, pdfTokens?: number|null, estimated: boolean, text: string|null } | { error: string }>}
 */
async function describe(buffer, filename, contentType) {
  const doc = await prepare(buffer, String(filename || 'document'), contentType)
  if (doc.error) return { error: doc.error }
  let tokens = null
  let pdfTokens = null
  try {
    tokens = await tokensFor(doc.storedAs === 'pdf' ? pdfBlock(buffer) : textBlock(doc.text))
    if (doc.kind === 'pdf' && doc.storedAs === 'text') pdfTokens = await tokensFor(pdfBlock(buffer))
  } catch (err) {
    log.warn('knowledge_count_failed', { status: err?.status, message: String(err?.message || '').slice(0, 120) })
  }
  const estimated = tokens === null
  if (estimated && doc.text) tokens = Math.ceil(doc.text.length / 4)
  const from = `${KIND_LABEL[doc.kind] || 'Text'}${doc.pages ? `, ${doc.pages} page${doc.pages === 1 ? '' : 's'}` : ''}`
  return { file: String(filename || 'document'), kind: KIND_LABEL[doc.kind] || 'Text', from, storedAs: doc.storedAs, pages: doc.pages ?? null, tokens, ...(doc.kind === 'pdf' && doc.storedAs === 'text' ? { pdfTokens } : {}), estimated, text: doc.text ? doc.text.slice(0, 20000) : null }
}

/**
 * Add a document to a business's knowledge base.
 * @returns {Promise<{ added: boolean, skipped?: boolean, sourceHash?: string, file?: string, kind?: string, pages?: number|null, error?: string }>}
 */
async function ingestDocument(businessId, buffer, filename, contentType) {
  const sourceHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const docs = await documentsOf(businessId)
  if (docs.some(d => d.sourceHash === sourceHash)) {
    log.info('knowledge_add_skipped_duplicate', { businessId, filename })
    return { added: false, skipped: true, sourceHash, file: filename }
  }
  if (docs.length >= MAX_DOCS) return { added: false, error: `The knowledge base holds up to ${MAX_DOCS} documents. Remove one first.` }

  const client = claude()
  const doc = await prepare(buffer, String(filename || 'document'), contentType)
  if (doc.error) return { added: false, error: doc.error }

  const { toFile } = require('@anthropic-ai/sdk')
  const demo = String(businessId).startsWith('demo-')
  // A real business's original is kept in S3 as well (uploaded Files can't be downloaded back).
  if (process.env.S3_DOCUMENTS_BUCKET && !demo) await require('./s3').uploadDocument(businessId, buffer, filename, contentType)
  const meta = await client.files.upload({
    file: await toFile(doc.upload, doc.name, { type: doc.mime }),
    ...(demo ? { expires_in_seconds: DEMO_FILE_TTL_S } : {})
  })
  await saveChunk({
    businessId, chunkId: `doc#${sourceHash.slice(0, 24)}`, fileId: meta.id,
    sourceFile: filename, sourceHash, kind: doc.kind, storedAs: doc.storedAs, mimeType: doc.mime, sizeBytes: buffer.length,
    pages: doc.pages ?? null, ...(doc.pageStarts ? { pageStarts: doc.pageStarts } : {}), preview: doc.preview, expiresAt: meta.expires_at || null
  })
  log.info('knowledge_added', { businessId, filename, kind: doc.kind, storedAs: doc.storedAs })
  return { added: true, skipped: false, sourceHash, file: filename, kind: doc.kind, storedAs: doc.storedAs, pages: doc.pages ?? null }
}

// ── Ask ─────────────────────────────────────────────────────────────────────

function system(businessName) {
  return `You answer customers' questions about ${businessName || 'a small business'} using only the business's own documents, which come before the question.\n` +
    '- Answer in one to three short sentences, in the language the question is asked in.\n' +
    '- Keep prices, times, names and rules exactly as the documents give them.\n' +
    `- If the documents don't answer the question, reply with exactly ${NOT_COVERED} and nothing else.`
}

/** The page a character of a PDF-turned-text falls on (from its page marks). */
function pageAt(doc, charIndex) {
  const starts = Array.isArray(doc?.pageStarts) ? doc.pageStarts : null
  if (!starts || !Number.isFinite(charIndex)) return null
  let page = null
  starts.forEach((start, i) => { if (charIndex >= start) page = i + 1 })
  return page
}

/** Sources from the cited blocks: which document, the quoted words, and the page for PDFs. */
function sourcesFrom(content, docs = []) {
  const seen = new Set()
  const out = []
  for (const block of content) {
    for (const c of (block.type === 'text' && block.citations) || []) {
      const quote = String(c.cited_text || '').replace(/\[Page \d+\]/g, ' ').replace(/\s+/g, ' ').trim()
      const key = `${c.document_index}|${quote}`
      if (!quote || seen.has(key)) continue
      seen.add(key)
      // A PDF Claude read as a PDF cites pages; one stored as text cites characters, mapped to its page.
      const page = c.type === 'page_location' ? c.start_page_number : c.type === 'char_location' ? pageAt(docs[c.document_index], c.start_char_index) : null
      out.push({ file: c.document_title || `document ${c.document_index + 1}`, quote: quote.slice(0, 300), ...(page ? { page } : {}) })
    }
  }
  return out
}

/**
 * Claude reads every document of the business and answers the question.
 * @returns {Promise<null | { answer: string|null, sources: { file: string, quote: string, page?: number }[], documents: number, model: string, usage: any }>}
 *   null when the business has no documents; answer null when they don't cover it.
 */
async function ask(businessId, question, { businessName } = {}) {
  const docs = await documentsOf(businessId)
  if (!docs.length) return null
  const client = claude()
  const model = claudeModel()
  const content = docs.map((d, i) => ({
    type: 'document',
    source: { type: 'file', file_id: d.fileId },
    title: d.sourceFile,
    citations: { enabled: true },
    ...(i === docs.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
  }))
  content.push({ type: 'text', text: `Customer's question: ${String(question).slice(0, 500)}` })
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    output_config: { effort: 'low' },
    system: system(businessName),
    messages: [{ role: 'user', content: /** @type {any} */ (content) }]
  }, { timeout: ASK_TIMEOUT_MS })
  if (resp.stop_reason === 'refusal') throw Object.assign(new Error('the model declined'), { code: 'REFUSED' })
  const text = resp.content.filter(b => b.type === 'text').map(b => /** @type {any} */ (b).text).join('').trim()
  const covered = text && !text.includes(NOT_COVERED)
  return { answer: covered ? text : null, sources: covered ? sourcesFrom(resp.content, docs) : [], documents: docs.length, model, usage: resp.usage }
}

/** The India edition's handlers want passages: the answer is the one passage. */
async function query(businessId, question) {
  const r = await ask(businessId, question)
  return r?.answer ? [r.answer] : []
}

// ── What the knowledge base holds (Knowledge base page, owner MCP) ───────────

/** One row per document: its name, kind, pages (PDFs), when it was added and a preview. */
async function listDocuments(businessId) {
  return (await documentsOf(businessId))
    .map(d => ({ file: d.sourceFile || 'document', sourceHash: d.sourceHash, kind: KIND_LABEL[d.kind] || 'Text', storedAs: d.storedAs || (d.mimeType === 'application/pdf' ? 'pdf' : 'text'), pages: d.pages ?? null, addedAt: d.createdAt || null, preview: d.preview || '' }))
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
}

// ── Remove ──────────────────────────────────────────────────────────────────

/** Delete the stored file (already gone or expired is fine), then its row. */
async function forget(row) {
  if (row.fileId && process.env.ANTHROPIC_API_KEY) {
    await ai.anthropicClient().files.delete(row.fileId).catch(err => {
      if (err?.status !== 404) log.warn('knowledge_file_delete_failed', { status: err?.status, message: String(err?.message || '').slice(0, 120) })
    })
  }
  await deleteChunk(row.businessId, row.chunkId)
}

/** Remove one document. Returns how many were removed (0 or 1). */
async function removeDocument(businessId, sourceHash) {
  const rows = (await getChunksForBusiness(businessId)).filter(r => r.sourceHash === sourceHash)
  for (const r of rows) await forget(r)
  return rows.filter(isDoc).length
}

/** Remove everything (also rows from before the Files API). Returns how many documents went. */
async function clearBusinessKnowledge(businessId) {
  const rows = await getChunksForBusiness(businessId)
  for (const r of rows) await forget(r)
  return rows.filter(isDoc).length
}

module.exports = { ingestDocument, describe, ask, query, listDocuments, removeDocument, clearBusinessKnowledge, MAX_DOCS }
