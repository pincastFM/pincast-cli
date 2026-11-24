// The release setup: the changelog's entry and version, and the workflow lines a release depends on.
// Every git repo here is a new one in a temp folder; nothing reads the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bump, classify, hasEntry, pinChanges } from '../scripts/changelog.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString()

test('changelog: subjects to groups', () => {
  assert.deepEqual(classify('feat: pincast sets list'), { group: 'Added', text: 'pincast sets list' })
  assert.deepEqual(classify('add: a --quiet option'), { group: 'Added', text: 'A --quiet option' })
  assert.deepEqual(classify('fix(init): keep the folder on Ctrl-C'), { group: 'Fixed', text: 'Keep the folder on Ctrl-C' })
  assert.deepEqual(classify('feat!: drop collects'), { group: 'Breaking', text: 'Drop collects' })
  assert.deepEqual(classify('change: exit 7 for a redirect', 'BREAKING CHANGE: it was 1'), { group: 'Breaking', text: 'Exit 7 for a redirect' })
  assert.deepEqual(classify('Send the set and one collect on the first run'), { group: 'Changed', text: 'Send the set and one collect on the first run' })
  for (const s of ['docs: README', 'test: more cases', 'ci: Node 24', 'chore: tidy', `${PKG.name} 0.1.0: the first release`, 'Release 0.2.0', 'v0.2.0']) {
    assert.equal(classify(s), null, s)
  }
})

test('changelog: versions by the rule, the entry check, and a moved pin', () => {
  assert.equal(bump('0.1.0', 'patch'), '0.1.1')
  assert.equal(bump('0.1.3', 'minor'), '0.2.0')
  assert.equal(bump('0.4.2', 'major'), '1.0.0')
  assert.ok(hasEntry('# Changelog\n\n## 0.1.0\n\nFirst.\n', '0.1.0'))
  assert.ok(!hasEntry('# Changelog\n\n## 0.1.0\n\nFirst.\n', '0.1.1'))
  assert.ok(!hasEntry('## 0.1.01\n', '0.1.0'))
  const dep = Object.keys(PKG.dependencies)[0]
  assert.deepEqual(pinChanges({ dependencies: { [dep]: '0.1.0' } }, { dependencies: { [dep]: '0.1.0' } }), [])
  assert.deepEqual(pinChanges({ dependencies: { [dep]: '0.1.0' } }, { dependencies: { [dep]: '0.2.0' } }), [`\`${dep}\` 0.1.0 to 0.2.0`])
})

test('changelog: the next entry from commits since the tag, written and checked', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pincast-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'pkg')
  for (const f of ['package.json', 'CHANGELOG.md', 'scripts/changelog.mjs']) {
    mkdirSync(join(pkg, f, '..'), { recursive: true })
    cpSync(join(ROOT, f), join(pkg, f))
  }
  const run = (...a) => {
    const r = spawnSync(process.execPath, [join(pkg, 'scripts', 'changelog.mjs'), ...a], { env: GIT_ENV, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  git(pkg, 'init', '-q', '-b', 'main')
  git(pkg, 'add', '-A')
  git(pkg, 'commit', '-q', '-m', `${PKG.name} ${PKG.version}: the first release`)
  assert.equal(run('--check').code, 0)
  assert.match(run().out, new RegExp(`Suggested version: ${PKG.version.replaceAll('.', '\\.')} \\(the first release`))
  git(pkg, 'tag', '-a', `v${PKG.version}`, '-m', `v${PKG.version}`)
  assert.match(run().out, /Nothing to release since v/)

  writeFileSync(join(pkg, 'a.txt'), '1')
  git(pkg, 'add', 'a.txt')
  git(pkg, 'commit', '-q', '-m', 'fix: say which folder is not empty')
  git(pkg, 'commit', '-q', '--allow-empty', '-m', 'docs: a better example')
  let r = run()
  assert.match(r.out, /\(patch after /)
  assert.match(r.out, /### Fixed\n\n- Say which folder is not empty/)
  assert.doesNotMatch(r.out, /better example/)

  const dep = Object.keys(PKG.dependencies)[0]
  const moved = { ...PKG, dependencies: { ...PKG.dependencies, [dep]: '9.9.9' } }
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify(moved, null, 2)}\n`)
  git(pkg, 'commit', '-q', '-am', 'Move the pin')
  r = run()
  assert.match(r.out, new RegExp(`dependency: \`${dep.replace('/', '\\/')}\` ${PKG.dependencies[dep].replaceAll('.', '\\.')} to 9\\.9\\.9`))

  git(pkg, 'commit', '-q', '--allow-empty', '-m', 'feat: a new option')
  r = run()
  assert.match(r.out, /\(minor after /)
  assert.equal(run('--write').code, 0)
  const changelog = readFileSync(join(pkg, 'CHANGELOG.md'), 'utf8')
  const next = bump(PKG.version, 'minor')
  assert.ok(changelog.indexOf(`## ${next}`) < changelog.indexOf(`## ${PKG.version}`), 'newest first')
  assert.ok(changelog.startsWith('# Changelog\n'))
  assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version, next)
  assert.equal(run('--check').code, 0)
  assert.equal(run('--write').code, 1, 'the entry is there already')
  git(pkg, 'commit', '-q', '-am', 'feat!: drop an option')
  assert.match(run().out, /\(major after /)
})

test('the workflows: tests on Node 20.12.0 and 22, a trusted publish with provenance, skipped when on npm', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const pub = readFileSync(join(ROOT, '.github/workflows/publish.yml'), 'utf8')
  assert.match(ci, /node: \['20\.12\.0', '22'\]/)
  for (const line of ['npm test', 'node scripts/changelog.mjs --check', 'npm pack --dry-run']) assert.ok(ci.includes(`run: ${line}`), line)
  assert.match(pub, /tags: \['v\*'\]/)
  assert.match(pub, /id-token: write/)
  assert.match(pub, /npm install -g npm@11\.21\.2/)
  assert.match(pub, /if: steps\.npm\.outputs\.published != 'true'\n\s+run: npm publish --provenance --access public/)
  assert.doesNotMatch(pub + ci, /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/)
  const dep = Object.keys(PKG.dependencies)[0]
  assert.ok(pub.includes(`dependencies['${dep}']`), 'the publish checks the pinned dependency is on npm')
  assert.ok(pub.indexOf(`dependencies['${dep}']`) < pub.indexOf('npm publish --provenance'))
  assert.match(PKG.dependencies[dep], /^\d+\.\d+\.\d+$/, 'pinned to one exact version')
})
