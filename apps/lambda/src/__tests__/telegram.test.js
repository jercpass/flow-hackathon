'use strict'

// Telegram channel: Flow's demo bot links a chat to a
// demo session with /start <code>; a store's own bot belongs to its session and
// books that store only. Both use the web chat's turn, show PayPal buttons and
// take the saved-PayPal yes as a button press. Telegram's API and the AI are mocked.

const mockClients = new Map()
jest.mock('../services/telegram', () => {
  const real = jest.requireActual('../services/telegram')
  const fake = token => {
    if (!mockClients.has(token)) {
      mockClients.set(token, {
        token,
        getMe: jest.fn(async () => ({ id: 777001, is_bot: true, username: 'WillowSalonBot' })),
        sendMessage: jest.fn(async () => ({})),
        sendChatAction: jest.fn(async () => ({})),
        answerCallback: jest.fn(async () => ({})),
        sendDocument: jest.fn(async () => ({})),
        sendVoice: jest.fn(async () => ({})),
        sendAnimation: jest.fn(async () => ({ animation: { file_id: 'ANIM1' } })),
        downloadFile: jest.fn(),
        setWebhook: jest.fn(async () => true),
        deleteWebhook: jest.fn(async () => true)
      })
    }
    return mockClients.get(token)
  }
  return {
    esc: real.esc, toHtml: real.toHtml,
    bot: jest.fn(fake),
    demoBot: jest.fn(() => fake('DEMO')),
    configured: jest.fn(() => true),
    botUsername: jest.fn(async () => 'FlowDemoBot')
  }
})
jest.mock('../core/demoChat', () => ({ chatTurn: jest.fn() }))
jest.mock('../services/cloudTts', () => ({ voiceMessage: jest.fn() }))
jest.mock('../core/paypalLogin', () => ({ start: jest.fn(async () => ({ url: 'https://www.sandbox.paypal.com/connect?x=1' })) }))
jest.mock('../services/dynamo/customers', () => ({ updateCustomer: jest.fn(async () => ({})), getCustomer: jest.fn() }))
jest.mock('../services/dynamo/businesses', () => ({ getBusiness: jest.fn(async id => ({ businessId: id, name: 'Willow & Co. Salon' })) }))

const { setStore, memory, store } = require('../services/demoStore')
const tg = require('../services/telegram')
const { chatTurn } = require('../core/demoChat')
const { updateCustomer } = require('../services/dynamo/customers')
const bots = require('../core/telegramBot')
const handlers = require('../handlers/telegram')

const TOKEN = '777001:AAHk2f8Qx_example-token-of-30-plus-chars'
let updateId = 1
const update = message => ({ update_id: updateId++, message: { message_id: 1, chat: { id: 555, type: 'private' }, from: { id: 9, username: 'judge', first_name: 'Jo' }, ...message } })
const demoClient = () => tg.demoBot()
const lastText = c => c.sendMessage.mock.calls[c.sendMessage.mock.calls.length - 1][1]
const lastOpts = c => c.sendMessage.mock.calls[c.sendMessage.mock.calls.length - 1][2] || {}
// The welcome is sent as Flow's animation with the text as its caption.
const welcomes = c => c.sendAnimation.mock.calls.map(([, file, opts]) => ({ file, text: opts.caption, opts }))
const lastWelcome = c => welcomes(c)[welcomes(c).length - 1]
const session = { sid: 'S1', status: 'active', expiresAt: Date.now() + 3600_000, customerId: 'C1', customerName: 'Sam Rivera', businessId: 'B1', businessIds: ['B1', 'B2'] }

beforeEach(async () => {
  jest.clearAllMocks()
  mockClients.clear()
  setStore(memory())
  await store().putSession({ ...session })
  process.env.API_URL = 'https://api.example.com/dev'
  delete process.env.STAGE
  chatTurn.mockResolvedValue({ reply: 'Ana has **11 AM** open on Monday.', userContent: 'book', media: null, payment: null, confirm: null })
})

