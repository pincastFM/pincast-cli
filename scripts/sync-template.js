// Rebuilds template/ and template.json from one commit of the example app.
//   node scripts/sync-template.js <path to pincast-kit-example> <commit>
// It reads the commit from git, so nothing uncommitted in that checkout can reach the package.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [repo, commit] = process.argv.slice(2)
if (!repo || !commit) {
  console.error('Usage: node scripts/sync-template.js <path to pincast-kit-example> <commit>')
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 })
const STORED = { '.gitignore': '_gitignore', '.env.example': '_env.example', 'package-lock.json': '_package-lock.json' }

const sha = git('rev-parse', '--verify', `${commit}^{commit}`).toString().trim()
const names = git('ls-tree', '-r', '-z', '--name-only', sha).toString().split('\0').filter(Boolean).sort()

rmSync(join(root, 'template'), { recursive: true, force: true })
const files = {}
for (const name of names) {
  const bytes = git('show', `${sha}:${name}`)
  const to = join(root, 'template', STORED[name] ?? name)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, bytes)
  files[name] = createHash('sha256').update(bytes).digest('hex')
}
writeFileSync(join(root, 'template.json'), `${JSON.stringify({ source: 'pincast-kit-example', commit: sha, files }, null, 2)}\n`)
console.log(`${names.length} files from ${sha}`)
