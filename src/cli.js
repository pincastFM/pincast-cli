// The pincast command. main() reads the arguments, runs one command and answers its exit code. It never
// prompts, never reads standard input, and passes every line it prints through hide(), so a key or a
// webhook secret can't reach the terminal even by mistake. No error's own message is ever printed:
// a JSON parse error can quote its input.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'
import { Pincast, PincastError, isTestPerson, keyInfo } from '@pincast/api'
import { EXIT, exitCodeOf, kindOf } from './exit.js'
import { apiBase, createApp, DEFAULT_FOLDER, hideKeys, nextSteps, Stop, successText, TEST_PERSON } from './init/index.js'
import { EVENT_TYPES, ID_RE, USER_AGENT as WEBHOOK_AGENT, isLocalAddress, newEventId, sampleEvent, secretBytes, signedHeaders } from './webhooks.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const VERSION = pkg.version
const USER_AGENT = `pincast-cli/${VERSION}`

export const hide = text => hideKeys(text).replace(/whsec_[A-Za-z0-9+/=]+/g, '[secret hidden]')

export const USAGE = `pincast ${VERSION}: the Pincast command.

  pincast init [folder]             Make a Placecard app with its own test key
  pincast sets put <file> [--set <set>]
                                    Register or update a set from a JSON file
  pincast sets get <set>            Read a set
  pincast collect <set> <card> [--person <id>] [--source anonymous|logto] [--live]
                                    Record a collect, for a test person by default
  pincast collects <set> [--person <id>]
                                    Read the cards a person holds in a set
  pincast webhooks sign --to <local address> [--type <event>] [--event <file>] [--print]
                                    Sign a sample event and post it to your receiver

Every command takes --json, and then prints one JSON object.
The key comes from PINCAST_KEY, in the environment or in .env in this folder
(or the file named by --env-file). It is never printed.
The webhook secret comes from PINCAST_WEBHOOK_SECRET the same way.
--api <address> or PINCAST_API points the command at another copy of the API.
`

const OPTIONS = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  api: { type: 'string' },
  'env-file': { type: 'string' },
  set: { type: 'string' },
  person: { type: 'string' },
  source: { type: 'string' },
  live: { type: 'boolean' },
  to: { type: 'string' },
  type: { type: 'string' },
  event: { type: 'string' },
  id: { type: 'string' },
  timestamp: { type: 'string' },
  print: { type: 'boolean' },
}
const COMMON = ['json', 'help', 'version', 'api', 'env-file']
const ALLOWED = {
  init: [],
  'sets put': ['set'],
  'sets get': [],
  collect: ['person', 'source', 'live'],
  collects: ['person'],
  'webhooks sign': ['to', 'type', 'event', 'id', 'timestamp', 'print'],
}

const usage = message => new Stop(message, EXIT.usage, 'usage')

/** The settings: the environment first, then .env (or --env-file). Values are read, never printed. */
function settings(env, cwd, envFile) {
  let file = {}
  const path = resolve(cwd, envFile ?? '.env')
  let text = null
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if (envFile || e.code !== 'ENOENT') throw new Stop(`Couldn't read ${envFile ?? '.env'} (${e.code ?? 'read failed'}).`, EXIT.local, 'env_file_unreadable')
  }
  if (text != null) {
    try {
      file = parseEnv(text)
    } catch {
      throw new Stop(`${envFile ?? '.env'} couldn't be read as an env file.`, EXIT.local, 'env_file_unreadable')
    }
  }
  return { ...file, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v != null && v !== '')) }
}

function readJsonFile(cwd, file) {
  let text
  try {
    text = readFileSync(resolve(cwd, file))
  } catch (e) {
    throw new Stop(`Couldn't read ${file} (${e.code ?? 'read failed'}).`, EXIT.local, 'file_unreadable')
  }
  try {
    return { bytes: text, value: JSON.parse(text.toString('utf8')) }
  } catch {
    throw new Stop(`${file} isn't JSON.`, EXIT.local, 'file_not_json')
  }
}

function client(conf, opts, fetchImpl) {
  const { base } = apiBase({ '--api': opts.api, PINCAST_API: conf.PINCAST_API }, ['--api', 'PINCAST_API'])
  const key = conf.PINCAST_KEY || null
  if (!key) {
    throw new Stop('No key. Set PINCAST_KEY, or run this in a folder whose .env holds it. pincast init makes an app with a test key.', EXIT.key, 'key_missing')
  }
  return { api: new Pincast({ key, baseUrl: base, fetch: fetchImpl, retries: 0, timeoutMs: 30_000 }), info: keyInfo(key), base }
}

