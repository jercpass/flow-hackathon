'use strict'

// Text out of Word (.docx), Excel (.xlsx) and text files, with no new
// dependency: the files are built here the way Word and Excel write them
// (a zip of XML parts, deflated).

const zlib = require('zlib')
const { extractText, docTypeOf, unsupportedMessage } = require('../services/docText')

/** A zip archive of { name: content } entries, deflated like Office does. */
function zip(files, { stored = false } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  const entries = Object.entries(files)
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const body = stored ? data : zlib.deflateRawSync(data)
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, body)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const docx = body => zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`
})

test('Word: paragraphs, split runs, tabs, line breaks and entities', () => {
  const buf = docx(
    '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Booking for </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Sam &amp; Alex</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Cut</w:t><w:tab/><w:t>$45</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two &#8211; caf&#xE9;</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Saturday</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2 PM</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  )
  expect(extractText(buf, 'docx')).toBe('Booking for Sam & Alex\nCut\t$45\nLine one\nLine two – café\nSaturday\n2 PM')
})

test('Excel: every sheet by name, shared and inline strings, numbers, booleans, gaps between columns', () => {
  const buf = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Prices" sheetId="1" r:id="rId1"/><sheet name="Team &amp; hours" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst count="4"><si><t>Service</t></si><si><t>Price</t></si><si><r><t>Color </t></r><r><rPr><b/></rPr><t>&amp; Gloss</t></r></si><si><t>Ana</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>130</v></c></row>' +
      '<row r="3"><c r="A3" s="1"/></row>' +
      '<row r="4"><c r="A4" t="inlineStr"><is><t>Kids cut</t></is></c><c r="C4" t="b"><v>1</v></c></row>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="B1"><f>SUM(1,2)</f><v>3</v></c></row></sheetData></worksheet>'
  })
  expect(extractText(buf, 'xlsx')).toBe(
    'Sheet "Prices":\nService | Price\nColor & Gloss | 130\nKids cut |  | TRUE\n\n' +
    'Sheet "Team & hours":\nAna | 3'
  )
})

test('text files: UTF-8 with a BOM, UTF-16, Windows line ends; binary is refused', () => {
  expect(extractText(Buffer.from('\uFEFFName,Service\r\nSam,Cut\r\n'), 'text')).toBe('Name,Service\nSam,Cut')
  expect(extractText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hi Ana', 'utf16le')]), 'text')).toBe('Hi Ana')
  expect(() => extractText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1]), 'text')).toThrow('doesn’t look like a text file')
})

test('stored (uncompressed) zip entries work too', () => {
  const buf = zip({ 'word/document.xml': `<w:document ${W}><w:body><w:p><w:r><w:t>Stored</w:t></w:r></w:p></w:body></w:document>` }, { stored: true })
  expect(extractText(buf, 'docx')).toBe('Stored')
})

test('a damaged file, the wrong kind of zip, and a zip bomb are refused with a plain message', () => {
  expect(() => extractText(Buffer.from('not a zip at all, just some text here'), 'docx')).toThrow('looks damaged')
  expect(() => extractText(zip({ 'other.xml': '<x/>' }), 'docx')).toThrow('doesn’t look like a Word document')
  expect(() => extractText(zip({ 'xl/workbook.xml': '<workbook/>' }), 'xlsx')).toThrow('doesn’t look like an Excel workbook')
  // 25 MB of zeros deflates to a few KB: unzipping stops at the limit.
  const bomb = zip({ 'word/document.xml': Buffer.alloc(25_000_000) })
  expect(bomb.length).toBeLessThan(100_000)
  expect(() => extractText(bomb, 'docx')).toThrow('too large to read')
})

test('the type comes from the file name first, then the MIME type', () => {
  expect(docTypeOf('Prices.XLSX', 'application/octet-stream')).toBe('xlsx')
  expect(docTypeOf('note.docx', '')).toBe('docx')
  expect(docTypeOf('list.csv', 'application/vnd.ms-excel')).toBe('text')
  expect(docTypeOf('', 'text/plain; charset=utf-8')).toBe('text')
  expect(docTypeOf('old.doc', 'application/msword')).toBeNull()
  expect(unsupportedMessage('old.doc')).toMatch(/Save it as Word \(\.docx\), Excel \(\.xlsx\) or PDF/)
  expect(unsupportedMessage('clip.mp4')).toBe('I can read photos, PDFs, Word (.docx), Excel (.xlsx) and text files.')
})
