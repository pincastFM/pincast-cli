// pincast init: create-pincast's flow (test/init-create-pincast.test.js runs that file's own tests on the
// same code), plus what the pincast front adds: --json, --api, its exit codes and its own name.
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { EXIT } from '../src/exit.js'
import { manifest, runCreate } from '../src/init/index.js'
import { noFetch, pincast, printed, removeDir, tempDir } from './helpers.js'

const ID = 'test-k3f7x2m4qa'
const SECRET = 'Mock0Secret0Mock0Secret0Mock0Secret0Mock0'
const KEY = `pck_${ID}_rk_${SECRET}`
const CODE = `pcc_${'a1B2_c3D-'.repeat(5)}abcdefgh`.slice(0, 47)
const CLAIM = `https://pincast.fm/developers/claim#code=${CODE}`
const GOOD = {
  app: { id: ID, name: 'Test app', mode: 'test', expiresAt: '2026-11-29T15:04:05.123Z' },
  key: KEY, keyId: 'key_0123456789ab',
  claim: { code: CODE, url: CLAIM, expiresAt: '2026-11-29T15:04:05.123Z' },
  api: 'https://api.pincast.fm/v1',
}

let dir
let server
let calls
const startApi = async (status, body, headers = {}) => {
  calls = []
  server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      if (body === 'lost') return req.socket.destroy()
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${server.address().port}/v1`
}
beforeEach(() => { dir = tempDir('pincast-init-') })
afterEach(async () => {
  if (server) await new Promise((done) => { server.closeAllConnections(); server.close(done) })
  server = null
  removeDir(dir)
})

describe('pincast init --json', () => {
  it('makes the app and answers one JSON object that names where the key is, never the key', async () => {
    const api = await startApi(200, GOOD)
    const r = await pincast(['init', 'my-app', '--json'], { env: { PINCAST_API: api }, cwd: dir })
    assert.equal(r.code, 0, r.stdout)
    assert.equal(r.stderr, '')
    assert.ok(!r.stdout.includes(SECRET))
    const app = join(dir, 'my-app')
    assert.deepEqual(r.json, {
      ok: true,
      command: 'init',
      app: { id: ID, mode: 'test', expiresAt: '2026-11-29T15:04:05.123Z', endsOn: '2026-11-29' },
      folder: app,
      env: join(app, '.env'),
      keyIn: { file: join(app, '.env'), name: 'PINCAST_KEY' },
      actor: 'test_demo',
      claimUrl: CLAIM,
      api,
      next: r.json.next,
    })
    assert.equal(r.json.next[0], 'cd my-app')
    assert.equal(r.json.next.at(-1), 'npm run dev')
    const env = parseEnv(readFileSync(join(app, '.env'), 'utf8'))
    assert.equal(env.PINCAST_KEY, KEY)
    assert.equal(env.PINCAST_API, api)
    assert.equal(statSync(join(app, '.env')).mode & 0o777, 0o600)
    assert.match(readFileSync(join(app, '.env'), 'utf8'), /^# Made by pincast init\./)
    assert.ok(readFileSync(join(app, 'README.md'), 'utf8').includes('`pincast init` made this copy'))
    for (const file of Object.keys(manifest.files)) assert.ok(existsSync(join(app, file)), file)
  })

  it('makes exactly one POST, with no body, no Origin and its own User-Agent', async () => {
    const api = await startApi(200, GOOD)
    await pincast(['init', '--json'], { env: { PINCAST_API: api }, cwd: dir })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, '/v1/test-apps')
    assert.equal(calls[0].body, '')
    assert.equal(calls[0].headers.origin, undefined)
    assert.match(calls[0].headers['user-agent'], /^pincast-cli\/\d+\.\d+\.\d+$/)
    assert.ok(existsSync(join(dir, 'pincast-app', '.env')))
  })

  it('takes --api over PINCAST_API, and PINCAST_CREATE_API last', async () => {
    const api = await startApi(200, GOOD)
    const r = await pincast(['init', 'a', '--api', api, '--json'], { env: { PINCAST_API: 'https://unused.invalid/v1' }, cwd: dir })
    assert.equal(r.code, 0)
    const r2 = await pincast(['init', 'b', '--json'], { env: { PINCAST_CREATE_API: api }, cwd: dir })
    assert.equal(r2.code, 0)
    assert.equal(calls.length, 2)
  })
})

describe('pincast init failures', () => {
  const cases = [
    ['429 test_apps_limit', 429, { statusCode: 429, data: { code: 'test_apps_limit' } }, { 'Retry-After': '3600' }, EXIT.wait, 'test_apps_limit'],
    ['another 429', 429, { statusCode: 429 }, { 'Retry-After': '600' }, EXIT.wait, 'rate_limited'],
    ['404', 404, { statusCode: 404 }, {}, EXIT.not_found, 'no_test_app_service'],
    ['403 browser_not_allowed', 403, { statusCode: 403, data: { code: 'browser_not_allowed' } }, {}, EXIT.refused, 'browser_not_allowed'],
    ['500', 500, { statusCode: 500 }, {}, EXIT.later, 'server_error'],
    ['307', 307, {}, { Location: 'https://elsewhere.invalid/' }, EXIT.later, 'redirected'],
    ['a garbled 200', 200, `{"key":"${KEY}",`, {}, EXIT.failed, 'answer_unreadable'],
    ['a lost answer', 200, 'lost', {}, EXIT.later, 'answer_lost'],
  ]
  for (const [name, status, body, headers, exit, code] of cases) {
    it(`exits ${exit} with ${code} for ${name}, takes back the folder and never prints the key`, async () => {
      const api = await startApi(status, body, headers)
      const r = await pincast(['init', 'my-app', '--json'], { env: { PINCAST_API: api }, cwd: dir })
      assert.equal(r.code, exit, r.stdout)
      assert.equal(r.json.ok, false)
      assert.equal(r.json.error.code, code)
      assert.equal(r.json.error.exitCode, exit)
      assert.ok(r.json.error.message)
      assert.equal(calls.length, 1, 'one call, never a second')
      assert.ok(!existsSync(join(dir, 'my-app')), 'folder taken back')
      assert.ok(!r.stdout.includes(SECRET))
    })
  }

  it('reports the wait in seconds for a 429', async () => {
    const api = await startApi(429, { statusCode: 429, data: { code: 'test_apps_limit' } }, { 'Retry-After': '3600' })
    const r = await pincast(['init', '--json'], { env: { PINCAST_API: api }, cwd: dir })
    assert.equal(r.json.error.retryAfter, 3600)
    assert.equal(r.json.error.status, 429)
  })

  it('exits 8 for a folder with files in it, and 2 for a second folder or an address that is not local http', async () => {
    const f = noFetch()
    mkdirSync(join(dir, 'full'))
    writeFileSync(join(dir, 'full', 'keep.txt'), 'mine')
    const full = await pincast(['init', 'full', '--json'], { env: {}, cwd: dir, fetchImpl: f })
    const two = await pincast(['init', 'a', 'b', '--json'], { env: {}, cwd: dir, fetchImpl: f })
    const plain = await pincast(['init', 'c', '--api', 'http://example.org/v1', '--json'], { env: {}, cwd: dir, fetchImpl: f })
    assert.deepEqual([full.code, two.code, plain.code], [EXIT.local, EXIT.usage, EXIT.usage])
    assert.equal(full.json.error.code, 'folder_not_empty')
    assert.deepEqual(readdirSync(join(dir, 'full')), ['keep.txt'])
    assert.equal(f.calls.length, 0)
  })

  it('exits 7 when Pincast cannot be reached, and leaves nothing behind', async () => {
    const closed = createServer()
    await new Promise(done => closed.listen(0, '127.0.0.1', done))
    const port = closed.address().port
    await new Promise(done => closed.close(done))
    const r = await pincast(['init', 'x', '--json'], { env: { PINCAST_API: `http://127.0.0.1:${port}/v1` }, cwd: dir })
    assert.equal(r.code, EXIT.later)
    assert.equal(r.json.error.code, 'unreachable')
    assert.deepEqual(readdirSync(dir), [])
  })
})

describe('one code path', () => {
  it('prints what create-pincast prints, but for its own name', async () => {
    const api = await startApi(200, GOOD)
    const mine = await pincast(['init', 'appmine'], { env: { PINCAST_API: api }, cwd: dir })
    let theirs = ''
    const code = await runCreate(['apptheirs'], { env: { PINCAST_CREATE_API: api }, cwd: dir, out: (t) => { theirs += t }, err: (t) => { theirs += t } })
    assert.equal(mine.code, 0)
    assert.equal(code, 0)
    assert.equal(mine.stdout.replaceAll('appmine', 'apptheirs'), theirs)
    const readme = name => readFileSync(join(dir, name, 'README.md'), 'utf8')
    assert.equal(readme('appmine').replace('`pincast init`', '`npm create pincast`'), readme('apptheirs'))
    assert.equal(calls[1].headers['user-agent'], 'create-pincast')
  })

  it('never printed the key in any of these runs', () => {
    for (const text of printed) assert.ok(!text.includes(SECRET))
  })
})
