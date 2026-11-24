#!/usr/bin/env node
// Writes the next CHANGELOG.md entry from the commits since the last release tag (v<version>),
// and suggests the version by the rule in the README (Versions). Taken from @pincast/api's script,
// without its API file comparison: this package has no API file of its own.
//
//   node scripts/changelog.mjs                     print the next entry and the suggested version
//   node scripts/changelog.mjs --write             add the entry to CHANGELOG.md and set package.json's version
//   node scripts/changelog.mjs --write --version 0.3.0   the same, with the version you choose
//   node scripts/changelog.mjs --check             exit 1 unless CHANGELOG.md has an entry for package.json's version
//
// Commit subjects are read conventional-ish:
//   feat: or add:          Added (minor)
//   fix:                   Fixed (patch)
//   type!: or a body line starting BREAKING CHANGE: or BREAKING:   Breaking (major)
//   docs, test, ci, chore, build, style, refactor, and release commits   left out
//   anything else          Changed (patch), the subject as written
// A dependency pinned to a new exact version since the tag adds a Changed line, at least a patch. The
// README's Versions section says to take the larger of the two changes, so read that package's
// changelog and pass --version when its change was bigger. The entry is a draft: edit each line so a
// reader of the package knows what changed for them.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEVELS = ['none', 'patch', 'minor', 'major']
const LEFT_OUT = new Set(['docs', 'doc', 'test', 'tests', 'ci', 'chore', 'build', 'style', 'refactor', 'release'])
const NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
const escape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString()

// One commit subject (and body) to its group, or null when it stays out of the changelog.
export function classify(subject, body = '', name = NAME) {
  if (new RegExp(`^(release\\b|v?\\d+\\.\\d+\\.\\d+\\b|${escape(name)} \\d)`, 'i').test(subject)) return null
  const m = /^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$/i.exec(subject)
  const breaking = Boolean(m?.[3]) || /^BREAKING( CHANGE)?:/m.test(body)
  const type = m?.[1].toLowerCase()
  const text = upper(m ? m[4] : subject)
  if (breaking) return { group: 'Breaking', text }
  if (type && LEFT_OUT.has(type)) return null
  if (type === 'feat' || type === 'add') return { group: 'Added', text }
  if (type === 'fix') return { group: 'Fixed', text }
  return { group: 'Changed', text: m && !['change', 'perf', 'revert'].includes(type) ? upper(subject) : text }
}

const GROUP_LEVEL = { Breaking: 'major', Added: 'minor', Fixed: 'patch', Changed: 'patch' }

/** The dependencies whose pinned version moved between two package.json objects, as Changed lines. */
export function pinChanges(before, after) {
  const was = before?.dependencies || {}
  const now = after?.dependencies || {}
  const out = []
  for (const [dep, v] of Object.entries(now)) {
    if (!(dep in was)) out.push(`Depends on \`${dep}\` ${v}`)
    else if (was[dep] !== v) out.push(`\`${dep}\` ${was[dep]} to ${v}`)
  }
  for (const dep of Object.keys(was)) if (!(dep in now)) out.push(`No longer depends on \`${dep}\``)
  return out
}

// Capitalizes a plain first word, and leaves one that reads as code (runCreate(), npm) alone.
function upper(s) {
  const word = /^\S+/.exec(s)?.[0] || ''
  return /^[a-z]+[,.:;]?$/.test(word) && !CODE_WORDS.has(word) ? s.charAt(0).toUpperCase() + s.slice(1) : s
}
const CODE_WORDS = new Set(['npm', 'node', 'git', 'pincast'])

export function bump(version, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`${version} is not a plain x.y.z version: pass --version`)
  const [x, y, z] = m.slice(1).map(Number)
  if (level === 'major') return `${x + 1}.0.0`
  if (level === 'minor') return `${x}.${y + 1}.0`
  return `${x}.${y}.${z + 1}`
}

