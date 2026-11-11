'use strict'

// Knowledge base on Claude's Files API:
// documents are uploaded once (a PDF as itself, Word/Excel/text and photos as
// text), one row each keeps the file ID server-side, and a question is one
// Claude call over every document with citations and a cache point. Claude and
// the table are mocked; the PDF is the demo's real FAQ.

const mockRows = new Map()
jest.mock('../services/dynamo/knowledgeChunks', () => ({
  saveChunk: jest.fn(async row => { mockRows.set(`${row.businessId}|${row.chunkId}`, { ...row, createdAt: row.createdAt || new Date(Date.now() + mockRows.size).toISOString() }) }),
  getChunksForBusiness: jest.fn(async bid => [...mockRows.values()].filter(r => r.businessId === bid)),
  deleteChunk: jest.fn(async (bid, id) => { mockRows.delete(`${bid}|${id}`) })
}))
const mockClient = { files: { upload: jest.fn(), delete: jest.fn() }, messages: { create: jest.fn(), countTokens: jest.fn() } }
jest.mock('../services/ai', () => ({
  anthropicClient: jest.fn(() => mockClient),
  models: jest.fn(() => ({ main: 'claude-haiku-5-5', backup: 'claude-sonnet-5-5' })),
  generate: jest.fn()
}))
jest.mock('../services/s3', () => ({ uploadDocument: jest.fn() }))

const zlib = require('zlib')
const rag = require('../services/rag')
const ai = require('../services/ai')
const { uploadDocument } = require('../services/s3')
const { docFile } = require('../demo/setupDocs')

let n = 0
beforeEach(() => {
  jest.clearAllMocks()
  mockRows.clear()
  n = 0
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  mockClient.files.upload.mockImplementation(async ({ file, expires_in_seconds }) => ({ id: `file_${++n}`, filename: file.name, expires_at: expires_in_seconds ? '2026-10-31T12:00:00Z' : null }))
  mockClient.files.delete.mockResolvedValue({ id: 'x', type: 'file_deleted' })
})

// A one-paragraph .docx, the way Word writes it.
function docx(text) {
  const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  const data = Buffer.from(xml)
  const body = zlib.deflateRawSync(data)
  const name = Buffer.from('word/document.xml')
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28)
  const cd = Buffer.concat([central, name])
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(30 + name.length + body.length, 16)
  return Buffer.concat([local, name, body, cd, end])
}

