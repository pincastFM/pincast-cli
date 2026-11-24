// pincast init: create-pincast's flow (test/init-create-pincast.test.js runs that file's own tests on the
// same code), plus what the pincast front adds: --json, --api, its exit codes and its own name.
// Since the first run moved in (create-pincast f1dcb80), a good init makes three calls: POST /test-apps,
// then the starter's set (PUT) and one collect (POST) with the new key. The stand-in below answers those
// two the way the real routes do; every refusal of /test-apps still stops at one call.
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { EXIT } from '../src/exit.js'
import { COLLECT_RETRY_KEY, FIRST_COLLECT, firstRunCommands, manifest, runCreate } from '../src/init/index.js'
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

const SET_URL = '/v1/sets/old-town-lanterns'
const COLLECT_URL = `${SET_URL}/collects`
// The two first-run answers, in the shapes the real PUT and collect routes send (create-pincast's own).
const PUT_ANSWER = { app: ID, set: 'old-town-lanterns', name: 'Old Town', setCreated: true, cards: { created: 8, updated: 0, unchanged: 0, parentsSet: 0 }, active: { lantern: 8 } }
const COLLECT_ANSWER = { collected: true, first: true, count: 1, collectedAt: '2026-11-22T15:04:05.123Z', card: { key: 'lantern:ferry-steps', type: 'lantern' }, parent: null }

let dir
let server
let calls
// status, body and headers answer POST /test-apps. firstRun answers the set and the collect: by default
// as the real routes do, or { put, post } handlers to make either fail.
const startApi = async (status, body, headers = {}, firstRun = {}) => {
  calls = []
  server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      const answer = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)) }
      if (req.method === 'PUT' && req.url === SET_URL) return firstRun.put ? firstRun.put(req, res) : answer(200, PUT_ANSWER)
      if (req.method === 'POST' && req.url === COLLECT_URL) return firstRun.post ? firstRun.post(req, res) : answer(200, COLLECT_ANSWER)
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
      firstRun: { setConfirmed: true, collectConfirmed: true, why: null },
      next: ['cd my-app', 'npm ci', 'npm run dev'],
    })
    const env = parseEnv(readFileSync(join(app, '.env'), 'utf8'))
    assert.equal(env.PINCAST_KEY, KEY)
    assert.equal(env.PINCAST_API, api)
    assert.equal(statSync(join(app, '.env')).mode & 0o777, 0o600)
    assert.match(readFileSync(join(app, '.env'), 'utf8'), /^# Made by pincast init\./)
    assert.ok(readFileSync(join(app, 'README.md'), 'utf8').includes('`pincast init` made this copy'))
    for (const file of Object.keys(manifest.files)) assert.ok(existsSync(join(app, file)), file)
  })

  it('makes exactly one POST to /test-apps, with no body, no Origin and its own User-Agent, then the first run', async () => {
    const api = await startApi(200, GOOD)
    await pincast(['init', '--json'], { env: { PINCAST_API: api }, cwd: dir })
    assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['POST /v1/test-apps', `PUT ${SET_URL}`, `POST ${COLLECT_URL}`])
    assert.equal(calls[0].body, '')
    assert.equal(calls[0].headers.origin, undefined)
    assert.match(calls[0].headers['user-agent'], /^pincast-cli\/\d+\.\d+\.\d+$/)
    assert.equal(calls[0].headers['x-pincast-key'], undefined)
    for (const c of calls.slice(1)) {
      assert.equal(c.headers['x-pincast-key'], KEY)
      assert.equal(c.headers['user-agent'], calls[0].headers['user-agent'])
      assert.equal(c.headers.origin, undefined)
    }
    assert.equal(calls[2].headers['idempotency-key'], COLLECT_RETRY_KEY)
    assert.deepEqual(JSON.parse(calls[2].body), FIRST_COLLECT)
    assert.ok(existsSync(join(dir, 'pincast-app', '.env')))
  })

  it('takes --api over PINCAST_API, and PINCAST_CREATE_API last', async () => {
    const api = await startApi(200, GOOD)
    const r = await pincast(['init', 'a', '--api', api, '--json'], { env: { PINCAST_API: 'https://unused.invalid/v1' }, cwd: dir })
    assert.equal(r.code, 0)
    const r2 = await pincast(['init', 'b', '--json'], { env: { PINCAST_CREATE_API: api }, cwd: dir })
    assert.equal(r2.code, 0)
    assert.equal(calls.filter(c => c.url === '/v1/test-apps').length, 2)
    assert.equal(calls.length, 6)
  })
})

