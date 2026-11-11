'use strict'

// Minimal .env loader for local scripts (no dotenv dependency). Reads
// apps/lambda/.env; real environment variables win over file values, except
// Flow's AI keys below.
const fs = require('fs')
const path = require('path')

// Flow's AI keys come only from apps/lambda/.env (or AWS, where a script
// looks there), never from the terminal: a key already set in your shell may
// belong to another tool, such as a coding assistant's own Anthropic key, and
// would otherwise be used (and billed) by mistake.
const FILE_ONLY = ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']

function loadEnv(file = path.join(__dirname, '..', '.env')) {
  for (const k of FILE_ONLY) delete process.env[k]
  if (!fs.existsSync(file)) return false
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
  return true
}

module.exports = { loadEnv }
