// `init`: create-pincast's flow, the one code path for both commands. `pincast init` calls createApp()
// below, and create-pincast 0.2.0's bin calls runCreate(), which is create-pincast 0.1.0's run() as
// published (9116097: 6fb6be7, the first run from f1dcb80, the firewall wait from 2b75d2f) moved here
// with its text, its exit codes and its one-folder rule unchanged.
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { apiBase, API_ENV, DEFAULT_API, makeTestApp, Stop, waitText } from './api.js'
import { FIRST_RUN_TIMEOUT_MS, sendFirstRun } from './firstrun.js'
import {
  addReadmeSection, COLLECT_RETRY_KEY, copyStarter, FIRST_COLLECT, firstRunCommands, LIVE_KEY_LINE, manifest,
  removeStarter, SET_ID, setAppId, storedPath, TEST_PERSON, writeEnv,
} from './starter.js'

export {
  apiBase, API_ENV, DEFAULT_API, Stop, waitText, manifest, storedPath, TEST_PERSON, SET_ID, FIRST_COLLECT,
  COLLECT_RETRY_KEY, LIVE_KEY_LINE, firstRunCommands, addReadmeSection, FIRST_RUN_TIMEOUT_MS, sendFirstRun,
}
export const DEFAULT_FOLDER = 'pincast-app'

// Every line either command prints passes through here, so a key can't reach the terminal even by mistake.
export const hideKeys = text => String(text).replace(/pck_[A-Za-z0-9_-]+/g, '[key hidden]')

