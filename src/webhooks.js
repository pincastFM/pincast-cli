// Webhook signing per Standard Webhooks 1.0.0, as Pincast sends them (S4-00 section 4): the headers
// webhook-id, webhook-timestamp (Unix seconds) and webhook-signature ("v1," and the base64 HMAC-SHA256
// of "<id>.<timestamp>.<body>", keyed with the base64-decoded part of the secret after whsec_). During a
// secret's overlap both signatures go in the one header, space-delimited.
import { createHmac, randomBytes } from 'node:crypto'

export const SECRET_RE = /^whsec_([A-Za-z0-9+/]+={0,2})$/
export const ID_RE = /^[A-Za-z0-9_-]{1,255}$/
export const USER_AGENT = 'Pincast-Webhooks/1'
export const EVENT_TYPES = ['collect.created', 'review.approved', 'review.declined', 'person.deleted', 'webhook.test']
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** The HMAC key inside a secret, or null when it isn't a whsec_ secret. */
export function secretBytes(secret) {
  const m = typeof secret === 'string' ? SECRET_RE.exec(secret) : null
  if (!m) return null
  const bytes = Buffer.from(m[1], 'base64')
  return bytes.length ? bytes : null
}

/** One signature: v1, then the base64 HMAC-SHA256 of id.timestamp.body. */
export function sign(secret, id, timestamp, body) {
  const key = secretBytes(secret)
  if (!key) throw new TypeError('not a whsec_ secret')
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64')
  return `v1,${mac}`
}

/** The three Standard Webhooks headers, with one signature per secret. */
export function signedHeaders(secrets, id, timestamp, body) {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': secrets.map(s => sign(s, id, timestamp, body)).join(' '),
  }
}

export function newEventId() {
  let out = 'msg_'
  for (const b of randomBytes(26)) out += BASE32[b & 31]
  return out
}

/** A sample of each event type, shaped as S4-00 section 2 writes them. */
export function sampleEvent(type, { app = 'test-abcdefghij', mode = 'test', now = new Date() } = {}) {
  const at = now.toISOString()
  const earlier = new Date(now.getTime() - 6000).toISOString()
  const samples = {
    'collect.created': {
      app, mode, set: 'old-town-lanterns',
      card: { key: 'lantern:ferry-steps', type: 'lantern' },
      parent: null,
      actor: { id: 'test_demo', source: 'anonymous' },
      at: earlier, first: true, count: 1,
    },
    'review.approved': { app, mode, test_app: 'test-abcdefghij', state: 'approved', listed: true, reviewed_at: at },
    'review.declined': { app, mode, test_app: 'test-abcdefghij', state: 'declined', listed: false, reviewed_at: at, note: 'The card backs need a source credit for each photo.' },
    'person.deleted': { app, mode, person: { id: 'test_demo', source: 'anonymous' }, deleted_at: at },
    'webhook.test': { app, mode, endpoint: 'we_abcdefghijklmnopqrstuvwxyz', note: 'A test event sent from the pincast command.' },
  }
  return { type, timestamp: at, data: samples[type] }
}

/** Whether a URL points at this machine. */
export function isLocalAddress(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}