export function hasEntry(changelog, version) {
  return new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`, 'm').test(changelog)
}

function lastTag() {
  try { return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*').trim() } catch { return null }
}

function commitsSince(tag) {
  let out
  try { out = git('log', '--no-merges', '--format=%s%x1f%b%x1e', tag ? `${tag}..HEAD` : 'HEAD') } catch { return [] }
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [subject, body = ''] = r.split('\x1f')
    return { subject: subject.trim(), body }
  })
}

export function nextEntry() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const tag = lastTag()
  const groups = { Breaking: [], Added: [], Fixed: [], Changed: [] }
  let level = 'none'
  const raise = (l) => { if (LEVELS.indexOf(l) > LEVELS.indexOf(level)) level = l }
  for (const c of commitsSince(tag)) {
    const got = classify(c.subject, c.body, pkg.name)
    if (!got) continue
    groups[got.group].push(got.text)
    raise(GROUP_LEVEL[got.group])
  }
  const reasons = []
  if (tag) {
    let before = null
    try { before = JSON.parse(git('show', `${tag}:package.json`)) } catch { /* the tag has no package.json */ }
    for (const line of pinChanges(before, pkg)) {
      groups.Changed.push(line)
      reasons.push(`dependency: ${line} (read its changelog: a bigger change there makes this release bigger too)`)
      raise('patch')
    }
  }
  const base = tag ? tag.replace(/^v/, '') : null
  const version = !tag ? pkg.version : level === 'none' ? null : bump(base, level)
  const lines = []
  for (const [group, items] of Object.entries(groups)) {
    if (!items.length) continue
    lines.push(`### ${group}`, '', ...[...new Set(items)].map((t) => `- ${t}`), '')
  }
  return { tag, base, level, version, reasons, body: lines.join('\n') }
}

function main(args) {
  const valueOf = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
  const known = new Set(['--write', '--check', '--version'])
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version') { i++; continue }
    if (!known.has(args[i])) { console.error(`unknown option ${args[i]}`); return 2 }
  }
  const changelogPath = join(ROOT, 'CHANGELOG.md')
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''

  if (args.includes('--check')) {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    if (hasEntry(changelog, version)) { console.log(`OK: CHANGELOG.md has an entry for ${version}.`); return 0 }
    console.error(`CHANGELOG.md has no "## ${version}" entry for package.json's version: run npm run changelog`)
    return 1
  }

  const next = nextEntry()
  const version = valueOf('--version') ?? next.version
  if (args.includes('--version') && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '')) { console.error('--version needs x.y.z'); return 2 }
  const since = next.tag ? `since ${next.tag}` : 'with no release tag yet'
  if (!version) { console.log(`Nothing to release ${since}: every commit is left out (docs, tests, CI, chores).`); return args.includes('--write') ? 1 : 0 }
  const entry = `## ${version}\n\n${next.body || '- (no listed changes: say what this release is for)\n'}`.trimEnd() + '\n'

  if (!args.includes('--write')) {
    console.log(`Suggested version: ${version} (${next.tag ? `${next.level} after ${next.base}` : 'the first release: package.json\'s version'}), ${since}.`)
    for (const r of next.reasons) console.log(`  ${r}`)
    if (hasEntry(changelog, version)) console.log(`CHANGELOG.md already has an entry for ${version}.`)
    console.log('')
    console.log(entry)
    return 0
  }
  if (hasEntry(changelog, version)) { console.error(`CHANGELOG.md already has an entry for ${version}`); return 1 }
  const at = changelog.search(/^## /m)
  const head = changelog ? (at === -1 ? changelog.trimEnd() + '\n\n' : changelog.slice(0, at)) : '# Changelog\n\n'
  const rest = at === -1 ? '' : changelog.slice(at)
  writeFileSync(changelogPath, `${head}${entry}${rest ? '\n' + rest : ''}`)
  const pkgPath = join(ROOT, 'package.json')
  const pkgText = readFileSync(pkgPath, 'utf8')
  writeFileSync(pkgPath, pkgText.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`))
  console.log(`Wrote the ${version} entry to CHANGELOG.md and set package.json's version to ${version}. Edit the entry, then commit.`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)))
