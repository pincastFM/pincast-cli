import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { parseEnv } from 'node:util'
import { API_ENV, apiBase, waitText } from '../src/init/api.js'
import { runCreate as run } from '../src/init/index.js'
import { addReadmeSection, LIVE_KEY_LINE, manifest, storedPath } from '../src/init/starter.js'

// create-pincast 0.1.0's own tests (6fb6be7, test/create.test.js), run against the code its 0.2.0 shim
// will call. Changed from that file: the imports above, the command name passed to addReadmeSection,
// and 'the package', which checked create-pincast's own package.json and now checks the shim's entry.
const COMMAND = 'npm create pincast'

const ID = 'test-k3f7x2m4qa'
const KEY = `pck_${ID}_rk_Mock0Secret0Mock0Secret0Mock0Secret0Mock0`
const CODE = `pcc_${'a1B2_c3D-'.repeat(5)}abcdefgh`.slice(0, 47)
const CLAIM = `https://pincast.fm/developers/claim#code=${CODE}`
const GOOD = {
  app: { id: ID, name: 'Test app', mode: 'test', expiresAt: '2026-11-29T15:04:05.123Z' },
  key: KEY,
  keyId: 'key_0123456789ab',
  claim: { code: CODE, url: CLAIM, expiresAt: '2026-11-29T15:04:05.123Z' },
  api: 'https://api.pincast.fm/v1',
}

let dir
let server
let calls

const startApi = async (handler) => {
  calls = []
  server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      handler(req, res)
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${server.address().port}/v1`
}

const json = (status, body, headers = {}) => (req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const create = async (base, args = ['app']) => {
  let stdout = ''
  let stderr = ''
  const code = await run(args, {
    env: { [API_ENV]: base },
    cwd: dir,
    out: (t) => { stdout += t },
    err: (t) => { stderr += t },
  })
  return { code, stdout, stderr, all: stdout + stderr }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'create-pincast-')) })
afterEach(async () => {
  if (server) await new Promise((done) => { server.closeAllConnections(); server.close(done) })
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('a good answer', () => {
  it('copies the starter, writes .env at 600, sets the id, and prints the link but never the key', async () => {
    const base = await startApi(json(200, GOOD))
    const r = await create(base)
    assert.equal(r.code, 0, r.stderr)
    const app = join(dir, 'app')
    for (const file of Object.keys(manifest.files)) assert.ok(existsSync(join(app, file)), file)

    assert.equal(statSync(join(app, '.env')).mode & 0o777, 0o600)
    const env = parseEnv(readFileSync(join(app, '.env'), 'utf8'))
    assert.equal(env.PINCAST_KEY, KEY)
    assert.equal(env.PINCAST_ACTOR, 'test_demo')
    assert.equal(env.PINCAST_CLAIM_URL, CLAIM)
    assert.equal(env.PINCAST_API, base)

    assert.match(readFileSync(join(app, 'shared/app.js'), 'utf8'), new RegExp(`id: '${ID}'`))
    assert.ok(r.stdout.includes(CLAIM))
    assert.ok(!r.all.includes(KEY))
    assert.ok(!r.all.includes('Mock0Secret'))
    assert.ok(!readFileSync(join(app, 'README.md'), 'utf8').includes(CODE))
  })

  it('leaves out the starter README line that says every key is live', async () => {
    assert.ok(readFileSync(storedPath('README.md'), 'utf8').includes('Every Pincast key is live'))
    const base = await startApi(json(200, GOOD))
    await create(base)
    const readme = readFileSync(join(dir, 'app', 'README.md'), 'utf8')
    assert.ok(!/every pincast key is live/i.test(readme))
    assert.ok(readme.includes(`## Go live\n\n${LIVE_KEY_LINE} [Test and live](`))
  })

  it('still writes its README section once the example drops that line', () => {
    const folder = join(dir, 'synced')
    mkdirSync(folder)
    writeFileSync(join(folder, 'README.md'), '# App\n\n## Run it\n\nSteps.\n\n## Go live\n\nA newer line.\n')
    addReadmeSection(folder, { id: ID, base: GOOD.api, endsOn: '2026-11-29', command: COMMAND })
    const readme = readFileSync(join(folder, 'README.md'), 'utf8')
    assert.ok(readme.includes('## Your test app'))
    assert.ok(readme.includes('## Go live\n\nA newer line.\n'))
    assert.ok(!readme.includes(LIVE_KEY_LINE))
  })

  it('makes one POST with no body and no Origin', async () => {
    const base = await startApi(json(200, GOOD))
    await create(base)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, '/v1/test-apps')
    assert.equal(calls[0].body, '')
    assert.equal(calls[0].headers.origin, undefined)
    assert.equal(calls[0].headers['content-type'], undefined)
  })

  it('moves every golden to the new id', async () => {
    const base = await startApi(json(200, GOOD))
    await create(base)
    for (const file of Object.keys(manifest.files).filter(f => f.startsWith('test/goldens/'))) {
      const text = readFileSync(join(dir, 'app', file), 'utf8')
      assert.ok(!text.includes('data-id="lantern-walk:'), file)
      assert.ok(text.includes(`data-id="${ID}:`), file)
    }
  })

  it('writes into an empty folder that already exists, and says so from inside it', async () => {
    const base = await startApi(json(200, GOOD))
    const r = await create(base, ['.'])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(existsSync(join(dir, '.env')))
    assert.ok(!r.stdout.includes('cd '))
  })

  it('quotes a folder name with a space in the cd line', async () => {
    const base = await startApi(json(200, GOOD))
    const r = await create(base, ['my app'])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.stdout.includes("cd 'my app'"))
  })
})

