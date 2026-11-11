// Browser-side media helpers for the chat: record a voice note, normalise audio
// to 16 kHz mono WAV (a format every speech model accepts — browsers record
// WebM/Opus or Ogg, which some don't), downscale photos, and base64-encode files.
// The limits match the server's (apps/lambda services/media.js).

export const MAX_VOICE_SECONDS = 60
const MAX_FILE_BYTES = 4_000_000
const MAX_IMAGE_SIDE = 1600
// Word, Excel and text files: the server pulls the text out (services/docText).
const DOC_EXT = /\.(docx|xlsx|txt|csv|tsv|md)$/i
const OLD_OFFICE = /\.(doc|xls|ppt|pptx|odt|ods|rtf|pages|numbers)$/i
export const FILE_ACCEPT = 'image/*,application/pdf,audio/*,.docx,.xlsx,.txt,.csv,.tsv,.md'

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

// Any audio the browser can decode → 16 kHz mono 16-bit PCM WAV.
export async function toWav16k(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext
  const ctx = new Ctx()
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
  ctx.close()
  const rate = 16000
  const length = Math.max(1, Math.ceil(decoded.duration * rate))
  const off = new OfflineAudioContext(1, length, rate)          // 1 channel = automatic downmix
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const pcm = (await off.startRendering()).getChannelData(0)

  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2))
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  str(36, 'data'); view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return { blob: new Blob([view], { type: 'audio/wav' }), durationSec: decoded.duration }
}

async function downscaleImage(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
}

// A picked file → the chat API's attachment object (+ a local preview URL).
export async function fileToAttachment(file) {
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('image/')) {
    const blob = await downscaleImage(file)
    if (blob.size > MAX_FILE_BYTES) throw new Error('That photo is too large.')
    return { attachment: { kind: 'image', mimeType: 'image/jpeg', name: file.name, data: await blobToBase64(blob) }, preview: URL.createObjectURL(blob) }
  }
  if (type === 'application/pdf') {
    if (file.size > MAX_FILE_BYTES) throw new Error('PDFs can be up to 4 MB.')
    return { attachment: { kind: 'pdf', mimeType: 'application/pdf', name: file.name, data: await blobToBase64(file) } }
  }
  if (DOC_EXT.test(file.name)) {
    if (file.size > MAX_FILE_BYTES) throw new Error('Files can be up to 4 MB.')
    return { attachment: { kind: 'doc', mimeType: type, name: file.name, data: await blobToBase64(file) } }
  }
  if (type.startsWith('audio/')) return audioToAttachment(file, file.name)
  if (OLD_OFFICE.test(file.name)) throw new Error('Save it as Word (.docx), Excel (.xlsx) or PDF and send it again.')
  throw new Error('You can send photos, PDFs, Word, Excel or text files, or voice notes.')
}

export async function audioToAttachment(blob, name = 'voice-note') {
  const { blob: wav, durationSec } = await toWav16k(blob)
  if (durationSec > MAX_VOICE_SECONDS + 1) throw new Error(`Voice notes can be up to ${MAX_VOICE_SECONDS} seconds.`)
  return { attachment: { kind: 'audio', mimeType: 'audio/wav', name, durationSec: Math.round(durationSec), data: await blobToBase64(wav) } }
}

// Voice note recorder: start() → stop() resolves the recorded Blob.
export async function startRecorder() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Voice notes need a browser with microphone support.')
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const recorder = new MediaRecorder(stream)
  const chunks = []
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  recorder.start()
  const stopped = new Promise(resolve => {
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop())
      resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
    }
  })
  return {
    stop: () => { if (recorder.state !== 'inactive') recorder.stop(); return stopped },
    cancel: () => { if (recorder.state !== 'inactive') recorder.stop(); chunks.length = 0 }
  }
}