async function linked() {
  const { link } = await bots.linkStatus(await store().getSession('S1'))
  await bots.handleUpdate(update({ text: `/start ${link.split('start=')[1]}` }), bots.demoBot())
  demoClient().sendMessage.mockClear()
}

describe("Flow's demo bot", () => {
  test('a t.me start link links the chat and the customer, and offers Log in with PayPal', async () => {
    const s = await bots.linkStatus(await store().getSession('S1'))
    expect(s).toMatchObject({ configured: true, bot: 'FlowDemoBot', linked: null, stores: [] })
    const code = s.link.split('start=')[1]
    expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/)
    await bots.handleUpdate(update({ text: `/start ${code}` }), bots.demoBot())
    expect(lastWelcome(demoClient()).text).toMatch(/Linked! You're <b>Sam Rivera<\/b>/)
    expect(lastWelcome(demoClient()).opts.buttons).toEqual([{ text: 'Log in with PayPal', url: 'https://www.sandbox.paypal.com/connect?x=1' }])
    expect(updateCustomer).toHaveBeenCalledWith('C1', { telegram: { chatId: 555, botId: 'demo' } })
    expect((await bots.linkStatus(await store().getSession('S1'))).linked).toMatchObject({ username: 'judge' })
  })

  test("the welcome is Flow's animation with the text as its caption, or plain text if Telegram refuses it", async () => {
    await linked()
    const client = demoClient()
    client.sendAnimation.mockRejectedValueOnce(Object.assign(new Error('Telegram sendAnimation failed'), { code: 'TELEGRAM_API', status: 400 }))
    client.sendMessage.mockClear()
    await bots.handleUpdate(update({ text: '/start' }), bots.demoBot())
    expect(lastText(client)).toMatch(/Linked! You're <b>Sam Rivera<\/b>/)
    expect(lastOpts(client).buttons).toEqual([{ text: 'Log in with PayPal', url: 'https://www.sandbox.paypal.com/connect?x=1' }])
    // After a refusal the file is uploaded again: the bundled MP4 itself.
    client.sendMessage.mockClear()
    await bots.handleUpdate(update({ text: '/start' }), bots.demoBot())
    const w = lastWelcome(client)
    expect(Buffer.isBuffer(w.file)).toBe(true)
    expect(w.file.length).toBe(require('fs').statSync(require('path').join(__dirname, '../assets/telegram-welcome.mp4')).size)
    expect(w.opts).toMatchObject({ width: 640, height: 360 })
    expect(w.text).toMatch(/Things to try/)
    expect(client.sendMessage.mock.calls.filter(c => /Linked!/.test(c[1]))).toHaveLength(0)
  })

  test('an unlinked chat is told how to start', async () => {
    await bots.handleUpdate(update({ text: 'hello' }), bots.demoBot())
    expect(lastText(demoClient())).toMatch(/open .* start a session/)
    expect(chatTurn).not.toHaveBeenCalled()
  })

  test('a message is a web chat turn on the telegram channel, across the whole city', async () => {
    await linked()
    await bots.handleUpdate(update({ text: 'Book me a haircut' }), bots.demoBot())
    expect(chatTurn).toHaveBeenCalledWith(expect.objectContaining({ sid: 'S1' }), expect.objectContaining({ typed: 'Book me a haircut', channel: 'telegram', onlyBusinessId: null }))
    expect(lastText(demoClient())).toBe('Ana has <b>11 AM</b> open on Monday.')
  })

  test('PayPal link and the saved-PayPal yes become buttons; pressing yes pays, or asks for a link, like web chat', async () => {
    await linked()
    chatTurn.mockResolvedValueOnce({ reply: 'Pay $40 now?', userContent: 'x', media: null, payment: { url: 'https://paypal.test/pay', amount: 40, currency: 'USD', kind: 'booking' }, confirm: { amount: 40, account: 'j***@example.com' } })
    await bots.handleUpdate(update({ text: '3 PM please' }), bots.demoBot())
    expect(lastOpts(demoClient()).buttons).toEqual([
      { text: 'Pay $40 with PayPal', url: 'https://paypal.test/pay' },
      { text: 'Yes, pay $40 with saved PayPal', data: 'pay:40' }
    ])
    await bots.handleUpdate({ update_id: updateId++, callback_query: { id: 'cq1', from: { id: 9 }, message: { chat: { id: 555 } }, data: 'pay:40' } }, bots.demoBot())
    expect(demoClient().answerCallback).toHaveBeenCalledWith('cq1')
    expect(chatTurn).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ typed: 'Yes, pay $40 with my saved PayPal.' }))
    // No "Pay on PayPal instead" button any more (link once, pay everywhere), but an old one still answers.
    await bots.handleUpdate({ update_id: updateId++, callback_query: { id: 'cq2', from: { id: 9 }, message: { chat: { id: 555 } }, data: 'link' } }, bots.demoBot())
    expect(chatTurn).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ typed: "I'd rather pay on PayPal. Send me a PayPal link instead." }))
  })

  test('not connected yet: a Connect PayPal button (one link that logs in and saves PayPal), no checkout', async () => {
    await linked()
    chatTurn.mockResolvedValueOnce({ reply: 'Connect your PayPal first.', userContent: 'x', media: null, payment: null, confirm: null, connect: { url: 'https://paypal.test/connect' } })
    await bots.handleUpdate(update({ text: '3 PM please' }), bots.demoBot())
    expect(lastOpts(demoClient()).buttons).toEqual([{ text: 'Connect PayPal', url: 'https://paypal.test/connect' }])
  })

  test('the same update twice is handled once; groups are refused', async () => {
    await linked()
    const u = update({ text: 'hi' })
    await bots.handleUpdate(u, bots.demoBot())
    await bots.handleUpdate(u, bots.demoBot())
    expect(chatTurn).toHaveBeenCalledTimes(1)
    await bots.handleUpdate({ update_id: updateId++, message: { chat: { id: 1, type: 'group' }, text: 'hi' } }, bots.demoBot())
    expect(lastText(demoClient())).toMatch(/only work in private chats/)
  })

  test('asked by voice (say, while driving): answered with a Polly voice message, the text and buttons as its caption', async () => {
    const { voiceMessage } = require('../services/cloudTts')
    voiceMessage.mockResolvedValue({ mimeType: 'audio/mpeg', buffer: Buffer.from('mp3'), lang: 'es-US', voice: 'Lupe' })
    await linked()
    const c = demoClient()
    c.downloadFile.mockResolvedValue(Buffer.from('OggS'))
    chatTurn.mockResolvedValueOnce({ reply: 'Eastside tiene **5 PM** libre. ¿Pago $18 con tu PayPal guardado?', userContent: 'x', media: { kind: 'audio', transcript: 'Un arreglo de barba a las 5' }, payment: null, confirm: { amount: 18, account: 's***@x.com' } })
    await bots.handleUpdate(update({ voice: { file_id: 'V1', duration: 4, mime_type: 'audio/ogg', file_size: 9000 } }), bots.demoBot())
    // Spoken without markdown, in the reply's own words.
    expect(voiceMessage).toHaveBeenCalledWith('Eastside tiene 5 PM libre. ¿Pago $18 con tu PayPal guardado?')
    const [chat, buffer, opts] = c.sendVoice.mock.calls[0]
    expect(chat).toBe(555)
    expect(buffer.toString()).toBe('mp3')
    expect(opts.caption).toMatch(/Un arreglo de barba a las 5/)
    expect(opts.caption).toMatch(/<b>5 PM<\/b>/)
    expect(opts.buttons.map(b => b.text)).toEqual(['Yes, pay $18 with saved PayPal'])
    expect(c.sendMessage).not.toHaveBeenCalled()
  })

  test('typed messages get text; if Polly has no voice for the reply, a voice note gets text too', async () => {
    const { voiceMessage } = require('../services/cloudTts')
    await linked()
    const c = demoClient()
    await bots.handleUpdate(update({ text: 'is there parking?' }), bots.demoBot())
    expect(voiceMessage).not.toHaveBeenCalled()
    expect(c.sendVoice).not.toHaveBeenCalled()
    voiceMessage.mockResolvedValue(null)
    c.downloadFile.mockResolvedValue(Buffer.from('OggS'))
    chatTurn.mockResolvedValueOnce({ reply: 'Yes, free parking.', userContent: 'x', media: { kind: 'audio', transcript: 'parking?' }, payment: null, confirm: null })
    await bots.handleUpdate(update({ voice: { file_id: 'V2', duration: 2, mime_type: 'audio/ogg', file_size: 4000 } }), bots.demoBot())
    expect(c.sendVoice).not.toHaveBeenCalled()
    expect(lastText(c)).toMatch(/Yes, free parking/)
  })

  test('a text or Word file is read like a PDF, known by its name even when sent as octet-stream', async () => {
    await linked()
    demoClient().downloadFile.mockResolvedValue(Buffer.from('Sam - cut\nAlex - color'))
    await bots.handleUpdate(update({ caption: 'book these two', document: { file_id: 'F1', file_name: 'party.txt', mime_type: 'application/octet-stream', file_size: 40 } }), bots.demoBot())
    expect(chatTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      typed: 'book these two',
      attachment: expect.objectContaining({ kind: 'doc', docType: 'text', name: 'party.txt', text: 'Sam - cut\nAlex - color' })
    }))
  })

  test('limits are checked before downloading: voice over 1 minute, files over 4 MB, old Office formats', async () => {
    await linked()
    const c = demoClient()
    await bots.handleUpdate(update({ voice: { file_id: 'V1', duration: 95, mime_type: 'audio/ogg', file_size: 300_000 } }), bots.demoBot())
    expect(lastText(c)).toMatch(/Voice notes can be up to 1 minute/)
    await bots.handleUpdate(update({ document: { file_id: 'F2', file_name: 'menu.pdf', mime_type: 'application/pdf', file_size: 9_000_000 } }), bots.demoBot())
    expect(lastText(c)).toMatch(/too large \(max 4 MB\)/)
    await bots.handleUpdate(update({ document: { file_id: 'F3', file_name: 'old.doc', mime_type: 'application/msword', file_size: 2000 } }), bots.demoBot())
    expect(lastText(c)).toMatch(/Save it as Word \(\.docx\), Excel \(\.xlsx\) or PDF/)
    await bots.handleUpdate(update({ video_note: { file_id: 'N1', duration: 5 } }), bots.demoBot())
    expect(lastText(c)).toMatch(/PDF, Word, Excel or text, up to 4 MB/)
    expect(c.downloadFile).not.toHaveBeenCalled()
    expect(chatTurn).not.toHaveBeenCalled()
  })
})

