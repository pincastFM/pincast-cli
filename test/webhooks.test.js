// webhooks sign: the signature against the Standard Webhooks reference values, a local receiver that
// checks it the spec's way with its own code, the failures, and that no secret is ever printed.
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { EXIT } from '../src/exit.js'
import { EVENT_TYPES, sign } from '../src/webhooks.js'
import { KEY, WEBHOOK_SECRET, noFetch, pincast, printed, removeDir, tempDir } from './helpers.js'

// The reference values in Standard Webhooks' own docs and libraries: this secret, id, timestamp and
// body sign to this signature.
const REF = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: 1614265330, body: '{"test": 2432232314}', signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' }
const SECRET_BODY = WEBHOOK_SECRET.slice('whsec_'.length)
const OTHER = `whsec_${Buffer.from('another endpoint secret, 32 b..').toString('base64')}`

// A receiver written from the spec, not from src/webhooks.js.
function verifies(secret, headers, body) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const want = createHmac('sha256', key).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest()
  return String(headers['webhook-signature']).split(' ').some((sig) => {
    const [version, mac] = sig.split(',')
    const got = Buffer.from(mac || '', 'base64')
    return version === 'v1' && got.length === want.length && timingSafeEqual(got, want)
  })
}

let receiver
let url
let got
let reply
let dir
before(async () => {
  receiver = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(reply.status, reply.headers || { 'Content-Type': 'text/plain' })
      res.end(reply.body ?? 'ok')
    })
  })
  await new Promise(done => receiver.listen(0, '127.0.0.1', done))
  url = `http://127.0.0.1:${receiver.address().port}/webhooks`
})
after(async () => { receiver.closeAllConnections(); await new Promise(done => receiver.close(done)); removeDir(dir) })
beforeEach(() => {
  got = []
  reply = { status: 204, body: '' }
  if (dir) removeDir(dir)
  dir = tempDir()
})

const noSecret = r => assert.ok(!r.all.includes(SECRET_BODY) && !r.all.includes(OTHER.slice(6)) && !r.all.includes('whsec_M'), 'a secret was printed')

describe('the signature', () => {
  it('matches the Standard Webhooks reference values', () => {
    assert.equal(sign(WEBHOOK_SECRET, REF.id, REF.timestamp, REF.body), REF.signature)
  })

  it('signs the exact bytes of --event, with --id and --timestamp, to the reference value', async () => {
    writeFileSync(join(dir, 'event.json'), REF.body)
    const r = await pincast(['webhooks', 'sign', '--event', 'event.json', '--id', REF.id, '--timestamp', String(REF.timestamp), '--print', '--json'], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }, cwd: dir })
    assert.equal(r.code, 0, r.stdout)
    assert.equal(r.json.headers['webhook-signature'], REF.signature)
    assert.equal(r.json.body, REF.body)
    noSecret(r)
  })
})

describe('posting to a receiver', () => {
  it('posts a signed collect.created by default, which a receiver written from the spec accepts', async () => {
    const r = await pincast(['webhooks', 'sign', '--to', url], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET, PINCAST_KEY: KEY }, cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(got.length, 1)
    const [req] = got
    assert.equal(req.method, 'POST')
    assert.equal(req.headers['content-type'], 'application/json')
    assert.equal(req.headers['user-agent'], 'Pincast-Webhooks/1')
    assert.match(req.headers['webhook-id'], /^msg_[a-z2-7]{26}$/)
    assert.ok(Math.abs(Number(req.headers['webhook-timestamp']) - Date.now() / 1000) < 60)
    assert.ok(verifies(WEBHOOK_SECRET, req.headers, req.body))
    const event = JSON.parse(req.body)
    assert.equal(event.type, 'collect.created')
    assert.ok(Number.isFinite(Date.parse(event.timestamp)))
    assert.equal(event.data.app, 'test-abcdefghij')
    assert.equal(event.data.mode, 'test')
    assert.ok(!('lat' in event.data) && !('lng' in event.data), 'no place in a webhook')
    assert.match(r.stdout, /^Sent collect\.created \(msg_[a-z2-7]{26}\) to .+ Your receiver answered 204\.\n$/)
    noSecret(r)
  })

  it('sends each event type, and refuses one it does not know', async () => {
    for (const type of EVENT_TYPES) {
      const r = await pincast(['webhooks', 'sign', '--to', url, '--type', type, '--json'], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }, cwd: dir })
      assert.equal(r.code, 0, type)
      assert.equal(r.json.type, type)
    }
    assert.deepEqual(got.map(g => JSON.parse(g.body).type), EVENT_TYPES)
    assert.ok(got.every(g => verifies(WEBHOOK_SECRET, g.headers, g.body)))
    const bad = await pincast(['webhooks', 'sign', '--to', url, '--type', 'card.burned', '--json'], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }, cwd: dir })
    assert.equal(bad.code, EXIT.usage)
  })

  it('puts both signatures in the one header during a change of secret', async () => {
    const r = await pincast(['webhooks', 'sign', '--to', url, '--json'], { env: { PINCAST_WEBHOOK_SECRET: `${WEBHOOK_SECRET} ${OTHER}` }, cwd: dir })
    assert.equal(r.code, 0)
    assert.equal(r.json.signatures, 2)
    const sigs = got[0].headers['webhook-signature'].split(' ')
    assert.equal(sigs.length, 2)
    assert.ok(verifies(WEBHOOK_SECRET, got[0].headers, got[0].body))
    assert.ok(verifies(OTHER, got[0].headers, got[0].body))
    noSecret(r)
  })

  it('reads the secret from .env', async () => {
    writeFileSync(join(dir, '.env'), `PINCAST_WEBHOOK_SECRET=${WEBHOOK_SECRET}\n`)
    const r = await pincast(['webhooks', 'sign', '--to', url], { env: {}, cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(verifies(WEBHOOK_SECRET, got[0].headers, got[0].body))
  })
})

