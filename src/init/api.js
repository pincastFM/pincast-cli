// The call that makes the app: POST /test-apps. Moved here from create-pincast 0.1.0 (6fb6be7, then
// 2b75d2f's firewall wait), which becomes a shim over this file. Each Stop now names a code, so `pincast init --json` can report it and
// pick an exit code, while the shim keeps the exit codes create-pincast always had.
export const DEFAULT_API = 'https://api.pincast.fm/v1'
export const API_ENV = 'PINCAST_CREATE_API'
const TIMEOUT_MS = 30_000

// What a good answer holds. These values land in a source file, in .env and on the terminal, so each
// one has to match exactly before it's used.
const APP_ID_RE = /^test-[a-z2-7]{10}$/
const CLAIM_URL_RE = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/[A-Za-z0-9/_-]*#code=pcc_[A-Za-z0-9_-]{43}$/
const SAFE_BASE_RE = /^[A-Za-z0-9:/._[\]-]+$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// Failures that happen before the request leaves this machine, so no app can exist.
const NEVER_SENT = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

const ORPHAN = "If Pincast made a test app, nobody holds its key, so it can't be used and it ends on its own. Each call makes a new app, so this command won't call again by itself. Run it again when you're ready."

/**
 * A failure with a message written for the person at the terminal. code names it for machines;
 * exitCode is the one create-pincast has always used for it.
 */
export class Stop extends Error {
  constructor(message, exitCode = 1, code = 'failed', extra = {}) {
    super(message)
    this.exitCode = exitCode
    this.code = code
    Object.assign(this, extra)
  }
}

/** The API base: the default, or the first override set among names, which tests use. */
export function apiBase(env, names = [API_ENV]) {
  const name = names.find(n => env[n])
  const raw = name ? env[name] : null
  if (!raw) return { base: DEFAULT_API, custom: false }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Stop(`${name} isn't a web address.`, 1, 'api_invalid')
  }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))
  if (!allowed) throw new Stop(`${name} has to use https, or http on this machine.`, 1, 'api_invalid')
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  if (url.username || url.password || url.search || url.hash || !SAFE_BASE_RE.test(base)) {
    throw new Stop(`${name} has to be a plain address, such as https://example.org/v1.`, 1, 'api_invalid')
  }
  return { base, custom: true }
}

/** Turns a Retry-After header into words. */
export function waitText(header, now = Date.now()) {
  if (!header) return 'later'
  const value = header.trim()
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000
  if (!Number.isFinite(seconds) || seconds < 0) return 'later'
  if (seconds < 90) return 'in a minute or two'
  if (seconds < 5400) return `in about ${Math.ceil(seconds / 60)} minutes`
  return `in about ${Math.ceil(seconds / 3600)} hours`
}

const failureCode = (e) => e?.cause?.code ?? e?.code ?? e?.cause?.errors?.[0]?.code

function errorCode(text) {
  try {
    const code = JSON.parse(text)?.data?.code
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}

function seconds(header) {
  if (!header) return null
  const n = Number(header.trim())
  return Number.isFinite(n) && n >= 0 ? n : null
}

function refusal(status, text, retryAfter, base) {
  const code = errorCode(text)
  const said = { status, retryAfter: seconds(retryAfter) }
  if (status === 429) {
    const wait = waitText(retryAfter)
    return code === 'test_apps_limit'
      ? new Stop(`Pincast has made all the test apps it makes in a day. Try again ${wait}.`, 1, 'test_apps_limit', said)
      // The firewall's 429 carries no Retry-After, and its window is 10 minutes.
      : new Stop(`Too many test apps have come from this network. Try again ${wait === 'later' ? 'in 10 minutes' : wait}.`, 1, code || 'rate_limited', said)
  }
  if (status === 403 && code === 'browser_not_allowed') {
    return new Stop('Pincast refused this call as one from a web page. This command sends no Origin header, so a proxy or network tool probably added it. Try again from a plain terminal.', 1, 'browser_not_allowed', said)
  }
  if (status === 404) return new Stop(`Pincast has no test app service at ${base}, so no test app was made.`, 1, 'no_test_app_service', said)
  if (status >= 300 && status < 400) {
    return new Stop(`Pincast pointed this call at another address. This command didn't follow it, because a second call could make a second app. No key was saved. ${ORPHAN}`, 1, 'redirected', said)
  }
  if (status >= 400 && status < 500) return new Stop(`Pincast refused the call (${status}), so no test app was made.`, 1, code || 'refused', said)
  return new Stop(`Pincast answered with an error (${status}), and no key was saved. ${ORPHAN}`, 1, 'server_error', said)
}

/** Checks a 200's body. Never repeats any of it: a parse error's message can quote the key. */
function readAnswer(text) {
  const unreadable = () => new Stop(`Pincast answered, but this command couldn't read the answer, so no key was saved. ${ORPHAN}`, 1, 'answer_unreadable', { status: 200 })
  let answer
  try {
    answer = JSON.parse(text)
  } catch {
    throw unreadable()
  }
  const id = answer?.app?.id
  const key = answer?.key
  const claimUrl = answer?.claim?.url
  const expiresAt = answer?.claim?.expiresAt ?? answer?.app?.expiresAt
  if (typeof id !== 'string' || !APP_ID_RE.test(id)) throw unreadable()
  if (typeof key !== 'string' || !key.startsWith(`pck_${id}_`) || !/^[A-Za-z0-9_-]{16,256}$/.test(key.slice(`pck_${id}_`.length))) throw unreadable()
  if (typeof claimUrl !== 'string' || !CLAIM_URL_RE.test(claimUrl)) throw unreadable()
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) throw unreadable()
  return { id, key, claimUrl, expiresAt: new Date(expiresAt).toISOString(), endsOn: new Date(expiresAt).toISOString().slice(0, 10) }
}

/**
 * Makes one test app with one POST: no body, no Origin, no redirect followed, and never a second call,
 * because each call that succeeds makes a new app.
 */
export async function makeTestApp(base, { fetchImpl = fetch, signal, userAgent } = {}) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
  let res
  let text
  try {
    res = await fetchImpl(`${base}/test-apps`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      redirect: 'manual',
      signal: combined,
    })
    text = await res.text()
  } catch (e) {
    if (signal?.aborted) throw new Stop(`Stopped before Pincast answered, so no key was saved. ${ORPHAN}`, 130, 'stopped')
    if (!res && NEVER_SENT.has(failureCode(e))) {
      throw new Stop(`Couldn't reach Pincast at ${base}, so no test app was made. Check your connection, then run the command again.`, 1, 'unreachable')
    }
    throw new Stop(`The call went out to Pincast, but its answer never arrived, so no key was saved. ${ORPHAN}`, 1, 'answer_lost')
  }
  if (res.status !== 200) throw refusal(res.status, text, res.headers.get('retry-after'), base)
  return readAnswer(text)
}