describe('the folder', () => {
  it('refuses a folder with a file in it, before any call', async () => {
    const base = await startApi(json(200, GOOD))
    mkdirSync(join(dir, 'app'))
    writeFileSync(join(dir, 'app', '.hidden'), 'mine')
    const r = await create(base)
    assert.equal(r.code, 1)
    assert.equal(calls.length, 0)
    assert.deepEqual(readdirSync(join(dir, 'app')), ['.hidden'])
    assert.equal(readFileSync(join(dir, 'app', '.hidden'), 'utf8'), 'mine')
  })

  it('refuses a path that is a file', async () => {
    const base = await startApi(json(200, GOOD))
    writeFileSync(join(dir, 'app'), 'mine')
    const r = await create(base)
    assert.equal(r.code, 1)
    assert.equal(calls.length, 0)
    assert.equal(readFileSync(join(dir, 'app'), 'utf8'), 'mine')
  })

  it('refuses an unknown option and a second folder', async () => {
    const base = await startApi(json(200, GOOD))
    assert.equal((await create(base, ['app', '--force'])).code, 2)
    assert.equal((await create(base, ['one', 'two'])).code, 2)
    assert.equal(calls.length, 0)
  })

  it('help makes no call and no folder', async () => {
    const base = await startApi(json(200, GOOD))
    const r = await create(base, ['--help'])
    assert.equal(r.code, 0)
    assert.ok(r.stdout.includes(COMMAND))
    assert.equal(calls.length, 0)
    assert.deepEqual(readdirSync(dir), [])
  })

  it('a refusal takes back every folder this run made, and only those', async () => {
    const base = await startApi(json(429, { data: { code: 'test_apps_limit' } }))
    mkdirSync(join(dir, 'mine'))
    const r = await create(base, ['mine/a/b'])
    assert.equal(r.code, 1)
    assert.deepEqual(readdirSync(join(dir, 'mine')), [])
  })

  it('a copy that fails partway takes back what it wrote, before any call', async () => {
    const base = await startApi(json(200, GOOD))
    // A file where the starter needs a folder stops the copy partway through.
    mkdirSync(join(dir, 'app'))
    const realReaddir = readdirSync(join(dir, 'app'))
    assert.deepEqual(realReaddir, [])
    const blocked = join(dir, 'app', 'shared')
    const race = await run(['app'], {
      env: { [API_ENV]: base },
      cwd: dir,
      out: () => {},
      err: () => {},
      fetchImpl: () => { throw new Error('no call should be made') },
      beforeCopy: () => writeFileSync(blocked, 'mine'),
    })
    assert.equal(race, 1)
    assert.equal(calls.length, 0)
    assert.deepEqual(readdirSync(join(dir, 'app')), ['shared'])
    assert.equal(readFileSync(blocked, 'utf8'), 'mine')
  })
})