export const shellWord = word => (/^[A-Za-z0-9._/-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)

// Printed just before the first run's two calls.
export const SENDING = 'Sending the starter\'s set and one test collect to Pincast.\n\n'

/** Checks a folder name before anything is made. */
export function checkFolderName(folder) {
  // eslint-disable-next-line no-control-regex
  if (!folder.trim() || /[\u0000-\u001f\u007f]/.test(folder)) throw new Stop("That folder name can't be used.", 2, 'folder_invalid')
}

/** Refuses anything but a new or empty folder, before any call is made. Answers whether it exists. */
function checkTarget(target, shown) {
  let info
  try {
    info = statSync(target)
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw new Stop(`Couldn't read ${shown} (${e.code}).`, 1, 'folder_unreadable')
  }
  if (!info.isDirectory()) throw new Stop(`${shown} is a file. Name a new or empty folder.`, 1, 'folder_is_file')
  if (readdirSync(target).length) throw new Stop(`${shown} already has files in it, and this command won't write over them. Name a new or empty folder.`, 1, 'folder_not_empty')
  return true
}

// What the first run sent, and what the person does next, for each thing it can leave undone.
const FIRST_RUN_TEXT = {
  none: () => ({
    state: `Pincast has your set, and the test person ${TEST_PERSON} holds Ferry Steps.`,
    next: 'Next, install it and start it:',
  }),
  collect: why => ({
    state: `Pincast has your set but didn't confirm the first collect (${why}). Your app is fine, and the commands below send it. Sending it again within a day changes nothing.`,
    next: 'Next, install it, send its one collect, and start it:',
  }),
  both: why => ({
    state: `Pincast didn't confirm your set (${why}). Your app is fine, and the commands below send the set and one collect.`,
    next: 'Next, install it, send its set and one collect, and start it:',
  }),
}

/** The steps after a good run, as printed: only what the first run left undone, then start the app. */
export function nextSteps({ shown, inPlace, base, first }) {
  return [...(inPlace ? [] : [`cd ${shellWord(shown)}`]), 'npm ci', ...firstRunCommands(base, first.left), 'npm run dev']
}

/** What the first run got Pincast to confirm, for --json. */
export const firstRunResult = first => ({
  setConfirmed: first.left !== 'both',
  collectConfirmed: first.left === 'none',
  why: first.why ?? null,
})

export function successText({ shown, inPlace, id, claimUrl, endsOn, base, first }) {
  const envPath = inPlace ? '.env' : join(shown, '.env')
  const { state, next } = FIRST_RUN_TEXT[first.left](first.why)
  return [
    `Your app is ready in ${inPlace ? 'this folder' : shown}, with the test app ${id}.`,
    '',
    `Its key is saved in ${envPath}. Only your account can read that file, and git ignores it.`,
    '',
    state,
    '',
    `To keep this app past ${endsOn}, open this link while signed in to Pincast:`,
    '',
    `  ${claimUrl}`,
    '',
    next,
    '',
    ...nextSteps({ shown, inPlace, base, first }).map(s => `  ${s}`),
    '',
    'Then open http://localhost:5173.',
    '',
  ].join('\n')
}

/**
 * Makes the app: refuse a folder that isn't new or empty, copy the starter, make one POST, write .env
 * (mode 600), set the id, then the first run: the starter's set and one collect with the new key. A
 * failure before the key is saved takes back everything the run wrote, so the same folder works on the
 * next try. Nothing in the first run stops the command: the app already works, and the answer says what
 * is left to send. onFirstRun() is called just before the first run's calls. Throws Stop; never prints.
 */
export async function createApp({
  folder = DEFAULT_FOLDER,
  command,
  base,
  custom = false,
  cwd = process.cwd(),
  fetchImpl = fetch,
  beforeCopy = () => {},
  userAgent,
  firstRunTimeoutMs = FIRST_RUN_TIMEOUT_MS,
  onFirstRun = () => {},
}) {
  const stopper = new AbortController()
  const onInterrupt = () => stopper.abort()
  const firstRunStopper = new AbortController()
  const onFirstRunInterrupt = () => firstRunStopper.abort()
  let target
  const files = []
  let madeFrom
  let holdsApp = false
  try {
    checkFolderName(folder)
    target = resolve(cwd, folder)
    const fromCwd = relative(cwd, target)
    const inPlace = fromCwd === ''
    const shown = inPlace ? basename(target) : (fromCwd.startsWith('..') || isAbsolute(fromCwd) ? target : fromCwd)

    if (!checkTarget(target, shown)) madeFrom = mkdirSync(target, { recursive: true })

    // The starter goes down first: a failed copy then costs no test app.
    beforeCopy()
    copyStarter(target, files)

    process.once('SIGINT', onInterrupt)
    const app = await makeTestApp(base, { fetchImpl, signal: stopper.signal, userAgent })
    process.removeListener('SIGINT', onInterrupt)
    holdsApp = true

    try {
      writeEnv(target, { key: app.key, claimUrl: app.claimUrl, customBase: custom ? base : null, command })
    } catch (e) {
      throw new Stop(`Pincast made the test app, but its key couldn't be saved (${e?.code ?? 'write failed'}). Nobody holds that key now, so that app can't be used and it ends on its own. Run the command again in a new folder.`, 1, 'env_not_written')
    }
    try {
      setAppId(target, app.id)
    } catch (e) {
      throw new Stop(`The key is saved in .env, but the app's id couldn't be written (${e?.code ?? 'write failed'}). Set APP.id in shared/app.js to ${app.id}, and run UPDATE_GOLDENS=1 npm test.`, 1, 'id_not_written', { app: app.id, env: join(target, '.env') })
    }

    // From here the app exists and works, so nothing that goes wrong with these two calls stops the command.
    onFirstRun()
    process.once('SIGINT', onFirstRunInterrupt)
    const first = await sendFirstRun(base, target, {
      appId: app.id,
      key: app.key,
      fetchImpl,
      stop: firstRunStopper.signal,
      timeoutMs: firstRunTimeoutMs,
      userAgent,
    })
    process.removeListener('SIGINT', onFirstRunInterrupt)

    try {
      addReadmeSection(target, { id: app.id, base, endsOn: app.endsOn, command, left: first.left })
    } catch (e) {
      throw new Stop(`Your app is made and its key is in .env, but its README couldn't be updated (${e?.code ?? 'write failed'}). Skip the README's Go live steps, because the first one would erase the key, and follow https://docs.pincast.fm/quickstart. Your claim link is in .env as PINCAST_CLAIM_URL.`, 1, 'readme_not_written', { app: app.id, env: join(target, '.env') })
    }
    return {
      target, shown, inPlace, base,
      id: app.id, claimUrl: app.claimUrl, endsOn: app.endsOn, expiresAt: app.expiresAt,
      env: join(target, '.env'),
      first,
      // Ctrl-C during the first run: the app is kept, and the command exits 130 after saying what is left.
      stopped: firstRunStopper.signal.aborted,
    }
  } catch (e) {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGINT', onFirstRunInterrupt)
    if (!holdsApp && target) {
      try {
        removeStarter(target, files, madeFrom)
      } catch { /* the message below still has to reach the person */ }
    }
    if (e instanceof Stop) throw e
    throw new Stop(`Something went wrong${e?.code ? ` (${e.code})` : ''}. No key was printed. Run the command again in a new or empty folder.`, 1, 'failed')
  }
}

/**
 * create-pincast's whole command, for its 0.2.0 shim: `runCreate(argv, { command: 'npm create pincast' })`.
 * Answers the exit code. Nothing here prints an error's own message.
 */
export async function runCreate(argv, {
  command = 'npm create pincast',
  userAgent = 'create-pincast',
  env = process.env,
  cwd = process.cwd(),
  out = text => process.stdout.write(text),
  err = text => process.stderr.write(text),
  fetchImpl = fetch,
  beforeCopy = () => {},
  firstRunTimeoutMs = FIRST_RUN_TIMEOUT_MS,
} = {}) {
  const say = text => out(hideKeys(text))
  const complain = text => err(`${hideKeys(text)}\n`)
  const usage = `Make a Placecard app with its own test key:

  ${command} [folder]

The folder has to be new or empty. With no folder named, the app goes in ./${DEFAULT_FOLDER}.
`
  try {
    const flags = argv.filter(a => a.startsWith('-'))
    if (flags.some(f => f === '-h' || f === '--help')) {
      say(usage)
      return 0
    }
    if (flags.length) throw new Stop(`This command takes no options.\n\n${usage}`, 2, 'usage')
    if (argv.length > 1) throw new Stop(`This command takes one folder.\n\n${usage}`, 2, 'usage')
    const folder = argv[0] ?? DEFAULT_FOLDER
    checkFolderName(folder)
    const { base, custom } = apiBase(env, [API_ENV])
    const made = await createApp({
      folder, command, base, custom, cwd, fetchImpl, beforeCopy, userAgent, firstRunTimeoutMs,
      onFirstRun: () => say(SENDING),
    })
    say(successText(made))
    return made.stopped ? 130 : 0
  } catch (e) {
    complain(e instanceof Stop ? e.message : `Something went wrong${e?.code ? ` (${e.code})` : ''}. No key was printed. Run the command again in a new or empty folder.`)
    return e instanceof Stop ? e.exitCode : 1
  }
}
