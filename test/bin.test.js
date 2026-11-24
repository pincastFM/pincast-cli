// The installed command as a process with no terminal: standard input left open and never written, so a
// prompt would hang the test. Every run has to end on its own, with its exit code.
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMock } from '@pincast/api/mock'
import { EXIT } from '../src/exit.js'
import { KEY, SECRET_PART, removeDir, tempDir } from './helpers.js'

const BIN = fileURLToPath(new URL('../bin/pincast.js', import.meta.url))

function run(args, { env = {}, cwd, onStart } = {}) {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    const timer = setTimeout(() => { p.kill('SIGKILL'); fail(new Error(`pincast ${args.join(' ')} did not end on its own`)) }, 15_000)
    p.stdout.on('data', d => out.push(d))
    p.stderr.on('data', d => err.push(d))
    onStart?.(p)
    p.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() })
    })
  })
}

let mock
let dir
before(async () => { mock = await startMock({ key: KEY }); dir = tempDir() })
after(async () => { await mock.close(); removeDir(dir) })

describe('the command with no terminal', () => {
  it('collects and exits 0 without reading standard input', async () => {
    const r = await run(['collect', 'old-town-lanterns', 'lantern:ferry-steps'], { env: { PINCAST_KEY: KEY, PINCAST_API: mock.url }, cwd: dir })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(!(r.stdout + r.stderr).includes(SECRET_PART))
  })

  it('answers --json failures on stdout alone, as one JSON object, with the exit code', async () => {
    const r = await run(['sets', 'get', 'old-town-lanterns', '--json'], { cwd: dir })
    assert.equal(r.code, EXIT.key)
    assert.equal(r.stderr, '')
    assert.equal(JSON.parse(r.stdout).error.code, 'key_missing')
  })

  it('exits 2 for an unknown command, with the help on stderr', async () => {
    const r = await run(['deploy'], { cwd: dir })
    assert.equal(r.code, EXIT.usage)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes('pincast deploy isn\'t a command.'))
  })

  it('exits 130 on Ctrl-C during init, takes the folder back and says so in JSON', async () => {
    let seen
    const posted = new Promise((resolve) => { seen = resolve })
    const api = createServer(() => seen())
    await new Promise(done => api.listen(0, '127.0.0.1', done))
    const r = await run(['init', 'cut', '--json'], {
      env: { PINCAST_API: `http://127.0.0.1:${api.address().port}/v1` },
      cwd: dir,
      onStart: p => posted.then(() => p.kill('SIGINT')),
    })
    api.closeAllConnections()
    await new Promise(done => api.close(done))
    assert.equal(r.code, EXIT.stopped)
    assert.equal(JSON.parse(r.stdout).error.code, 'stopped')
    assert.ok(!existsSync(join(dir, 'cut')))
  })
})
