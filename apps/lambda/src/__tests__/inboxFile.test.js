'use strict'

// Email attachments in the demo inbox (the receipt PDF) are served at signed
// links, so Open and Download are plain links no browser blocks.

process.env.FLOW_LINK_SECRET = 'test-secret'
process.env.DEMO_STORE = 'memory'
process.env.API_URL = 'http://api.test'

jest.mock('../core/demoSession', () => ({
  sidFromToken: jest.fn(t => (t === 'session-token' ? 'abcdef123456' : null)),
  getActiveSession: jest.fn(async sid => (sid === 'abcdef123456' ? { sid, status: 'active' } : null))
}))

const inbox = require('../services/demoInbox')
const { handler } = require('../handlers/demo')
const { createToken } = require('../utils/jwt')

const PDF = Buffer.from('%PDF-1.7 receipt')
const get = (path, query, headers = {}) => handler({ httpMethod: 'GET', pathParameters: { proxy: path }, queryStringParameters: query, headers })

beforeAll(() => inbox.deliver({ sid: 'abcdef123456', role: 'customer', to: 'Sam Rivera', subject: 'Your receipt', text: 'attached', attachments: [{ filename: 'receipt-0012.pdf', content: PDF, contentType: 'application/pdf' }] }))

test('the inbox lists each attachment with an open link and a download link, not the bytes', async () => {
  const r = await get('inbox', { role: 'customer' }, { Authorization: 'Bearer session-token' })
  const a = JSON.parse(r.body).messages[0].attachments[0]
  expect(a).toMatchObject({ filename: 'receipt-0012.pdf', contentType: 'application/pdf', url: expect.stringMatching(/^http:\/\/api\.test\/demo\/inbox\/file\?f=/) })
  expect(a.downloadUrl).toBe(`${a.url}&dl=1`)
  expect(a.data).toBeUndefined()
})

test('the link returns the PDF: inline to open, as an attachment to download', async () => {
  const r = await get('inbox', { role: 'customer' }, { Authorization: 'Bearer session-token' })
  const { url } = JSON.parse(r.body).messages[0].attachments[0]
  const f = new URL(url).searchParams.get('f')
  const open = await get('inbox/file', { f })
  expect(open).toMatchObject({ statusCode: 200, isBase64Encoded: true })
  expect(open.headers).toMatchObject({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="receipt-0012.pdf"' })
  expect(Buffer.from(open.body, 'base64')).toEqual(PDF)
  const dl = await get('inbox/file', { f, dl: '1' })
  expect(dl.headers['Content-Disposition']).toBe('attachment; filename="receipt-0012.pdf"')
})

describe('on AWS (API Gateway can\'t return the PDF itself)', () => {
  beforeAll(() => { process.env.AWS_LAMBDA_FUNCTION_NAME = 'flow-dev-demo'; process.env.S3_DOCUMENTS_BUCKET = 'flow-documents-dev-123' })
  afterAll(() => { delete process.env.AWS_LAMBDA_FUNCTION_NAME; delete process.env.S3_DOCUMENTS_BUCKET; jest.restoreAllMocks() })

  test('the link puts the file in S3 and redirects to a signed S3 link', async () => {
    const s3 = require('../services/s3')
    const put = jest.spyOn(s3, 'putFile').mockResolvedValue()
    const sign = jest.spyOn(s3, 'signedGetUrl').mockResolvedValue('https://s3.test/signed')
    const r = await get('inbox', { role: 'customer' }, { Authorization: 'Bearer session-token' })
    const f = new URL(JSON.parse(r.body).messages[0].attachments[0].url).searchParams.get('f')
    const out = await get('inbox/file', { f, dl: '1' })
    expect(out).toMatchObject({ statusCode: 302, headers: { Location: 'https://s3.test/signed' } })
    expect(put.mock.calls[0][0]).toMatch(/^demo-inbox\/abcdef123456\/[0-9a-f]{24}\/receipt-0012\.pdf$/)
    expect(put.mock.calls[0][1]).toEqual(PDF)
    expect(sign.mock.calls[0][1]).toMatchObject({ contentType: 'application/pdf', disposition: 'attachment; filename="receipt-0012.pdf"', expiresIn: 300 })
    put.mockRestore(); sign.mockRestore()
  })

  test('the signed S3 link carries the open/download instruction', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIATEST'; process.env.AWS_SECRET_ACCESS_KEY = 'secret'; process.env.AWS_REGION = 'ap-south-1'
    const s3 = jest.requireActual('../services/s3')
    const url = new URL(await s3.signedGetUrl('demo-inbox/x/y/receipt.pdf', { contentType: 'application/pdf', disposition: 'inline; filename="receipt.pdf"', expiresIn: 300 }))
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
    expect(url.searchParams.get('response-content-disposition')).toBe('inline; filename="receipt.pdf"')
  })
})

test('a forged, expired or ended-session link is refused', async () => {
  expect((await get('inbox/file', { f: 'nonsense' })).statusCode).toBe(403)
  expect((await get('inbox/file', { f: createToken({ typ: 'inboxfile', sid: 'abcdef123456', sk: 'x', i: 0 }, -10) })).statusCode).toBe(403)
  expect((await get('inbox/file', { f: createToken({ typ: 'other', sid: 'abcdef123456', sk: 'x', i: 0 }, 60) })).statusCode).toBe(403)
  expect((await get('inbox/file', { f: createToken({ typ: 'inboxfile', sid: 'zzzzzz999999', sk: 'x', i: 0 }, 60) })).statusCode).toBe(410)
})