describe('after Pincast has made the app', () => {
  it('a key that cannot be saved is reported, and never printed', async () => {
    const base = await startApi((req, res) => {
      rmSync(join(dir, 'app'), { recursive: true, force: true })
      json(200, GOOD)(req, res)
    })
    const r = await create(base)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /couldn't be saved/)
    assert.equal(calls.length, 1)
    assert.ok(!r.all.includes('Mock0Secret'))
  })

  it('an id that cannot be written keeps the key in .env and says what to do', async () => {
    const base = await startApi((req, res) => {
      rmSync(join(dir, 'app', 'shared', 'app.js'))
      json(200, GOOD)(req, res)
    })
    const r = await create(base)
    assert.equal(r.code, 1)
    assert.ok(r.stderr.includes(`Set APP.id in shared/app.js to ${ID}`))
    assert.equal(parseEnv(readFileSync(join(dir, 'app', '.env'), 'utf8')).PINCAST_KEY, KEY)
    assert.ok(!r.all.includes('Mock0Secret'))
  })
})

describe('a refusal leaves nothing behind and calls once', () => {
  const cases = [
    ['429 test_apps_limit', json(429, { statusCode: 429, data: { code: 'test_apps_limit' } }, { 'Retry-After': '7200' }), /all the test apps.*about 2 hours/s],
    ['429 from the firewall', (req, res) => { res.writeHead(429, { 'Retry-After': '600' }); res.end('Too Many Requests') }, /this network.*about 10 minutes/s],
    ['403 browser_not_allowed', json(403, { statusCode: 403, data: { code: 'browser_not_allowed' } }), /web page/],
    ['403 of another kind', json(403, { statusCode: 403 }), /refused the call \(403\)/],
    ['404', json(404, { statusCode: 404 }), /no test app service/],
    ['500', json(500, { statusCode: 500 }), /error \(500\).*ends on its own/s],
    ['307', (req, res) => { res.writeHead(307, { Location: '/v1/elsewhere' }); res.end() }, /didn't follow/],
  ]
  for (const [name, handler, message] of cases) {
    it(name, async () => {
      const base = await startApi(handler)
      const r = await create(base)
      assert.equal(r.code, 1)
      assert.match(r.stderr, message)
      assert.equal(calls.length, 1)
      assert.ok(!existsSync(join(dir, 'app')))
    })
  }

  it('leaves an empty folder it did not make', async () => {
    const base = await startApi(json(429, { data: { code: 'test_apps_limit' } }))
    mkdirSync(join(dir, 'app'))
    await create(base)
    assert.deepEqual(readdirSync(join(dir, 'app')), [])
  })
})

describe('a lost or bad answer', () => {
  it('a dropped connection: says so, calls once, leaves nothing', async () => {
    const base = await startApi((req) => { req.socket.destroy() })
    const r = await create(base)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /never arrived/)
    assert.match(r.stderr, /won't call again/)
    assert.equal(calls.length, 1)
    assert.ok(!existsSync(join(dir, 'app')))
  })

  it('an answer cut off halfway: the key in it is never repeated', async () => {
    const base = await startApi((req, res) => {
      const text = JSON.stringify(GOOD)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(text.length) })
      res.write(text.slice(0, text.indexOf(KEY) + KEY.length))
      setTimeout(() => res.destroy(), 20)
    })
    const r = await create(base)
    assert.equal(r.code, 1)
    assert.equal(calls.length, 1)
    assert.ok(!r.all.includes('Mock0Secret'))
    assert.ok(!existsSync(join(dir, 'app')))
  })

  it('malformed JSON holding the key: the parse error is not repeated', async () => {
    const base = await startApi((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(`{"key":"${KEY}",`)
    })
    const r = await create(base)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /couldn't read/)
    assert.ok(!r.all.includes('Mock0Secret'))
  })

  const bad = {
    'an id that would break out of the source file': { ...GOOD, app: { ...GOOD.app, id: "x',evil:'" } },
    'a key for another app': { ...GOOD, key: 'pck_test-aaaaaaaaaa_rk_Mock0Secret0Mock0Secret0' },
    'a key with a line break': { ...GOOD, key: `${KEY}\nEVIL=1` },
    'a claim link with a terminal escape': { ...GOOD, claim: { ...GOOD.claim, url: `${CLAIM}\u001b[2J` } },
    'a claim link over http': { ...GOOD, claim: { ...GOOD.claim, url: CLAIM.replace('https', 'http') } },
    'no expiry': { ...GOOD, app: { ...GOOD.app, expiresAt: undefined }, claim: { ...GOOD.claim, expiresAt: undefined } },
  }
  for (const [name, body] of Object.entries(bad)) {
    it(`refuses ${name}, writing nothing`, async () => {
      const base = await startApi(json(200, body))
      const r = await create(base)
      assert.equal(r.code, 1)
      assert.equal(calls.length, 1)
      assert.ok(!r.all.includes('Mock0Secret'))
      assert.ok(!existsSync(join(dir, 'app')))
    })
  }

  it('nothing listening: says no app was made', async () => {
    const base = await startApi(json(200, GOOD))
    await new Promise((done) => { server.close(done) })
    server = null
    const r = await create(base)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /no test app was made/)
    assert.ok(!existsSync(join(dir, 'app')))
  })
})