describe('adding a document', () => {
  test('a PDF with real text is saved as that text, with page marks (cheaper); a demo business\'s file expires after the session; no S3 copy', async () => {
    process.env.S3_DOCUMENTS_BUCKET = 'bucket'
    const file = await docFile('faq')
    const r = await rag.ingestDocument('demo-abc', Buffer.from(file.buffer), file.filename, file.contentType)
    expect(r).toMatchObject({ added: true, kind: 'pdf', storedAs: 'text', file: 'Willow FAQ.pdf', pages: 1 })
    const { file: up, expires_in_seconds } = mockClient.files.upload.mock.calls[0][0]
    expect(up.name).toBe('Willow FAQ.pdf.txt')
    expect(up.type).toBe('text/plain')
    const stored = Buffer.from(await up.arrayBuffer()).toString()
    expect(stored.startsWith('[Page 1]\n')).toBe(true)
    expect(stored).toMatch(/Mary Street/)
    expect(expires_in_seconds).toBe(25 * 3600)
    const row = [...mockRows.values()][0]
    expect(row).toMatchObject({ businessId: 'demo-abc', fileId: 'file_1', sourceFile: 'Willow FAQ.pdf', kind: 'pdf', storedAs: 'text', pageStarts: [0], expiresAt: '2026-10-31T12:00:00Z' })
    expect(row.preview).toMatch(/Willow/)
    expect(uploadDocument).not.toHaveBeenCalled()
    delete process.env.S3_DOCUMENTS_BUCKET
  })

  test('a scan (no real text) stays a PDF, so Claude can see its pages', async () => {
    const { PDFDocument } = require('pdf-lib')
    const pdf = await PDFDocument.create()
    pdf.addPage(); pdf.addPage()
    const scan = Buffer.from(await pdf.save())
    const r = await rag.ingestDocument('b1', scan, 'scan.pdf', 'application/pdf')
    expect(r).toMatchObject({ added: true, kind: 'pdf', storedAs: 'pdf', pages: 2 })
    const { file: up } = mockClient.files.upload.mock.calls[0][0]
    expect([up.name, up.type]).toEqual(['scan.pdf', 'application/pdf'])
    expect((await rag.listDocuments('b1'))[0]).toMatchObject({ kind: 'PDF', storedAs: 'pdf', pages: 2 })
  })

  test('the preview says what a file becomes and how many tokens Claude reads, and stores nothing', async () => {
    // count_tokens: the question alone is 10; the FAQ as text adds 460, as a PDF 2,000.
    mockClient.messages.countTokens.mockImplementation(async ({ messages }) => {
      const doc = messages[0].content.find(b => b.type === 'document')
      return { input_tokens: 10 + (!doc ? 0 : doc.source.type === 'text' ? 460 : 2000) }
    })
    const file = await docFile('faq')
    const p = await rag.describe(Buffer.from(file.buffer), file.filename, file.contentType)
    expect(p).toMatchObject({ file: 'Willow FAQ.pdf', kind: 'PDF', from: 'PDF, 1 page', storedAs: 'text', pages: 1, tokens: 460, pdfTokens: 2000, estimated: false })
    expect(p.text).toMatch(/^\[Page 1\]\n/)
    expect(mockClient.files.upload).not.toHaveBeenCalled()
    expect(mockRows.size).toBe(0)
    // Without Claude: an estimate from the length.
    delete process.env.ANTHROPIC_API_KEY
    const t = await rag.describe(Buffer.from('Cancel 48 hours ahead for a full refund.'), 'policy.txt', 'text/plain')
    expect(t).toMatchObject({ storedAs: 'text', tokens: 10, estimated: true })
    expect((await rag.describe(Buffer.from('x'), 'old.xls', 'application/vnd.ms-excel')).error).toMatch(/Save it as/)
  })

  test('Word becomes text; a real business keeps its file (no expiry) and an S3 original', async () => {
    process.env.S3_DOCUMENTS_BUCKET = 'bucket'
    const r = await rag.ingestDocument('b1', docx('Free parking behind the building.'), 'Parking.docx', 'application/octet-stream')
    expect(r).toMatchObject({ added: true, kind: 'docx' })
    const args = mockClient.files.upload.mock.calls[0][0]
    expect(args.file.name).toBe('Parking.docx.txt')
    expect(args.file.type).toBe('text/plain')
    expect(Buffer.from(await args.file.arrayBuffer()).toString()).toBe('Free parking behind the building.')
    expect(args.expires_in_seconds).toBeUndefined()
    expect(uploadDocument).toHaveBeenCalledWith('b1', expect.any(Buffer), 'Parking.docx', 'application/octet-stream')
    delete process.env.S3_DOCUMENTS_BUCKET
  })

  test('a photo is read by Claude once and kept as its text', async () => {
    ai.generate.mockResolvedValue({ text: 'Price list: Cut $45, Color $120.' })
    const r = await rag.ingestDocument('b1', Buffer.from('jpegbytes'), 'prices.jpg', 'image/jpeg')
    expect(r).toMatchObject({ added: true, kind: 'photo' })
    expect(ai.generate.mock.calls[0][0].parts[0]).toMatchObject({ mimeType: 'image/jpeg' })
    expect(mockClient.files.upload.mock.calls[0][0].file.name).toBe('prices.jpg.txt')
    expect((await rag.listDocuments('b1'))[0]).toMatchObject({ file: 'prices.jpg', kind: 'Photo', preview: 'Price list: Cut $45, Color $120.' })
  })

  test('the same file twice is stored once; old formats and a full knowledge base are refused plainly', async () => {
    const txt = Buffer.from('Aftercare: wait 48 hours before washing coloured hair.')
    await rag.ingestDocument('b1', txt, 'aftercare.txt', 'text/plain')
    expect(await rag.ingestDocument('b1', txt, 'aftercare copy.txt', 'text/plain')).toMatchObject({ added: false, skipped: true })
    expect(mockClient.files.upload).toHaveBeenCalledTimes(1)
    expect((await rag.ingestDocument('b1', Buffer.from('x'), 'old.doc', 'application/msword')).error).toMatch(/Save it as Word/)
    for (let i = 0; i < rag.MAX_DOCS - 1; i++) await rag.ingestDocument('b1', Buffer.from(`note number ${i}`), `n${i}.txt`, 'text/plain')
    expect((await rag.ingestDocument('b1', Buffer.from('one too many'), 'more.txt', 'text/plain')).error).toMatch(/up to 20 documents/)
  })

  test('without a Claude key it says so instead of storing anything', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await expect(rag.ingestDocument('b1', Buffer.from('hello there'), 'a.txt', 'text/plain')).rejects.toMatchObject({ code: 'NO_CLAUDE' })
  })
})

