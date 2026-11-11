'use strict'

// ─── Guided demo: Willow & Co.'s sample documents ────────────────────────────
// What a judge uses to set the salon up with AI without writing anything.
// The price list, team and policy feed the AI
// setup (services, staff, refund tiers); the FAQ (a real PDF) feeds the
// knowledge base the assistant answers from. Kept in step with the Willow
// template in ./templates, which is also the fallback if the AI can't help.

const DESCRIPTION = 'Willow & Co. Salon is a hair salon on South Congress in Austin. We have two stylists and are open every day from 9am to 6pm. We want customers to book and pay online, and to get answers to common questions without calling us.'

const DOCS = [
  {
    id: 'price-list',
    title: 'Price list',
    filename: 'Willow price list.txt',
    kind: 'text',
    use: 'setup',
    summary: 'Services, prices, how they are paid, a membership and a pack',
    text: [
      'Willow & Co. Salon: price list',
      '1500 S Congress Ave, Austin, TX. Open every day, 9am to 6pm.',
      '',
      'Haircut: 60 minutes, $40. Paid in full when you book.',
      'Color & Gloss: 120 minutes, $120. 25% deposit when you book; the rest is paid with PayPal before your visit.',
      '',
      'Kids under 12 are booked as a regular Haircut.',
      '',
      'Memberships and packs (paid with PayPal):',
      'Willow Monthly: $35 a month. One Haircut every month, plus 10% off Color & Gloss. Billed monthly; cancel any time.',
      '5-Cut Pack: $180 for five Haircuts (save $20). Paid once; use them within 6 months.'
    ].join('\n')
  },
  {
    id: 'team',
    title: 'Our team',
    filename: 'Willow team.txt',
    kind: 'text',
    use: 'setup',
    summary: 'Who works here and what each person does',
    text: [
      'Willow & Co. Salon: our team',
      '',
      'Ana: senior stylist. Does Haircuts and Color & Gloss.',
      'Ben: stylist. Does Haircuts only.'
    ].join('\n')
  },
  {
    id: 'policy',
    title: 'Booking & cancellation policy',
    filename: 'Willow cancellation policy.txt',
    kind: 'text',
    use: 'both',
    summary: 'Refunds by how early you cancel, and rescheduling',
    text: [
      'Willow & Co. Salon: booking and cancellation policy',
      '',
      'Cancel 48 hours or more before your appointment: full refund.',
      'Cancel between 24 and 48 hours before: 50% refund.',
      'Cancel less than 24 hours before, or no-show: no refund.',
      'You can reschedule once for free up to 2 hours before your appointment.'
    ].join('\n')
  },
  {
    id: 'faq',
    title: 'Salon FAQ',
    filename: 'Willow FAQ.pdf',
    kind: 'pdf',
    use: 'knowledge',
    summary: 'Parking, products, patch tests, kids, accessibility, payment',
    text: [
      'Willow & Co. Salon: frequently asked questions',
      '',
      'Where can I park? Free parking behind the building, off Mary Street. Street parking on South Congress is metered.',
      'Which products do you use? We use Davines. You are welcome to bring your own products.',
      'I want color. Anything I need to do first? If you are new to us, or have not had color in 6 months, we need a quick patch test at least 48 hours before your Color & Gloss appointment. Pop in any day; it takes 5 minutes.',
      'Do you cut kids\' hair? Yes. Kids under 12 are welcome; book a regular Haircut.',
      'Is the salon accessible? Yes: step-free entrance and an accessible restroom.',
      'How do I pay? Online with PayPal when you book. We do not take cash.',
      'What if I am running late? We can wait up to 15 minutes; after that we may need to shorten or move your appointment.'
    ].join('\n')
  }
]

let pdfCache = null

/** The document as a file (the FAQ is a real PDF, built once with pdf-lib). */
async function docFile(id) {
  const doc = DOCS.find(d => d.id === id)
  if (!doc) return null
  if (doc.kind !== 'pdf') return { buffer: Buffer.from(doc.text, 'utf8'), contentType: 'text/plain', filename: doc.filename }
  if (!pdfCache) pdfCache = await renderPdf(doc.text)
  return { buffer: pdfCache, contentType: 'application/pdf', filename: doc.filename }
}

async function renderPdf(text) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.addPage([612, 792])
  const width = 612 - 72 * 2
  let y = 792 - 72
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const f = i === 0 ? bold : font
    const size = i === 0 ? 16 : 11
    // Simple word wrap to the page width.
    let row = ''
    for (const word of line.split(' ')) {
      const next = row ? `${row} ${word}` : word
      if (f.widthOfTextAtSize(next, size) > width) {
        page.drawText(row, { x: 72, y, size, font: f, color: rgb(0.1, 0.1, 0.12) })
        y -= size + 5
        row = word
      } else row = next
    }
    page.drawText(row, { x: 72, y, size, font: f, color: rgb(0.1, 0.1, 0.12) })
    y -= line ? size + 9 : 8
  })
  // Classic xref table: pdf-parse's older PDF reader can't read object streams.
  return Buffer.from(await pdf.save({ useObjectStreams: false }))
}

module.exports = { DESCRIPTION, DOCS, docFile }
