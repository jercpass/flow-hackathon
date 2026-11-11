'use strict'

// ─── Receipt formatting ───────────────────────────────────────────────────────
// Deterministic — NO AI. Every value is already known at payment time, so a
// receipt is pure string templating: zero tokens, zero API calls, runs inline
// in the webhook Lambda. The same assembled data can later feed a PDF generator.

function formatIST(isoOrDate, timeZone = 'Asia/Kolkata') {
  const d = isoOrDate ? new Date(isoOrDate) : new Date()
  if (isNaN(d.getTime())) return formatIST(null, timeZone)
  if (timeZone === 'Asia/Kolkata') {
    return new Intl.DateTimeFormat('en-IN', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(d)
  }
  // Flow's one time style: "Oct 28, 2026, 9 AM" / "10:30 AM" (no leading zero, no ":00").
  return new Intl.DateTimeFormat('en-US', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(d).replace(/:00(\s?[AP]M)/, '$1').replace(/ /g, ' ')
}

// INR keeps the original Indian formatting; any other currency (PayPal/Flow)
// goes through utils/money.formatMoney.
function receiptAmount(amount, currency, { pdf = false } = {}) {
  if (!currency || currency === 'INR') return `${pdf ? 'Rs ' : '₹'}${Number(amount || 0).toLocaleString('en-IN')}`
  return require('./money').formatMoney(amount, currency)
}

function buildReceipt({ businessName, gstin, serviceName, amount, currency, paymentId, paidAt, bookingTime, timeZone }) {
  const lines = [
    `🧾 *Receipt — ${businessName}*`,
    '',
    `${serviceName}`,
    `Amount paid: ${receiptAmount(amount, currency)}`,
    `Payment ID: ${paymentId}`,
    `Paid: ${formatIST(paidAt, timeZone)}`,
    `Booking: ${formatIST(bookingTime, timeZone)}`,
  ]
  if (gstin) lines.push('', `GSTIN: ${gstin}`)
  lines.push('', 'Thank you for your booking!')
  return lines.join('\n')
}

// Render the same receipt data as a PDF (Buffer), attached to the booking's inbox message.
// This is a payment RECEIPT, not a tax invoice — Flow-generated, scalable to every
// business with no per-business accounting org. Deterministic, no AI.
async function renderReceiptPdf({ businessName, gstin, serviceName, amount, currency, paymentId, paidAt, bookingTime, timeZone,
  customerName, staffName, total, refunded, invoiceNumber, invoiceStatus, policy }) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([420, 600])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ink = rgb(0.1, 0.1, 0.1)
  const muted = rgb(0.45, 0.45, 0.45)
  const W = 420
  let y = 550
  // Standard PDF fonts only cover Latin-1: drop anything else rather than fail.
  const safe = s => String(s ?? '-').replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
  const money = v => receiptAmount(v, currency, { pdf: true })

  const text = (s, { size = 11, f = font, color = ink, x = 40 } = {}) =>
    page.drawText(safe(s), { x, y, size, font: f, color })
  const right = (s, { size = 11, f = font, color = ink } = {}) =>
    page.drawText(safe(s), { x: W - 40 - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color })
  const rule = () => page.drawLine({ start: { x: 40, y: y + 8 }, end: { x: W - 40, y: y + 8 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) })
  const row = (label, value, opts = {}) => { y -= 22; text(label, { color: muted }); right(value, opts) }

  text(businessName || 'Receipt', { size: 18, f: bold })
  y -= 22; text(invoiceNumber ? `Receipt for PayPal invoice ${invoiceNumber}` : 'Payment receipt', { size: 11, color: muted })
  if (invoiceStatus) right(invoiceStatus, { size: 11, f: bold })
  y -= 26; rule()
  y -= 18; text('Service', { color: muted }); right(serviceName || '-')
  if (customerName) row('Customer', customerName)
  if (staffName) row('With', staffName)
  row('Booking', formatIST(bookingTime, timeZone), { size: 10 })
  y -= 12; rule()
  const paid = Number(amount || 0)
  const refundedNum = Number(refunded || 0)
  const totalNum = Number(total || 0) || paid
  if (totalNum > paid + 0.001) row('Price', money(totalNum))
  row('Paid with PayPal', money(paid), { f: bold })
  if (refundedNum > 0) row('Refunded', `- ${money(refundedNum)}`)
  if (totalNum > paid + 0.001) row('Still to pay', money(Math.round((totalNum - paid) * 100) / 100))
  row('Payment ID', paymentId || '-', { size: 9 })
  row('Paid on', formatIST(paidAt, timeZone), { size: 10 })
  if (gstin) row('GSTIN', gstin, { size: 10 })
  y -= 30; rule()
  if (policy) {
    y -= 16; text('Cancellation policy', { size: 9, f: bold, color: muted })
    // Wrap the policy to the page width.
    let line = ''
    for (const word of safe(policy).split(' ')) {
      const next = line ? line + ' ' + word : word
      if (font.widthOfTextAtSize(next, 9) > W - 80) { y -= 13; text(line, { size: 9, color: muted }); line = word } else line = next
    }
    if (line) { y -= 13; text(line, { size: 9, color: muted }) }
    y -= 10
  }
  y -= 18; text('Thank you for your booking!', { size: 11, f: bold })
  y -= 20; text(invoiceNumber ? 'The official invoice is in PayPal; this receipt matches it.' : 'This is a computer-generated receipt.', { size: 8, color: muted })

  return Buffer.from(await doc.save())
}

module.exports = { buildReceipt, renderReceiptPdf, formatIST }
