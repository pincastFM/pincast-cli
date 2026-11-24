// Shared by the tests. Every key here is made up for the mock; none is a real key.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.js'

export const SECRET_PART = 'K'.repeat(43)
export const KEY = `pck_test-abcdefghij_rk_${SECRET_PART}`
export const LIVE_SECRET_PART = 'L'.repeat(40)
export const LIVE_KEY = `pck_parkcards_sk_${LIVE_SECRET_PART}`
export const WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'

// Everything any test saw printed, so one last check can look for a key in all of it.
export const printed = []

export function tempDir(prefix = 'pincast-cli-') {
  return mkdtempSync(join(tmpdir(), prefix))
}
export const removeDir = dir => rmSync(dir, { recursive: true, force: true })

/** Runs the command in this process and answers { code, stdout, stderr, json }. */
export async function pincast(args, { env = {}, cwd, fetchImpl, beforeCopy } = {}) {
  let stdout = ''
  let stderr = ''
  const code = await main(args, {
    env,
    cwd,
    out: (t) => { stdout += t },
    err: (t) => { stderr += t },
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(beforeCopy ? { beforeCopy } : {}),
  })
  printed.push(stdout, stderr)
  let json
  if (args.includes('--json')) json = JSON.parse(stdout)
  return { code, stdout, stderr, json, all: stdout + stderr }
}

/** A fetch that records calls and never sends anything. */
export function noFetch() {
  const calls = []
  const f = async (...a) => { calls.push(a); throw new Error('no call expected') }
  f.calls = calls
  return f
}
