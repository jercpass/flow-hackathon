// Invisible characters (BOM, zero-width and non-breaking space) routinely survive
// a copy-paste into a hosting dashboard's env var editor. They are invisible in
// logs, in `grep`, and in the Vercel UI, but they silently corrupt the value:
//   - a leading BOM stops a URL being absolute, so fetch resolves it against our
//     own origin and every API call 404s against Next.js
//   - it makes an app id that Facebook rejects
// Both have bitten this project, so strip them at every env read site.
const INVISIBLE = [0xFEFF, 0x200B, 0x200E, 0x200F, 0x00A0]

function isInvisible(code) {
  return INVISIBLE.includes(code)
}

export function cleanEnv(raw) {
  let s = String(raw || '')
  while (s.length && isInvisible(s.charCodeAt(0))) s = s.slice(1)
  while (s.length && isInvisible(s.charCodeAt(s.length - 1))) s = s.slice(0, -1)
  return s.trim()
}

// Same, plus drop any trailing slashes so `${base}${path}` never doubles up.
export function cleanUrl(raw) {
  let s = cleanEnv(raw)
  while (s.endsWith('/')) s = s.slice(0, -1)
  return s
}