describe('asking', () => {
  async function twoDocs() {
    const file = await docFile('faq')
    await rag.ingestDocument('demo-abc', Buffer.from(file.buffer), file.filename, file.contentType)
    await rag.ingestDocument('demo-abc', Buffer.from('Cancel 48 hours ahead for a full refund.'), 'policy.txt', 'text/plain')
  }

  test('one Claude call over every document, citations on, cache point on the last; the answer quotes its sources', async () => {
    await twoDocs()
    mockClient.messages.create.mockResolvedValue({
      stop_reason: 'end_turn',
      usage: { input_tokens: 40, cache_read_input_tokens: 3900 },
      content: [
        { type: 'text', text: 'Yes, there is free parking ' },
        { type: 'text', text: 'behind the building, off Mary Street.', citations: [{ type: 'page_location', cited_text: 'Free parking behind the building, off Mary Street.', document_index: 0, document_title: 'Willow FAQ.pdf', start_page_number: 1, end_page_number: 2 }] }
      ]
    })
    const r = await rag.ask('demo-abc', 'Is there parking?', { businessName: 'Willow & Co.' })
    expect(r).toMatchObject({
      answer: 'Yes, there is free parking behind the building, off Mary Street.',
      sources: [{ file: 'Willow FAQ.pdf', quote: 'Free parking behind the building, off Mary Street.', page: 1 }],
      documents: 2, model: 'claude-haiku-5-5'
    })
    // A PDF stored as text cites characters: they map back to the page, and page marks never show in a quote.
    mockClient.messages.create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Yes.', citations: [{ type: 'char_location', cited_text: '[Page 1]\nFree parking behind the building', document_index: 0, document_title: 'Willow FAQ.pdf', start_char_index: 0, end_char_index: 40 }] }] })
    expect((await rag.ask('demo-abc', 'parking?')).sources).toEqual([{ file: 'Willow FAQ.pdf', quote: 'Free parking behind the building', page: 1 }])
    const req = mockClient.messages.create.mock.calls[0][0]
    expect(req.model).toBe('claude-haiku-5-5')
    expect(req.system).toMatch(/Willow & Co\./)
    const [d1, d2, q] = req.messages[0].content
    expect(d1).toEqual({ type: 'document', source: { type: 'file', file_id: 'file_1' }, title: 'Willow FAQ.pdf', citations: { enabled: true } })
    expect(d2).toMatchObject({ source: { type: 'file', file_id: 'file_2' }, cache_control: { type: 'ephemeral' } })
    expect(q).toEqual({ type: 'text', text: "Customer's question: Is there parking?" })
  })

  test("documents that don't cover it give no answer; no documents means no call at all", async () => {
    expect(await rag.ask('demo-empty', 'Is there parking?')).toBeNull()
    expect(mockClient.messages.create).not.toHaveBeenCalled()
    await twoDocs()
    mockClient.messages.create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'NOT_IN_DOCUMENTS' }] })
    expect(await rag.ask('demo-abc', 'Do you sell gift cards?')).toMatchObject({ answer: null, sources: [] })
    expect(await rag.query('demo-abc', 'Do you sell gift cards?')).toEqual([])
  })

  test('file IDs never leave the server: not in the list, not in an answer', async () => {
    await twoDocs()
    mockClient.messages.create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Yes.', citations: [{ type: 'char_location', cited_text: 'full refund', document_index: 1, document_title: 'policy.txt' }] }] })
    const out = JSON.stringify([await rag.listDocuments('demo-abc'), await rag.ask('demo-abc', 'refund?')])
    expect(out).not.toMatch(/file_\d/)
  })
})

describe('removing', () => {
  test('one document: its stored file is deleted too; all: every file, even ones already gone', async () => {
    await rag.ingestDocument('b1', Buffer.from('Note one about parking.'), 'one.txt', 'text/plain')
    await rag.ingestDocument('b1', Buffer.from('Note two about refunds.'), 'two.txt', 'text/plain')
    const [first] = await rag.listDocuments('b1').then(d => d.filter(x => x.file === 'one.txt'))
    expect(await rag.removeDocument('b1', first.sourceHash)).toBe(1)
    expect(mockClient.files.delete).toHaveBeenCalledWith('file_' + (n - 1))
    expect((await rag.listDocuments('b1')).map(d => d.file)).toEqual(['two.txt'])
    mockClient.files.delete.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    expect(await rag.clearBusinessKnowledge('b1')).toBe(1)
    expect(await rag.listDocuments('b1')).toEqual([])
  })
})
