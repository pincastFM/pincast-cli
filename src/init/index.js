// `init`: create-pincast's flow, the one code path for both commands. `pincast init` calls createApp()
// below, and create-pincast 0.2.0's bin will call runCreate(), which is create-pincast 0.1.0's run()
// (6fb6be7) moved here with its text, its exit codes and its one-folder rule unchanged.
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { apiBase, API_ENV, DEFAULT_API, makeTestApp, Stop, waitText } from './api.js'
import { addReadmeSection, copyStarter, firstRunCommands, manifest, removeStarter, setAppId, TEST_PERSON, writeEnv } from './starter.js'

export { apiBase, API_ENV, DEFAULT_API, Stop, waitText, manifest, TEST_PERSON, firstRunCommands }
export const DEFAULT_FOLDER = 'pincast-app'

// Every line either command prints passes through here, so a key can't reach the terminal even by mistake.
export const hideKeys = text => String(text).replace(/pck_[A-Za-z0-9_-]+/g, '[key hidden]')

export const shellWord = word => (/^[A-Za-z0-9._/-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)

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

/** The steps after a good run, as printed. */
export function nextSteps({ shown, inPlace, base }) {
  return [...(inPlace ? [] : [`cd ${shellWord(shown)}`]), 'npm ci', ...firstRunCommands(base), 'npm run dev']
}

export function successText({ shown, inPlace, id, claimUrl, endsOn, base }) {
  const envPath = inPlace ? '.env' : join(shown, '.env')
  return [
    `Your app is ready in ${inPlace ? 'this folder' : shown}, with the test app ${id}.`,
    '',
    `Its key is saved in ${envPath}. Only your account can read that file, and git ignores it.`,
    '',
    `To keep this app past ${endsOn}, open this link while signed in to Pincast:`,
    '',
    `  ${claimUrl}`,
    '',
    'Next, install it, send its set and one collect, and start it:',
    '',
    ...nextSteps({ shown, inPlace, base }).map(s => `  ${s}`),
    '',
    'Then open http://localhost:5173.',
    '',
  ].join('\n')
}

/**
 * Makes the app: refuse a folder that isn't new or empty, copy the starter, make one POST, write .env
 * (mode 600), set the id. A failure before the key is saved takes back everything the run wrote, so the
 * same folder works on the next try. Throws Stop; never prints.
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
}) {
  const stopper = new AbortController()
  const onInterrupt = () => stopper.abort()
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
      addReadmeSection(target, { id: app.id, base, endsOn: app.endsOn, command })
    } catch (e) {
      throw new Stop(`The key is saved in .env, but the app's id couldn't be written (${e?.code ?? 'write failed'}). Set APP.id in shared/app.js to ${app.id}, and run UPDATE_GOLDENS=1 npm test.`, 1, 'id_not_written', { app: app.id, env: join(target, '.env') })
    }
    return {
      target, shown, inPlace, base,
      id: app.id, claimUrl: app.claimUrl, endsOn: app.endsOn, expiresAt: app.expiresAt,
      env: join(target, '.env'),
    }
  } catch (e) {
    process.removeListener('SIGINT', onInterrupt)
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
 * create-pincast's whole command, for its 0.2.0 shim: `run(argv, { command: 'npm create pincast' })`.
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
    const made = await createApp({ folder, command, base, custom, cwd, fetchImpl, beforeCopy, userAgent })
    say(successText(made))
    return 0
  } catch (e) {
    complain(e instanceof Stop ? e.message : `Something went wrong${e?.code ? ` (${e.code})` : ''}. No key was printed. Run the command again in a new or empty folder.`)
    return e instanceof Stop ? e.exitCode : 1
  }
}
