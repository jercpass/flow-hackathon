'use strict'

// ─── Push the Alexa skill's manifest and interaction model (docs/alexa) ─
// Sends docs/alexa/skill-package to Amazon with the ASK CLI (already
// signed in with `ask configure`): the manifest, then the same English model for
// every locale the manifest lists (en-US, en-IN, en-GB, en-CA, en-AU). An Alexa
// whose language is English (India) can't open an en-US-only skill, so each
// locale needs its own copy.
//
// usage:
//   node apps/lambda/scripts/alexa-skill.js            push to the development stage
//   node apps/lambda/scripts/alexa-skill.js --dry-run  print the commands only
//
// Skill ID: ALEXA_SKILL_ID (environment or apps/lambda/.env). Endpoint: the
// flowhq-dev-alexa function's ARN, looked up with the AWS CLI, or ALEXA_LAMBDA_ARN.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { loadEnv } = require('./loadEnv')

loadEnv()
const DRY = process.argv.includes('--dry-run')
const WIN = process.platform === 'win32'
const PKG = path.join(__dirname, '..', '..', '..', 'docs', 'alexa', 'skill-package')
const MODEL = path.join(PKG, 'interactionModels', 'custom', 'en-US.json')

function run(cmd, args, { capture = false } = {}) {
  const shown = [cmd, ...args.map(a => (/\s/.test(a) ? `"${a}"` : a))].join(' ')
  console.log(`$ ${shown}`)
  if (DRY) return ''
  // On Windows `ask` and `aws` are .cmd files, which need a shell.
  const r = spawnSync(WIN ? shown : cmd, WIN ? [] : args, { shell: WIN, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
  if (r.status !== 0) {
    console.error(`\n✗ ${cmd} failed (exit ${r.status}). Nothing after this step was sent.`)
    process.exit(1)
  }
  return (r.stdout || '').trim()
}

const skillId = process.env.ALEXA_SKILL_ID
if (!skillId) {
  console.error('✗ ALEXA_SKILL_ID isn’t set. Put it in apps/lambda/.env (see docs/alexa/README.md).')
  process.exit(1)
}

const arn = process.env.ALEXA_LAMBDA_ARN || (DRY ? 'arn:aws:lambda:us-east-1:ACCOUNT_ID:function:flowhq-dev-alexa'
  : run('aws', ['lambda', 'get-function', '--function-name', 'flowhq-dev-alexa', '--region', 'us-east-1', '--query', 'Configuration.FunctionArn', '--output', 'text'], { capture: true }))
if (!/^arn:aws:lambda:/.test(arn)) {
  console.error(`✗ Couldn’t find the flowhq-dev-alexa function (got "${arn}"). Set ALEXA_LAMBDA_ARN instead.`)
  process.exit(1)
}

const skill = JSON.parse(fs.readFileSync(path.join(PKG, 'skill.json'), 'utf8'))
skill.manifest.apis.custom.endpoint.uri = arn
const locales = Object.keys(skill.manifest.publishingInformation.locales)
const manifestFile = path.join(os.tmpdir(), 'flow-alexa-skill.json')
fs.writeFileSync(manifestFile, JSON.stringify(skill, null, 2))

run('ask', ['smapi', 'update-skill-manifest', '--skill-id', skillId, '--stage', 'development', '--manifest', `file:${manifestFile}`])
for (const locale of locales) {
  run('ask', ['smapi', 'set-interaction-model', '--skill-id', skillId, '--stage', 'development', '--locale', locale, '--interaction-model', `file:${MODEL}`])
}

console.log(`\n✓ Sent the manifest and the model for ${locales.join(', ')}.`)
console.log('Amazon builds each model in a minute or two. Check with:')
console.log(`  ask smapi get-skill-status --skill-id ${skillId}`)
console.log('Then on the Alexa app, type: open flow bookings')
