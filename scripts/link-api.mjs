// Until @pincast/api is on npm, this puts the local checkout at node_modules/@pincast/api, so the tests
// and the command can run from this repo. package.json already names the version that gets published.
//   node scripts/link-api.mjs [path to pincast-api]   (default: ../pincast-api, or PINCAST_API_REPO)
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = resolve(process.argv[2] || process.env.PINCAST_API_REPO || join(root, '..', 'pincast-api'))
const want = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['@pincast/api']
const have = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
if (have.name !== '@pincast/api' || have.version !== want) {
  console.error(`${from} holds ${have.name}@${have.version}, and this package needs @pincast/api@${want}.`)
  process.exit(1)
}
const to = join(root, 'node_modules', '@pincast', 'api')
mkdirSync(dirname(to), { recursive: true })
if (existsSync(to) || lstatSync(to, { throwIfNoEntry: false })) rmSync(to, { recursive: true, force: true })
symlinkSync(from, to, 'dir')
console.log(`node_modules/@pincast/api now points at ${from} (${have.version}).`)