describe("a store's own bot", () => {
  test('a bad token is refused before anything is stored', async () => {
    expect(await bots.connectStoreBot(await store().getSession('S1'), { token: 'nope' })).toMatchObject({ error: expect.stringMatching(/BotFather/) })
    expect(await bots.connectStoreBot(await store().getSession('S1'), { token: TOKEN, businessId: 'OTHER' })).toMatchObject({ error: expect.stringMatching(/isn’t in this demo session/) })
  })

  test('connecting checks the token, keeps it server-side and points the webhook at its own address', async () => {
    const r = await bots.connectStoreBot(await store().getSession('S1'), { token: TOKEN, businessId: 'B1' })
    expect(r).toEqual({ connected: true, botId: '777001', username: 'WillowSalonBot', link: 'https://t.me/WillowSalonBot' })
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    const client = tg.bot(TOKEN)
    expect(client.setWebhook).toHaveBeenCalledWith('https://api.example.com/dev/telegram/bot/777001', expect.stringMatching(/^[0-9a-f]{48}$/))
    expect((await bots.linkStatus(await store().getSession('S1'))).stores).toEqual([{ botId: '777001', username: 'WillowSalonBot', businessId: 'B1', businessName: 'Willow & Co. Salon', link: 'https://t.me/WillowSalonBot' }])
  })

  test('its first message links the chat to the session and books that store only', async () => {
    await bots.connectStoreBot(await store().getSession('S1'), { token: TOKEN, businessId: 'B1' })
    const b = await bots.storeBot('777001')
    await bots.handleUpdate(update({ text: 'Book me a haircut' }), b)
    const client = tg.bot(TOKEN)
    expect(welcomes(client)[0].text).toMatch(/Willow &amp; Co\. Salon<\/b>'s booking assistant/)
    expect(updateCustomer).toHaveBeenCalledWith('C1', { telegram: { chatId: 555, botId: '777001' } })
    expect(chatTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ channel: 'telegram', onlyBusinessId: 'B1' }))
  })

  test('a customer who opens the bot link and taps Start is linked and welcomed once', async () => {
    await bots.connectStoreBot(await store().getSession('S1'), { token: TOKEN, businessId: 'B1' })
    const b = await bots.storeBot('777001')
    await bots.handleUpdate(update({ text: '/start' }), b)
    const client = tg.bot(TOKEN)
    expect(welcomes(client).filter(w => /booking assistant/.test(w.text))).toHaveLength(1)
    expect(updateCustomer).toHaveBeenCalledWith('C1', { telegram: { chatId: 555, botId: '777001' } })
    expect(chatTurn).not.toHaveBeenCalled()
    // Start again later: welcomed again (it's what /start is for), still once.
    client.sendAnimation.mockClear()
    await bots.handleUpdate({ ...update({ text: '/start' }), update_id: 99 }, b)
    expect(welcomes(client).filter(w => /booking assistant/.test(w.text))).toHaveLength(1)
    // The animation was uploaded before, so this bot reuses Telegram's file_id for it.
    expect(welcomes(client)[0].file).toBe('ANIM1')
  })

  test('its webhook only accepts its own secret', async () => {
    await bots.connectStoreBot(await store().getSession('S1'), { token: TOKEN, businessId: 'B1' })
    const secret = tg.bot(TOKEN).setWebhook.mock.calls[0][1]
    const body = JSON.stringify(update({ text: 'hi' }))
    expect(await handlers.storeWebhook({ pathParameters: { botId: '777001' }, headers: { 'x-telegram-bot-api-secret-token': 'wrong'.padEnd(48, 'x') }, body })).toEqual({ statusCode: 401, body: '' })
    expect(await handlers.storeWebhook({ pathParameters: { botId: '777001' }, headers: { 'x-telegram-bot-api-secret-token': secret }, body })).toEqual({ statusCode: 200, body: '' })
    expect(chatTurn).toHaveBeenCalledTimes(1)
    expect(await handlers.storeWebhook({ pathParameters: { botId: '999999' }, headers: {}, body })).toEqual({ statusCode: 200, body: '' })   // unknown bot: ignored
  })

  test('disconnecting removes the webhook and the bot', async () => {
    await bots.connectStoreBot(await store().getSession('S1'), { token: TOKEN, businessId: 'B1' })
    expect(await bots.disconnectStoreBot(await store().getSession('S1'), '777001')).toEqual({ disconnected: true })
    expect(tg.bot(TOKEN).deleteWebhook).toHaveBeenCalled()
    expect(await bots.storeBot('777001')).toBeNull()
    expect((await store().getSession('S1')).telegramBots).toEqual([])
  })
})
