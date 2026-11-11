// @ts-check
'use strict'

// ─── Which language a reply is in ─────────
// The assistant answers in the customer's language; the voice that speaks the
// answer must match it. A guess from the text is enough here: the writing system
// settles most languages, and common short words settle the Latin-script ones.
// English when unsure.

const SCRIPTS = [
  ['hi', /[ऀ-ॿ]/g],          // Devanagari
  ['ja', /[぀-ヿ]/g],          // Hiragana, Katakana (checked before Han)
  ['ko', /[가-힯]/g],          // Hangul
  ['zh', /[一-鿿]/g],          // Han
  ['ar', /[؀-ۿ]/g],          // Arabic
  ['ru', /[Ѐ-ӿ]/g]           // Cyrillic
]

const WORDS = {
  en: 'the and you your is are to for with at have this that on of can what will it my me we be',
  es: 'el la los las de que y en un una para con por es está estás tu su sí hola gracias cita mañana hora puedo quiero tengo hay muy',
  fr: 'le la les de des et est un une pour avec vous je nous pas au du bonjour merci demain heure votre suis',
  de: 'der die das und ist nicht ein eine für mit sie ich wir zu am um termin danke guten morgen uhr ihr bitte',
  it: 'il lo la gli le di che e è un una per con sono ciao grazie appuntamento domani ora vorrei posso',
  pt: 'o a os as de que e é um uma para com não você obrigado obrigada olá horário amanhã hora quero',
  nl: 'de het een en is van voor met niet ik je u op dank afspraak morgen uur graag'
}
const SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(' '))]))
// Letters only one or two of them use.
const HINTS = [['es', /[ñ¿¡]/g, 3], ['pt', /[ãõ]/g, 3], ['de', /ß/g, 3], ['de', /[äöü]/g, 1], ['fr', /[èêàùœ]/g, 1], ['fr', /ç/g, 1], ['pt', /ç/g, 1]]

/**
 * @param {string} text
 * @returns {string} a two-letter code: en, es, fr, de, it, pt, nl, hi, ja, ko, zh, ar or ru
 */
function detectLang(text) {
  const s = String(text || '')
  const letters = (s.match(/\p{L}/gu) || []).length || 1
  for (const [code, re] of SCRIPTS) {
    if ((s.match(re) || []).length / letters > 0.3) return code
  }
  const score = Object.fromEntries(Object.keys(SETS).map(k => [k, 0]))
  for (const w of s.toLowerCase().match(/\p{L}+/gu) || []) {
    for (const k of Object.keys(SETS)) if (SETS[k].has(w)) score[k]++
  }
  for (const [code, re, weight] of HINTS) score[code] += (s.match(re) || []).length * weight
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0]
  return best[1] > score.en ? best[0] : 'en'
}

module.exports = { detectLang }
