// @ts-check
'use strict'

// What Under the hood calls a model: its product name, so you can see which AI
// did what ("Claude Haiku 5.5 replied", "transcribed by Gemini 3.5 Flash").
// Naming the tools Flow uses is fine (organizers, Oct 29); Flow's brand stays Flow.

const cap = s => s.charAt(0).toUpperCase() + s.slice(1)

/** "claude-haiku-5-5" → "Claude Haiku 5.5", "gemini-3.5-flash-lite" → "Gemini 3.5 Flash-Lite", "whisper-large-v3-turbo" → "Whisper Large v3 Turbo". Unknown ids pass through. */
function modelName(id) {
  const s = String(id || '')
  const claude = s.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/)
  if (claude) return `Claude ${cap(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  if (s.startsWith('whisper-')) return s.split('-').map(w => (/^v[0-9]/.test(w) ? w : cap(w))).join(' ')
  if (s.startsWith('gemini-')) return s.split('-').map(w => (w === 'tts' ? 'TTS' : w === 'lite' ? '-Lite' : cap(w))).join(' ').replace(' -Lite', '-Lite')
  return s || 'the AI'
}

module.exports = { modelName }
