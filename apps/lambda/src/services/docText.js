// @ts-check
'use strict'

// ─── Text out of Word, Excel and text files ───────────────────────────────────
// Customers can send a .docx, .xlsx or plain-text file (.txt, .csv, .md) in
// chat; the AI reads the text we pull out here (services/media). Word and Excel
// files are zip archives of XML, so Node's zlib is enough: no new dependency.
// Older binary formats (.doc, .xls) aren't readable this way: we ask for
// .docx, .xlsx or PDF instead.

const zlib = require('zlib')

const MAX_UNZIPPED = 20_000_000   // a 4 MB file can't unzip into more than this (zip bombs)
const MAX_SHEET_ROWS = 2000
const MAX_COLUMNS = 50

class DocError extends Error {
  constructor(message) { super(message); this.code = 'MEDIA_INVALID' }
}

const EXT = { docx: 'docx', xlsx: 'xlsx', txt: 'text', csv: 'text', tsv: 'text', md: 'text' }
const MIME = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'text',
  'text/csv': 'text',
  'text/tab-separated-values': 'text',
  'text/markdown': 'text'
}
const LABEL = { docx: 'Word file', xlsx: 'Excel file', text: 'text file' }
const SUPPORTED = 'I can read photos, PDFs, Word (.docx), Excel (.xlsx) and text files.'

/** 'docx' | 'xlsx' | 'text' from the file name (first) or its type, else null. */
function docTypeOf(name, mimeType) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ''
  return EXT[ext] || MIME[String(mimeType || '').toLowerCase().split(';')[0].trim()] || null
}

/** What to tell someone whose file we can't read. */
function unsupportedMessage(name) {
  return /\.(doc|xls|ppt|pptx|odt|ods|rtf|pages|numbers)$/i.test(String(name || ''))
    ? 'I can’t open that format. Save it as Word (.docx), Excel (.xlsx) or PDF and send it again.'
    : SUPPORTED
}

// ── Zip ──────────────────────────────────────────────────────────────────────

/** The entries of a zip archive whose names pass `wanted`, as UTF-8 strings. */
function unzip(buffer, wanted) {
  const bad = () => new DocError('That file looks damaged. Try saving it again, or send a PDF.')
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw bad()
  const count = buffer.readUInt16LE(eocd + 10)
  let p = buffer.readUInt32LE(eocd + 16)
  let budget = MAX_UNZIPPED
  const files = new Map()
  for (let n = 0; n < count; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw bad()
    const method = buffer.readUInt16LE(p + 10)
    const size = buffer.readUInt32LE(p + 20)
    const nameLen = buffer.readUInt16LE(p + 28)
    const local = buffer.readUInt32LE(p + 42)
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32)
    if (!wanted(name)) continue
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw bad()
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const raw = buffer.subarray(start, start + size)
    if (budget <= 0) throw new DocError('That file is too large to read.')
    let out
    try {
      out = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: budget }) : null
    } catch (err) {
      throw err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError ? new DocError('That file is too large to read.') : bad()
    }
    if (!out) continue
    budget -= out.length
    files.set(name, out.toString('utf8'))
  }
  return files
}

// ── XML ──────────────────────────────────────────────────────────────────────

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : m
  })
}

// Text runs inside one element (a Word paragraph, an Excel shared string).
const runs = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map(m => unescapeXml(m[1])).join('')

// ── Word ─────────────────────────────────────────────────────────────────────

function docxText(buffer) {
  const xml = unzip(buffer, n => n === 'word/document.xml').get('word/document.xml')
  if (xml == null) throw new DocError('That doesn’t look like a Word document. Try saving it again, or send a PDF.')
  const lines = xml.split('</w:p>').map(p => {
    let line = ''
    for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\s*\/>/g)) {
      line += m[1] !== undefined ? unescapeXml(m[1]) : m[0].startsWith('<w:tab') ? '\t' : '\n'
    }
    return line.trimEnd()
  })
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── Excel ────────────────────────────────────────────────────────────────────

const colIndex = letters => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

function xlsxText(buffer) {
  const files = unzip(buffer, n => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
  const sheets = [...files.keys()].filter(n => n.startsWith('xl/worksheets/')).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  if (!sheets.length) throw new DocError('That doesn’t look like an Excel workbook. Try saving it again, or send a PDF.')
  const shared = [...(files.get('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => runs(m[1], 't'))
  const names = [...(files.get('xl/workbook.xml') || '').matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map(m => unescapeXml(m[1]))

  return sheets.map((file, i) => {
    const rows = []
    for (const row of (files.get(file) || '').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_SHEET_ROWS) break
      const cells = []
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = c[1]
        const col = colIndex(at.match(/\br="([A-Z]+)\d+"/)?.[1] || String.fromCharCode(65 + Math.min(cells.length, 25)))
        if (col < 0 || col >= MAX_COLUMNS) continue
        const type = at.match(/\bt="(\w+)"/)?.[1]
        const inner = c[2] || ''
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        const value = type === 's' ? shared[Number(v)] ?? ''
          : type === 'inlineStr' ? runs(inner, 't')
          : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE')
          : unescapeXml(v ?? '')
        cells[col] = value
      }
      const line = Array.from(cells, x => x ?? '').join(' | ').replace(/(\s\|\s)+$/, '')
      if (line.trim()) rows.push(line)
    }
    return `Sheet "${names[i] || `Sheet ${i + 1}`}":\n${rows.join('\n')}`
  }).join('\n\n').trim()
}

// ── Plain text ───────────────────────────────────────────────────────────────

function plainText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  if (buffer.subarray(0, 8192).includes(0)) throw new DocError('That doesn’t look like a text file. ' + SUPPORTED)
  return buffer.toString('utf8').replace(/^\uFEFF/, '')
}

/**
 * The readable text of a document.
 * @param {Buffer} buffer
 * @param {'docx'|'xlsx'|'text'} type
 * @returns {string}
 */
function extractText(buffer, type) {
  const text = type === 'docx' ? docxText(buffer) : type === 'xlsx' ? xlsxText(buffer) : plainText(buffer)
  return text.replace(/\r\n?/g, '\n').trim()
}

module.exports = { extractText, docTypeOf, unsupportedMessage, unzip, LABEL, SUPPORTED, DocError }
