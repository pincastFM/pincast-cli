// The first run: the starter's set and one test collect, sent with the new app's key. Moved here from
// create-pincast 0.1.0 (f1dcb80). The User-Agent is now an argument, so each command sends its own.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COLLECT_RETRY_KEY, FIRST_COLLECT, SET_ID } from './starter.js'

export const FIRST_RUN_TIMEOUT_MS = 15_000

/**
 * One call with the app's key. Answers { ok: true } or { ok: false, why } and never throws, because a
 * failure here can't stop the command: the app is already made. `why` is written here and repeats no
 * part of the answer or of any error, either of which could quote the key. No redirect is followed,
 * because fetch would carry the key header to the new address.
 */
async function send(url, { method, key, body, headers = {}, accept, fetchImpl, stop, timeoutMs, userAgent }) {
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        'X-Pincast-Key': key,
        ...headers,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.any([timeout, stop]),
    })
    const text = await res.text()
    if (res.status !== 200) return { ok: false, why: `it answered ${res.status}` }
    let answer
    try {
      answer = JSON.parse(text)
    } catch {
      return { ok: false, why: "its answer couldn't be read" }
    }
    return accept(answer) ? { ok: true } : { ok: false, why: "its answer couldn't be read" }
  } catch {
    if (stop.aborted) return { ok: false, why: 'stopped' }
    if (timeout.aborted) {
      const seconds = Math.max(1, Math.round(timeoutMs / 1000))
      return { ok: false, why: `no answer in ${seconds} second${seconds === 1 ? '' : 's'}` }
    }
    return { ok: false, why: 'the connection failed' }
  }
}

/**
 * Sends the starter's set, then one collect for the test person, so the first screen shows a real card.
 * Answers what is still left to send: 'none', 'collect' or 'both', with the reason.
 *
 * The set goes first because a collect on a missing set is refused. Neither call is retried here.
 * - A repeat of the PUT is harmless: it upserts by set id and card key.
 * - A collect with no `at` counts again on each call, so this one carries an Idempotency-Key. If its
 *   answer is lost, the printed command repeats the same key and body, and Pincast answers from the
 *   first call for 24 hours instead of counting a second collect.
 */
export async function sendFirstRun(base, target, { appId, key, fetchImpl = fetch, stop, timeoutMs = FIRST_RUN_TIMEOUT_MS, userAgent }) {
  let setBody
  try {
    setBody = readFileSync(join(target, 'data', 'set.json'), 'utf8')
  } catch {
    return { left: 'both', why: "the set file couldn't be read" }
  }
  const common = { key, fetchImpl, stop, timeoutMs, userAgent }
  const set = await send(`${base}/sets/${SET_ID}`, {
    ...common,
    method: 'PUT',
    body: setBody,
    accept: a => a?.app === appId && a?.set === SET_ID,
  })
  if (!set.ok) return { left: 'both', why: set.why }
  const collect = await send(`${base}/sets/${SET_ID}/collects`, {
    ...common,
    method: 'POST',
    headers: { 'Idempotency-Key': COLLECT_RETRY_KEY },
    body: JSON.stringify(FIRST_COLLECT),
    accept: a => a?.collected === true && a?.card?.key === FIRST_COLLECT.card,
  })
  if (!collect.ok) return { left: 'collect', why: collect.why }
  return { left: 'none' }
}