/** The person for collect and collects: --person, else PINCAST_ACTOR when it is a test person, else test_demo. */
function person(opts, conf, info) {
  if (opts.person != null) {
    if (!opts.person.trim()) throw usage('--person needs an id.')
    return opts.person
  }
  if (info && !info.test) throw usage('This is a live key, so name the person with --person.')
  return isTestPerson(conf.PINCAST_ACTOR) ? conf.PINCAST_ACTOR : TEST_PERSON
}

const counts = obj => Object.entries(obj || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'

const COMMANDS = {
  async init(ctx) {
    if (ctx.args.length > 1) throw usage('init takes one folder.')
    const folder = ctx.args[0] ?? DEFAULT_FOLDER
    const { base, custom } = apiBase(
      { '--api': ctx.opts.api, PINCAST_API: ctx.conf.PINCAST_API, PINCAST_CREATE_API: ctx.conf.PINCAST_CREATE_API },
      ['--api', 'PINCAST_API', 'PINCAST_CREATE_API'],
    )
    const made = await createApp({ folder, command: 'pincast init', base, custom, cwd: ctx.cwd, fetchImpl: ctx.fetchImpl, beforeCopy: ctx.beforeCopy, userAgent: USER_AGENT })
    return {
      text: successText(made),
      json: {
        app: { id: made.id, mode: 'test', expiresAt: made.expiresAt, endsOn: made.endsOn },
        folder: made.target,
        env: made.env,
        keyIn: { file: made.env, name: 'PINCAST_KEY' },
        actor: TEST_PERSON,
        claimUrl: made.claimUrl,
        api: made.base,
        next: nextSteps(made),
      },
    }
  },

  async 'sets put'(ctx) {
    if (ctx.args.length !== 1) throw usage('sets put takes one file: pincast sets put <file> [--set <set>].')
    const [file] = ctx.args
    const { value } = readJsonFile(ctx.cwd, file)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Stop(`${file} has to hold one JSON object.`, EXIT.local, 'file_not_json')
    const { id: fileId, ...body } = value
    const set = ctx.opts.set ?? fileId
    if (typeof set !== 'string' || !set) throw usage(`Name the set with --set, or give ${file} an "id".`)
    const { api } = client(ctx.conf, ctx.opts, ctx.fetchImpl)
    const answer = await api.putSet(set, body)
    const n = Array.isArray(body.cards) ? body.cards.length : 0
    return {
      text: `Set ${answer.set} ${answer.setCreated ? 'is registered' : 'is updated'}: ${answer.name}, ${n} card${n === 1 ? '' : 's'} sent.\nActive cards: ${counts(answer.active)}.\n`,
      json: { set: answer.set, answer },
    }
  },

  async 'sets get'(ctx) {
    if (ctx.args.length !== 1) throw usage('sets get takes one set: pincast sets get <set>.')
    const [set] = ctx.args
    const { api } = client(ctx.conf, ctx.opts, ctx.fetchImpl)
    const answer = await api.getSet(set)
    return {
      text: `Set ${answer.set}: ${answer.name}, updated ${answer.updatedAt}.\nActive cards: ${counts(answer.active)}.\nCollects: ${answer.collects}, by ${answer.players} player${answer.players === 1 ? '' : 's'}.\n`,
      json: { set: answer.set, answer },
    }
  },

  async collect(ctx) {
    if (ctx.args.length !== 2) throw usage('collect takes a set and a card: pincast collect <set> <card>.')
    const [set, card] = ctx.args
    const { api, info } = client(ctx.conf, ctx.opts, ctx.fetchImpl)
    const live = info ? !info.test : false
    if (live && !ctx.opts.live) {
      throw new Stop('This is a live key, so this collect would write real data. Add --live to send it.', EXIT.live, 'live_needs_flag')
    }
    const id = person(ctx.opts, ctx.conf, info)
    if (info?.test && !isTestPerson(id)) {
      throw new Stop(`A test key collects only for test people, whose ids start with test_. ${id} doesn't.`, EXIT.refused, 'test_person_required')
    }
    const source = ctx.opts.source ?? 'anonymous'
    if (!['anonymous', 'logto'].includes(source)) throw usage('--source is anonymous or logto.')
    const answer = await api.postCollect(set, { card, actor: { id, source } })
    return {
      text: `Collected ${answer.card?.key ?? card} for ${id}: ${answer.first ? 'the first time' : `${answer.count} times now`}.\n`,
      json: { set, card, person: id, live, answer },
    }
  },

  async collects(ctx) {
    if (ctx.args.length !== 1) throw usage('collects takes one set: pincast collects <set>.')
    const [set] = ctx.args
    const { api, info } = client(ctx.conf, ctx.opts, ctx.fetchImpl)
    const id = person(ctx.opts, ctx.conf, info)
    const answer = await api.getCollects(set, { actor: [id] })
    const cards = answer.cards || []
    const lines = cards.map(c => `  ${c.key} (${c.type}), collected ${c.count} time${c.count === 1 ? '' : 's'}`)
    return {
      text: `${id} holds ${cards.length} card${cards.length === 1 ? '' : 's'} in ${answer.set}.\n${lines.length ? `${lines.join('\n')}\n` : ''}`,
      json: { set, person: id, answer },
    }
  },

  async 'webhooks sign'(ctx) {
    if (ctx.args.length) throw usage('webhooks sign takes options only.')
    const { opts, conf } = ctx
    const secrets = String(conf.PINCAST_WEBHOOK_SECRET || '').split(/\s+/).filter(Boolean)
    if (!secrets.length) {
      throw new Stop("No webhook secret. Set PINCAST_WEBHOOK_SECRET to the endpoint's whsec_ secret, in the environment or in .env.", EXIT.key, 'secret_missing')
    }
    if (secrets.length > 2 || !secrets.every(secretBytes)) {
      throw new Stop('PINCAST_WEBHOOK_SECRET has to be one whsec_ secret, or two separated by a space during a change of secret.', EXIT.key, 'secret_invalid')
    }
    let to = null
    if (!opts.print) {
      if (!opts.to) throw usage('Name the receiver with --to, such as --to http://localhost:3000/webhooks, or pass --print.')
      try {
        to = new URL(opts.to)
      } catch {
        throw usage(`--to isn't a web address.`)
      }
      if (!['http:', 'https:'].includes(to.protocol) || !isLocalAddress(to)) {
        throw new Stop('webhooks sign posts only to this machine: localhost, 127.0.0.1 or ::1.', EXIT.usage, 'address_not_local')
      }
    }
    let body
    let type
    if (opts.event) {
      if (opts.type) throw usage('Pass --type or --event, not both.')
      const { bytes, value } = readJsonFile(ctx.cwd, opts.event)
      body = bytes
      type = typeof value?.type === 'string' ? value.type : null
    } else {
      type = opts.type ?? 'collect.created'
      if (!EVENT_TYPES.includes(type)) throw usage(`--type is one of ${EVENT_TYPES.join(', ')}.`)
      const info = keyInfo(conf.PINCAST_KEY)
      body = Buffer.from(JSON.stringify(sampleEvent(type, info ? { app: info.app, mode: info.test ? 'test' : 'live' } : {})))
    }
    const id = opts.id ?? newEventId()
    if (!ID_RE.test(id)) throw usage('--id is 1 to 255 letters, digits, underscores and hyphens.')
    const timestamp = opts.timestamp != null ? Number(opts.timestamp) : Math.floor(Date.now() / 1000)
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw usage('--timestamp is whole Unix seconds.')
    const headers = signedHeaders(secrets, id, timestamp, body)
    const sent = { id, type, timestamp, signatures: secrets.length, headers, bytes: body.length }
    if (opts.print) {
      return {
        text: `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body.toString('utf8')}\n`,
        json: { ...sent, body: body.toString('utf8') },
      }
    }
    let res
    let reply = ''
    try {
      res = await ctx.fetchImpl(to.href, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'User-Agent': WEBHOOK_AGENT },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
      reply = (await res.text()).slice(0, 500)
    } catch {
      throw new Stop(`Nothing answered at ${to.href}. Start your receiver, then run this again.`, EXIT.later, 'receiver_unreachable')
    }
    const result = { ...sent, to: to.href, status: res.status, reply }
    if (res.status < 200 || res.status > 299) {
      throw new Stop(`Your receiver answered ${res.status} to ${type ?? 'the event'} (${id}). Pincast counts anything but a 2xx as a failure and sends it again later.`, EXIT.receiver, 'receiver_refused', { status: res.status, result })
    }
    return {
      text: `Sent ${type ?? 'the event'} (${id}) to ${to.href}, signed with ${secrets.length} secret${secrets.length === 1 ? '' : 's'}. Your receiver answered ${res.status}.\n`,
      json: result,
    }
  },
}

function commandName(positionals) {
  const [a, b] = positionals
  if (a === 'sets' || a === 'webhooks') {
    const name = `${a} ${b}`
    if (!COMMANDS[name]) throw usage(`pincast ${[a, b].filter(Boolean).join(' ')} isn't a command.\n\n${USAGE}`)
    return { name, args: positionals.slice(2) }
  }
  if (!a || !COMMANDS[a]) throw usage(`${a ? `pincast ${a} isn't a command.` : 'Name a command.'}\n\n${USAGE}`)
  return { name: a, args: positionals.slice(1) }
}

function describeError(e) {
  if (e instanceof PincastError) {
    const code = e.code ?? (e.status == null ? 'unreachable' : null)
    const kind = kindOf(code, e.status)
    const what = e.status == null
      ? "Pincast didn't answer. Check your connection and the address, then run it again."
      : `Pincast answered ${e.status}${e.code ? ` ${e.code}` : ''}${e.field ? ` (${e.field})` : ''}.${e.fix ? ` ${e.fix}` : ''}`
    return { code: code ?? `http_${e.status}`, kind, exitCode: exitCodeOf(code, e.status), message: what, status: e.status, field: e.field, fix: e.fix, retryAfter: e.retryAfter, operation: e.operation }
  }
  if (e instanceof Stop) {
    const kind = e.code === 'usage' ? 'usage' : kindOf(e.code, e.status ?? null)
    return { code: e.code, kind, exitCode: EXIT[kind], message: e.message, status: e.status ?? null, retryAfter: e.retryAfter ?? null }
  }
  return { code: 'failed', kind: 'failed', exitCode: EXIT.failed, message: `Something went wrong${e?.code ? ` (${e.code})` : ''}. No key was printed.` }
}

/** Runs the command and answers its exit code. */
export async function main(argv, {
  env = process.env,
  cwd = process.cwd(),
  out = text => process.stdout.write(text),
  err = text => process.stderr.write(text),
  fetchImpl = globalThis.fetch,
  beforeCopy = () => {},
} = {}) {
  const wantsJson = argv.includes('--json')
  const say = text => out(hide(text))
  const sayJson = obj => out(`${hide(JSON.stringify(obj, null, 2))}\n`)
  let name = null
  try {
    let parsed
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
    } catch {
      const bad = argv.find(a => a.startsWith('-') && !Object.keys(OPTIONS).some(o => a === `--${o}` || a.startsWith(`--${o}=`) || (OPTIONS[o].short && a === `-${OPTIONS[o].short}`)))
      throw usage(`${bad ? `${bad} isn't an option here, or it needs a value.` : 'An option is missing its value.'}\n\n${USAGE}`)
    }
    const { values: opts, positionals } = parsed
    if (opts.version) {
      if (opts.json) sayJson({ ok: true, version: VERSION })
      else say(`${VERSION}\n`)
      return EXIT.ok
    }
    if (opts.help || !positionals.length) {
      if (!positionals.length && !opts.help) throw usage(`Name a command.\n\n${USAGE}`)
      if (opts.json) sayJson({ ok: true, usage: USAGE })
      else say(USAGE)
      return EXIT.ok
    }
    const found = commandName(positionals)
    name = found.name
    const extra = Object.keys(opts).filter(o => !COMMON.includes(o) && !ALLOWED[name].includes(o))
    if (extra.length) throw usage(`pincast ${name} doesn't take --${extra[0]}.\n\n${USAGE}`)
    const conf = settings(env, cwd, opts['env-file'])
    const done = await COMMANDS[name]({ args: found.args, opts, conf, cwd, fetchImpl, beforeCopy })
    if (opts.json) sayJson({ ok: true, command: name, ...done.json })
    else say(done.text)
    return EXIT.ok
  } catch (e) {
    const error = describeError(e)
    if (wantsJson) {
      const result = e instanceof Stop && e.result ? e.result : undefined
      sayJson({ ok: false, command: name, error, ...(result ? { result } : {}) })
    } else {
      err(`${hide(error.message)}\n`)
    }
    return error.exitCode
  }
}