describe('the API base', () => {
  it('defaults to the live API', () => assert.equal(apiBase({}).base, 'https://api.pincast.fm/v1'))
  it('takes a local http address', () => assert.equal(apiBase({ [API_ENV]: 'http://127.0.0.1:9/v1/' }).base, 'http://127.0.0.1:9/v1'))
  for (const value of ['http://example.org/v1', 'nonsense', 'https://a:b@example.org/v1', 'https://example.org/v1?x=1', 'https://example.org/$(id)']) {
    it(`refuses ${value}`, () => assert.throws(() => apiBase({ [API_ENV]: value })))
  }
})

describe('wait text', () => {
  it('reads seconds and dates', () => {
    assert.equal(waitText('30'), 'in a minute or two')
    assert.equal(waitText('600'), 'in about 10 minutes')
    assert.equal(waitText('7200'), 'in about 2 hours')
    assert.equal(waitText(new Date(1000 + 3_600_000 * 3).toUTCString(), 1000), 'in about 3 hours')
    assert.equal(waitText('soon'), 'later')
    assert.equal(waitText(null), 'later')
  })
})

describe('the package', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  it('exports the shim entry, and the README names it', () => {
    assert.equal(pkg.exports['./init'], './src/init/index.js')
    assert.ok(readFileSync(new URL('../README.md', import.meta.url), 'utf8').includes('@pincast/cli/init'))
  })

  it('depends on @pincast/api alone, at an exact version', () => assert.deepEqual(Object.keys(pkg.dependencies), ['@pincast/api']))

  it('records the commit, and its files match their hashes', () => {
    assert.match(manifest.commit, /^192ebea[0-9a-f]{33}$/)
    for (const [file, sha] of Object.entries(manifest.files)) {
      assert.equal(createHash('sha256').update(readFileSync(storedPath(file))).digest('hex'), sha, file)
    }
  })
})
