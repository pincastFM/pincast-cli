// sets put, sets get, collect and collects against @pincast/api's mock, which is built from the API
// file alone. Each test checks the exit code, what was sent, and that no key was printed.
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { startMock } from '@pincast/api/mock'
import { EXIT } from '../src/exit.js'
import { KEY, LIVE_KEY, LIVE_SECRET_PART, SECRET_PART, noFetch, pincast, printed, removeDir, tempDir } from './helpers.js'

const SET = 'old-town-lanterns'
const SET_FILE = {
  name: 'Old Town',
  meta: { listed: false },
  cards: [
    { key: 'lantern:ferry-steps', type: 'lantern', title: 'Ferry Steps' },
    { key: 'lantern:chandlers-corner', type: 'lantern', title: "Chandler's Corner" },
  ],
}

let mock
let live
let dir
let env
before(async () => {
  mock = await startMock({ key: KEY })
  live = await startMock({ key: LIVE_KEY })
})
after(async () => { await mock.close(); await live.close() })
beforeEach(() => {
  mock.reset()
  live.reset()
  if (dir) removeDir(dir)
  dir = tempDir()
  env = { PINCAST_KEY: KEY, PINCAST_API: mock.url }
  writeFileSync(join(dir, 'set.json'), JSON.stringify(SET_FILE))
})
after(() => removeDir(dir))

const noKey = r => assert.ok(!r.all.includes(SECRET_PART) && !r.all.includes(LIVE_SECRET_PART), 'a key was printed')

describe('sets put', () => {
  it('sends the file to PUT /sets/{set} with the key and an Idempotency-Key, and says what happened', async () => {
    const r = await pincast(['sets', 'put', 'set.json', '--set', SET], { env, cwd: dir })
    assert.equal(r.code, EXIT.ok, r.stderr)
    const [req] = mock.requests
    assert.equal(req.operationId, 'putSet')
    assert.equal(req.path, `/sets/${SET}`)
    assert.equal(req.headers['x-pincast-key'], KEY)
    assert.ok(req.headers['idempotency-key'])
    assert.deepEqual(req.body, SET_FILE)
    assert.match(r.stdout, /^Set .+ (is registered|is updated): .+, 2 cards sent\./)
    noKey(r)
  })

  it('takes the set from the file\'s "id", sends the rest, and answers in JSON', async () => {
    writeFileSync(join(dir, 'with-id.json'), JSON.stringify({ id: SET, ...SET_FILE }))
    const r = await pincast(['sets', 'put', 'with-id.json', '--json'], { env, cwd: dir })
    assert.equal(r.code, 0)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.command, 'sets put')
    assert.equal(typeof r.json.answer.setCreated, 'boolean')
    assert.equal(mock.requests[0].path, `/sets/${SET}`)
    assert.equal(mock.requests[0].body.id, undefined)
    assert.equal(r.stderr, '')
  })

  it('refuses a missing file, a file that is not JSON, and a file with no set named, before any call', async () => {
    writeFileSync(join(dir, 'bad.json'), `{"name": "${KEY}",`)
    const missing = await pincast(['sets', 'put', 'nope.json', '--set', SET, '--json'], { env, cwd: dir })
    const garbled = await pincast(['sets', 'put', 'bad.json', '--set', SET, '--json'], { env, cwd: dir })
    const unnamed = await pincast(['sets', 'put', 'set.json', '--json'], { env, cwd: dir })
    assert.deepEqual([missing.code, garbled.code, unnamed.code], [EXIT.local, EXIT.local, EXIT.usage])
    assert.deepEqual([missing.json.error.code, garbled.json.error.code, unnamed.json.error.code], ['file_unreadable', 'file_not_json', 'usage'])
    assert.equal(mock.requests.length, 0)
    noKey(garbled)
  })

  it('passes on a body the API refuses, with its code, field and fix', async () => {
    writeFileSync(join(dir, 'nameless.json'), JSON.stringify({ cards: [] }))
    const r = await pincast(['sets', 'put', 'nameless.json', '--set', SET, '--json'], { env, cwd: dir })
    assert.equal(r.code, EXIT.refused)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.error.code, 'field_required')
    assert.equal(r.json.error.status, 400)
    assert.equal(r.json.error.exitCode, EXIT.refused)
    assert.ok(r.json.error.fix)
  })
})