describe('pincast init, the first run', () => {
  it('a set that fails keeps the app, exits 0 and lists both commands, in one JSON object', async () => {
    const api = await startApi(200, GOOD, {}, { put: (req, res) => { res.writeHead(500); res.end(`{"key":"${KEY}"}`) } })
    const r = await pincast(['init', 'my-app', '--json'], { env: { PINCAST_API: api }, cwd: dir })
    assert.equal(r.code, 0)
    assert.equal(r.stderr, '')
    assert.deepEqual(r.json.firstRun, { setConfirmed: false, collectConfirmed: false, why: 'it answered 500' })
    assert.deepEqual(r.json.next, ['cd my-app', 'npm ci', ...firstRunCommands(api, 'both'), 'npm run dev'])
    assert.equal(calls.filter(c => c.url === COLLECT_URL).length, 0)
    assert.equal(parseEnv(readFileSync(join(dir, 'my-app', '.env'), 'utf8')).PINCAST_KEY, KEY)
    assert.ok(!r.stdout.includes(SECRET))
  })

  it('a collect that fails lists only the collect, with its retry key', async () => {
    const api = await startApi(200, GOOD, {}, { post: (req) => { req.socket.destroy() } })
    const r = await pincast(['init', 'my-app', '--json'], { env: { PINCAST_API: api }, cwd: dir })
    assert.equal(r.code, 0)
    assert.deepEqual(r.json.firstRun, { setConfirmed: true, collectConfirmed: false, why: 'the connection failed' })
    assert.ok(r.json.next.some(l => l.includes(`Idempotency-Key: ${COLLECT_RETRY_KEY}`)))
    assert.ok(!r.json.next.some(l => l.includes('curl -X PUT')))
  })

  it('says it is sending in text, and never under --json', async () => {
    const api = await startApi(200, GOOD)
    const text = await pincast(['init', 'a'], { env: { PINCAST_API: api }, cwd: dir })
    assert.ok(text.stdout.startsWith('Sending the starter\'s set and one test collect to Pincast.\n\n'))
    const json = await pincast(['init', 'b', '--json'], { env: { PINCAST_API: api }, cwd: dir })
    assert.ok(json.stdout.startsWith('{'))
  })

  it('Ctrl-C during the first run keeps the app and exits 130, as JSON with the app in result', async () => {
    const api = await startApi(200, GOOD, {}, { put: () => { setImmediate(() => process.emit('SIGINT')) } })
    const r = await pincast(['init', 'my-app', '--json'], { env: { PINCAST_API: api }, cwd: dir })
    assert.equal(r.code, EXIT.stopped)
    assert.equal(r.stderr, '')
    assert.equal(r.json.ok, false)
    assert.equal(r.json.error.code, 'stopped')
    assert.equal(r.json.result.app.id, ID)
    assert.deepEqual(r.json.result.firstRun, { setConfirmed: false, collectConfirmed: false, why: 'stopped' })
    assert.equal(process.listenerCount('SIGINT'), 0)
    assert.equal(parseEnv(readFileSync(join(dir, 'my-app', '.env'), 'utf8')).PINCAST_KEY, KEY)
    assert.ok(!r.stdout.includes(SECRET))
  })

  it('Ctrl-C during the first run, in text: the steps and the link on stdout, exit 130', async () => {
    const api = await startApi(200, GOOD, {}, { put: () => { setImmediate(() => process.emit('SIGINT')) } })
    const r = await pincast(['init', 'my-app'], { env: { PINCAST_API: api }, cwd: dir })
    assert.equal(r.code, EXIT.stopped)
    assert.equal(r.stderr, '')
    assert.ok(r.stdout.includes(CLAIM))
    for (const line of firstRunCommands(api, 'both')) assert.ok(r.stdout.includes(`  ${line}\n`), line)
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
    const theirCalls = calls.slice(3)
    assert.deepEqual(theirCalls.map(c => `${c.method} ${c.url}`), ['POST /v1/test-apps', `PUT ${SET_URL}`, `POST ${COLLECT_URL}`])
    for (const c of theirCalls) assert.equal(c.headers['user-agent'], 'create-pincast')
  })

  it('never printed the key in any of these runs', () => {
    for (const text of printed) assert.ok(!text.includes(SECRET))
  })
})
