import { constants, chmodSync, copyFileSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Moved here from create-pincast 0.1.0 (6fb6be7). The command's name is now an argument, so the text
// reads `pincast init` here and `npm create pincast` from the create-pincast shim.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The starter's files and the commit they came from.
export const manifest = JSON.parse(readFileSync(join(root, 'template.json'), 'utf8'))

const STARTER_ID = 'lantern-walk'
const SET_ID = 'old-town-lanterns'
export const TEST_PERSON = 'test_demo'

// The example app's README predates test keys. template/ is rebuilt byte for byte from that repo, so a
// fix made there would be lost at the next sync. Each new app's copy is corrected here instead. Once the
// example drops the sentence, this replaces nothing.
const OLD_KEY_LINE = 'Every Pincast key is live, so anything you write with one is real.'
export const LIVE_KEY_LINE = 'A live key writes real data, and no API call deletes it.'

// npm pack drops or rewrites these names, so the package stores them under another.
const STORED = { '.gitignore': '_gitignore', '.env.example': '_env.example', 'package-lock.json': '_package-lock.json' }
export const storedPath = file => join(root, 'template', STORED[file] ?? file)

/**
 * Copies the starter into an empty folder. Refuses to replace any file. Each file joins `written` as
 * it lands, so a copy that fails partway can still be taken back.
 */
export function copyStarter(target, written) {
  for (const file of Object.keys(manifest.files)) {
    const to = join(target, file)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(storedPath(file), to, constants.COPYFILE_EXCL)
    written.push(file)
  }
}

/**
 * Takes back what copyStarter wrote. madeFrom is the highest folder this run made, if any: those
 * folders go too, unless something else is in them.
 */
export function removeStarter(target, files, madeFrom) {
  for (const file of files) rmSync(join(target, file), { force: true })
  const folders = new Set()
  for (const file of Object.keys(manifest.files)) {
    for (let d = dirname(file); d !== '.'; d = dirname(d)) folders.add(d)
  }
  for (const d of [...folders].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(join(target, d))
    } catch { /* missing, or something else is in it: leave it */ }
  }
  if (!madeFrom) return
  for (let d = target; d.length >= madeFrom.length; d = dirname(d)) {
    try {
      rmdirSync(d)
    } catch {
      return
    }
    if (d === madeFrom) return
  }
}

/** Writes .env, readable only by this account. The claim link is quoted because it holds a #. */
export function writeEnv(target, { key, claimUrl, customBase, command }) {
  const lines = [
    `# Made by ${command}. This file holds your test key, so keep it private.`,
    `PINCAST_KEY=${key}`,
    `PINCAST_ACTOR=${TEST_PERSON}`,
    `PINCAST_CLAIM_URL="${claimUrl}"`,
  ]
  if (customBase) lines.push(`PINCAST_API=${customBase}`)
  const path = join(target, '.env')
  writeFileSync(path, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Puts the app's id in shared/app.js and in the goldens, which draw it into every card's data-id. */
export function setAppId(target, id) {
  const appFile = join(target, 'shared', 'app.js')
  const source = readFileSync(appFile, 'utf8')
  const line = `{ id: '${STARTER_ID}',`
  if (source.split(line).length !== 2) throw new Error('app id line not found')
  writeFileSync(appFile, source.replace(line, `{ id: '${id}',`))
  for (const file of Object.keys(manifest.files)) {
    if (!/^test\/goldens\/.+\.html$/.test(file)) continue
    const path = join(target, file)
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(`data-id="${STARTER_ID}:`, `data-id="${id}:`))
  }
}

/** The commands that put a live card on the table, as printed and as written in the README. */
export function firstRunCommands(base) {
  return [
    'set -a; . ./.env; set +a',
    `curl -X PUT ${base}/sets/${SET_ID} \\`,
    '  -H "X-Pincast-Key: $PINCAST_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d @data/set.json',
    `curl -X POST ${base}/sets/${SET_ID}/collects \\`,
    '  -H "X-Pincast-Key: $PINCAST_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{ "card": "lantern:ferry-steps", "actor": { "id": "${TEST_PERSON}", "source": "anonymous" } }'`,
  ]
}

/**
 * Adds this copy's own section to its README. The starter's Go live steps open by replacing .env, which
 * here would erase the key. The claim link stays out, because a README gets committed.
 */
export function addReadmeSection(target, { id, base, endsOn, command }) {
  const path = join(target, 'README.md')
  const readme = readFileSync(path, 'utf8').replace(OLD_KEY_LINE, () => LIVE_KEY_LINE)
  const anchor = '## Run it\n'
  if (readme.split(anchor).length !== 2) throw new Error('README anchor not found')
  const section = [
    '## Your test app',
    '',
    `\`${command}\` made this copy and the test app \`${id}\` for it. The key and the claim link are in \`.env\`, which git ignores. A test key writes only to this app, and only for test people, whose ids start with \`test_\`.`,
    '',
    'To see live cards, install the app, send its set and one collect, then start it:',
    '',
    '```sh',
    'npm ci',
    ...firstRunCommands(base),
    'npm run dev',
    '```',
    '',
    `The app ends on ${endsOn} unless you claim it. To keep it, open the \`PINCAST_CLAIM_URL\` from \`.env\` while signed in to Pincast.`,
    '',
    'Save the Go live section below for when you have a live key. Its first step replaces `.env`, which would erase this key.',
    '',
    '',
  ].join('\n')
  writeFileSync(path, readme.replace(anchor, () => section + anchor))
}