describe('sets get', () => {
  it('reads GET /sets/{set} and prints a summary', async () => {
    const r = await pincast(['sets', 'get', SET], { env, cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(mock.requests[0].operationId, 'getSet')
    assert.match(r.stdout, /^Set .+: .+, updated .+\.\nActive cards: .+\.\nCollects: \d+, by \d+ players?\.\n$/)
    noKey(r)
  })

  it('answers the whole set in JSON', async () => {
    const r = await pincast(['sets', 'get', SET, '--json'], { env, cwd: dir })
    assert.equal(r.json.ok, true)
    for (const field of ['app', 'set', 'name', 'meta', 'updatedAt', 'active', 'collects', 'players', 'listing']) assert.ok(field in r.json.answer, field)
  })

  it('exits 5 for a set that is not registered, and 4 for a set id the API refuses', async () => {
    mock.answerNext({ status: 404, code: 'set_not_registered', fix: 'PUT the set first.' })
    const missing = await pincast(['sets', 'get', SET, '--json'], { env, cwd: dir })
    const bad = await pincast(['sets', 'get', 'Not A Set', '--json'], { env, cwd: dir })
    assert.equal(missing.code, EXIT.not_found)
    assert.equal(missing.json.error.code, 'set_not_registered')
    assert.equal(bad.code, EXIT.refused)
    assert.equal(bad.json.error.code, 'set_id_invalid')
  })
})

describe('collect', () => {
  it('collects for test_demo by default, as a guest, with an Idempotency-Key', async () => {
    const r = await pincast(['collect', SET, 'lantern:ferry-steps'], { env, cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    const [req] = mock.requests
    assert.equal(req.operationId, 'postCollect')
    assert.deepEqual(req.body, { card: 'lantern:ferry-steps', actor: { id: 'test_demo', source: 'anonymous' } })
    assert.ok(req.headers['idempotency-key'])
    assert.match(r.stdout, /^Collected .+ for test_demo: /)
  })

  it('uses PINCAST_ACTOR from .env when it is a test person, and --person over it', async () => {
    writeFileSync(join(dir, '.env'), `PINCAST_KEY=${KEY}\nPINCAST_API=${mock.url}\nPINCAST_ACTOR=test_from_env\n`)
    const fromEnv = await pincast(['collect', SET, 'lantern:ferry-steps', '--json'], { env: {}, cwd: dir })
    const named = await pincast(['collect', SET, 'lantern:ferry-steps', '--person', 'test_ana', '--json'], { env: {}, cwd: dir })
    assert.equal(fromEnv.code, 0)
    assert.equal(fromEnv.json.person, 'test_from_env')
    assert.equal(named.json.person, 'test_ana')
    assert.equal(named.json.live, false)
    assert.equal(mock.requests[1].body.actor.id, 'test_ana')
  })

  it('refuses a person who is not a test person under a test key, before any call', async () => {
    const r = await pincast(['collect', SET, 'lantern:ferry-steps', '--person', 'guest-7f3c', '--json'], { env, cwd: dir })
    assert.equal(r.code, EXIT.refused)
    assert.equal(r.json.error.code, 'test_person_required')
    assert.equal(mock.requests.length, 0)
  })

  it('refuses a live key unless --live is passed, and then needs --person', async () => {
    const liveEnv = { PINCAST_KEY: LIVE_KEY, PINCAST_API: live.url }
    const refused = await pincast(['collect', SET, 'lantern:ferry-steps', '--json'], { env: liveEnv, cwd: dir })
    const noPerson = await pincast(['collect', SET, 'lantern:ferry-steps', '--live', '--json'], { env: liveEnv, cwd: dir })
    assert.equal(refused.code, EXIT.live)
    assert.equal(refused.json.error.code, 'live_needs_flag')
    assert.equal(noPerson.code, EXIT.usage)
    assert.equal(live.requests.length, 0)
    const sent = await pincast(['collect', SET, 'lantern:ferry-steps', '--live', '--person', 'guest-7f3c', '--json'], { env: liveEnv, cwd: dir })
    assert.equal(sent.code, 0)
    assert.equal(sent.json.live, true)
    assert.equal(live.requests[0].body.actor.id, 'guest-7f3c')
    noKey(refused); noKey(sent)
  })

  it('reports a 429 at once with its Retry-After, and never waits or sends again on its own', async () => {
    mock.answerNext({ status: 429, code: 'rate_limited', fix: 'Wait, then send it again.', headers: { 'Retry-After': '30' } })
    const r = await pincast(['collect', SET, 'lantern:ferry-steps', '--json'], { env, cwd: dir })
    assert.equal(r.code, EXIT.wait)
    assert.equal(r.json.error.retryAfter, 30)
    assert.equal(mock.requests.length, 1)
  })

  it('exits 11 for person_not_signed_in and 3 for a refused key', async () => {
    mock.answerNext({ status: 403, code: 'person_not_signed_in', fix: 'Send the sign-in token with POST /people first.' })
    const waiting = await pincast(['collect', SET, 'lantern:ferry-steps', '--json'], { env, cwd: dir })
    const wrongKey = await pincast(['collect', SET, 'lantern:ferry-steps', '--json'], { env: { ...env, PINCAST_KEY: KEY.replace('KKKK', 'KKKJ') }, cwd: dir })
    assert.equal(waiting.code, EXIT.waiting)
    assert.equal(wrongKey.code, EXIT.key)
    assert.equal(wrongKey.json.error.code, 'key_invalid')
    noKey(wrongKey)
  })

  it('takes --source logto and refuses any other source', async () => {
    const ok = await pincast(['collect', SET, 'lantern:ferry-steps', '--source', 'logto'], { env, cwd: dir })
    const bad = await pincast(['collect', SET, 'lantern:ferry-steps', '--source', 'email'], { env, cwd: dir })
    assert.equal(ok.code, 0)
    assert.equal(mock.requests[0].body.actor.source, 'logto')
    assert.equal(bad.code, EXIT.usage)
  })
})

describe('collects', () => {
  it('reads GET /sets/{set}/collects for test_demo by default and lists the cards', async () => {
    const r = await pincast(['collects', SET], { env, cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    const [req] = mock.requests
    assert.equal(req.operationId, 'getCollects')
    assert.deepEqual(req.query.getAll('actor'), ['test_demo'])
    assert.match(r.stdout, /^test_demo holds \d+ cards? in .+\.\n/)
  })

  it('answers in JSON for --person, and needs --person under a live key', async () => {
    const r = await pincast(['collects', SET, '--person', 'test_ana', '--json'], { env, cwd: dir })
    assert.equal(r.json.person, 'test_ana')
    assert.ok(Array.isArray(r.json.answer.cards))
    const liveNoPerson = await pincast(['collects', SET, '--json'], { env: { PINCAST_KEY: LIVE_KEY, PINCAST_API: live.url }, cwd: dir })
    assert.equal(liveNoPerson.code, EXIT.usage)
    assert.equal(live.requests.length, 0)
  })
})

describe('keys and addresses', () => {
  it('exits 3 with no key, and makes no call', async () => {
    const f = noFetch()
    const r = await pincast(['sets', 'get', SET, '--json'], { env: { PINCAST_API: mock.url }, cwd: dir, fetchImpl: f })
    assert.equal(r.code, EXIT.key)
    assert.equal(r.json.error.code, 'key_missing')
    assert.equal(f.calls.length, 0)
  })

  it('reads the key from --env-file, and exits 8 when that file is missing', async () => {
    mkdirSync(join(dir, 'conf'))
    writeFileSync(join(dir, 'conf', 'test.env'), `PINCAST_KEY=${KEY}\nPINCAST_API=${mock.url}\n`)
    const r = await pincast(['sets', 'get', SET, '--env-file', 'conf/test.env'], { env: {}, cwd: dir })
    const missing = await pincast(['sets', 'get', SET, '--env-file', 'conf/none.env', '--json'], { env: {}, cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(missing.code, EXIT.local)
    assert.equal(missing.json.error.code, 'env_file_unreadable')
  })

  it('sends a key only over https, or http on this machine', async () => {
    const f = noFetch()
    const r = await pincast(['sets', 'get', SET, '--api', 'http://example.org/v1', '--json'], { env, cwd: dir, fetchImpl: f })
    assert.equal(r.code, EXIT.usage)
    assert.equal(r.json.error.code, 'api_invalid')
    assert.equal(f.calls.length, 0)
  })

  it('exits 7 when nothing answers, and 7 for a server error', async () => {
    const server = createServer()
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    const port = server.address().port
    await new Promise(done => server.close(done))
    const gone = await pincast(['sets', 'get', SET, '--json'], { env: { ...env, PINCAST_API: `http://127.0.0.1:${port}/v1` }, cwd: dir })
    mock.answerNext({ status: 500, body: { url: `/sets/${SET}`, statusCode: 500, statusMessage: 'Server Error', message: 'Server Error' } })
    const broken = await pincast(['sets', 'get', SET, '--json'], { env, cwd: dir })
    assert.equal(gone.code, EXIT.later)
    assert.equal(gone.json.error.code, 'unreachable')
    assert.equal(broken.code, EXIT.later)
  })

  it('hides a key even when an answer repeats it', async () => {
    mock.answerNext({ status: 400, code: 'field_invalid', fix: `Your key ${KEY} is fine; send a name.`, field: 'name' })
    const r = await pincast(['sets', 'put', 'set.json', '--set', SET], { env, cwd: dir })
    assert.equal(r.code, EXIT.refused)
    assert.ok(r.stderr.includes('[key hidden]'))
    noKey(r)
  })
})

describe('arguments', () => {
  it('exits 2 for an unknown command, an unknown option, an option the command does not take, or a missing argument', async () => {
    const runs = await Promise.all([
      ['frobnicate'], ['sets'], ['sets', 'delete', SET], ['sets', 'get', SET, '--force'],
      ['sets', 'get', SET, '--live'], ['sets', 'get'], ['collect', SET], ['collects'], [],
    ].map(args => pincast([...args, '--json'], { env, cwd: dir })))
    for (const r of runs) {
      assert.equal(r.code, EXIT.usage, r.stdout)
      assert.equal(r.json.ok, false)
      assert.equal(r.json.error.kind, 'usage')
    }
    assert.equal(mock.requests.length, 0)
  })

  it('prints the version and the help, in text or JSON', async () => {
    const v = await pincast(['--version'], { env, cwd: dir })
    const vj = await pincast(['--version', '--json'], { env, cwd: dir })
    const h = await pincast(['--help'], { env, cwd: dir })
    assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/)
    assert.equal(vj.json.version, v.stdout.trim())
    assert.ok(h.stdout.includes('pincast webhooks sign'))
    assert.equal(h.code, 0)
  })

  it('writes nothing to stderr in JSON mode, success or failure', async () => {
    const good = await pincast(['sets', 'get', SET, '--json'], { env, cwd: dir })
    const bad = await pincast(['sets', 'get', SET, '--json'], { env: {}, cwd: dir })
    assert.equal(good.stderr + bad.stderr, '')
  })
})

describe('no key in any output', () => {
  it('holds for everything the tests above printed', () => {
    assert.ok(printed.length > 40)
    for (const text of printed) {
      assert.ok(!text.includes(SECRET_PART) && !text.includes(LIVE_SECRET_PART) && !/pck_[a-z0-9-]+_[rs]k_[A-Za-z0-9_-]{20,}/.test(text), text.slice(0, 200))
    }
  })
})