describe('failures', () => {
  it('exits 10 when the receiver answers other than 2xx, with its status in JSON', async () => {
    reply = { status: 400, body: 'bad signature' }
    const r = await pincast(['webhooks', 'sign', '--to', url, '--json'], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }, cwd: dir })
    assert.equal(r.code, EXIT.receiver)
    assert.equal(r.json.error.code, 'receiver_refused')
    assert.equal(r.json.error.status, 400)
    assert.equal(r.json.result.reply, 'bad signature')
  })

  it('never follows a redirect, and counts it as a failure', async () => {
    reply = { status: 307, headers: { Location: 'http://127.0.0.1:9/elsewhere' }, body: '' }
    const r = await pincast(['webhooks', 'sign', '--to', url, '--json'], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }, cwd: dir })
    assert.equal(r.code, EXIT.receiver)
    assert.equal(got.length, 1)
  })

  it('exits 7 when nothing answers', async () => {
    const r = await pincast(['webhooks', 'sign', '--to', 'http://127.0.0.1:9/webhooks', '--json'], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }, cwd: dir })
    assert.equal(r.code, EXIT.later)
    assert.equal(r.json.error.code, 'receiver_unreachable')
  })

  it('posts only to this machine', async () => {
    const f = noFetch()
    for (const to of ['https://example.org/webhooks', 'http://10.0.0.5/hook', 'http://localhost.example.org/x', 'ftp://localhost/x']) {
      const r = await pincast(['webhooks', 'sign', '--to', to, '--json'], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }, cwd: dir, fetchImpl: f })
      assert.equal(r.code, EXIT.usage, to)
    }
    assert.equal(f.calls.length, 0)
    for (const to of ['http://localhost:9/x', 'http://[::1]:9/x', 'http://app.localhost:9/x']) {
      const r = await pincast(['webhooks', 'sign', '--to', to, '--json'], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }, cwd: dir, fetchImpl: f })
      assert.equal(r.json.error.code, 'receiver_unreachable', to)
    }
    assert.equal(f.calls.length, 3)
  })

  it('exits 3 with no secret or one that is not whsec_, and 2 without --to or --print', async () => {
    const none = await pincast(['webhooks', 'sign', '--to', url, '--json'], { env: {}, cwd: dir })
    const bad = await pincast(['webhooks', 'sign', '--to', url, '--json'], { env: { PINCAST_WEBHOOK_SECRET: 'sk_notawebhooksecret' }, cwd: dir })
    const three = await pincast(['webhooks', 'sign', '--to', url, '--json'], { env: { PINCAST_WEBHOOK_SECRET: `${WEBHOOK_SECRET} ${OTHER} ${OTHER}` }, cwd: dir })
    const nowhere = await pincast(['webhooks', 'sign', '--json'], { env: { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }, cwd: dir })
    assert.deepEqual([none.code, bad.code, three.code, nowhere.code], [EXIT.key, EXIT.key, EXIT.key, EXIT.usage])
    assert.deepEqual([none.json.error.code, bad.json.error.code], ['secret_missing', 'secret_invalid'])
    assert.equal(got.length, 0)
    noSecret(three)
  })

  it('refuses a bad --id or --timestamp, and --type with --event', async () => {
    writeFileSync(join(dir, 'event.json'), '{"type":"webhook.test","timestamp":"2026-11-24T00:00:00Z","data":{}}')
    const env = { PINCAST_WEBHOOK_SECRET: WEBHOOK_SECRET }
    const runs = await Promise.all([
      ['--id', 'has space'], ['--id', 'a.b'], ['--timestamp', '1.5'], ['--timestamp', 'soon'],
      ['--type', 'webhook.test', '--event', 'event.json'],
    ].map(args => pincast(['webhooks', 'sign', '--print', ...args, '--json'], { env, cwd: dir })))
    for (const r of runs) assert.equal(r.code, EXIT.usage, r.stdout)
  })
})

describe('no secret in any output', () => {
  it('holds for everything printed so far', () => {
    for (const text of printed) assert.ok(!text.includes(SECRET_BODY) && !text.includes(OTHER.slice(6)), text.slice(0, 200))
  })
})
