# @pincast/cli

The `pincast` command. Make a Placecard app with its own test key, send its set and its collects, and test your webhook receiver on your own machine.

It runs on Node 20.12 or later. Its one dependency is `@pincast/api`.

```sh
npx @pincast/cli init my-app
```

Or install it once and run `pincast`:

```sh
npm install --global @pincast/cli
```

## Start with a test app

`pincast init` makes a test app from this machine. It needs no account.

```sh
pincast init my-app
cd my-app
```

The folder has to be new or empty. The command copies a starter app into it, makes one test app, and saves the key in `.env`. Only your account can read that file, and git ignores it. Then it sends the starter's set and one collect for the test person `test_demo`, so the app's first screen shows a real card. It prints a claim link once. Open that link while signed in to Pincast to keep the app past its end date.

If the set or the collect doesn't go through, you still get your app. The command says which one is missing and prints the commands that send it.

## Commands

Run these in your app's folder, where `.env` holds the key.

| Command | What it does |
|:-|:-|
| `pincast init [folder]` | Makes a starter app and a test app. The folder defaults to `pincast-app` |
| `pincast sets put <file> [--set <set>]` | Registers a set from a JSON file, or updates it. The set id comes from `--set`, or from an `id` in the file |
| `pincast sets get <set>` | Reads a set |
| `pincast collect <set> <card>` | Records a collect. It uses a test person unless you name one with `--person` |
| `pincast collects <set>` | Reads the cards a person holds in a set |
| `pincast webhooks sign --to <address>` | Signs a sample event and posts it to your receiver on this machine |

For example, in the app `init` made. `init` already sent this set once, and `sets put` sends it again after you change it:

```sh
pincast sets put data/set.json --set old-town-lanterns
pincast collect old-town-lanterns lantern:ferry-steps
pincast collects old-town-lanterns
```

## Keys

The command reads the key from `PINCAST_KEY`, in the environment or in `.env` in this folder. `--env-file <file>` names another file. A value in the environment wins over the file.

The command never prints a key. Anything shaped like one is shown as `[key hidden]`, in text and in JSON. It takes no key on the command line, because a command line ends up in your shell history.

A test key collects only for test people, whose ids start with `test_`. With no `--person`, `collect` and `collects` use `PINCAST_ACTOR` from `.env`, or `test_demo`.

A live key writes real data. `collect` refuses a live key unless you pass `--live`, and then you name the person with `--person`.

`--api <address>` or `PINCAST_API` points the command at another copy of the API. The address has to use https, or http on this machine.

## Test your webhook receiver

Put your endpoint's secret in `PINCAST_WEBHOOK_SECRET`, then send a signed sample event to your receiver:

```sh
PINCAST_WEBHOOK_SECRET=whsec_... pincast webhooks sign --to http://localhost:3000/webhooks
```

It signs the event as Pincast does, by the Standard Webhooks rules. The headers are `webhook-id`, `webhook-timestamp` and `webhook-signature`, and the body is the event as JSON.

- `--type` picks the event: `collect.created` (the default), `review.approved`, `review.declined`, `person.deleted` or `webhook.test`.
- `--event <file>` sends your own JSON file, signed byte for byte.
- `--id` and `--timestamp` set those headers, so a run can be repeated.
- `--print` prints the headers and the body without sending them.

During a change of secret, put both secrets in `PINCAST_WEBHOOK_SECRET` with a space between them. The header then carries both signatures, as Pincast sends them.

It posts only to this machine: `localhost`, `127.0.0.1` or `::1`. It never follows a redirect. Your receiver has to answer with a 2xx, or the command exits 10.

## JSON

Add `--json` to any command. It then prints one JSON object on stdout and nothing on stderr.

A success reads `{ "ok": true, "command": ..., ... }`. A failure reads `{ "ok": false, "command": ..., "error": { "code", "kind", "exitCode", "message", ... } }`. When Pincast refused the call, `code` is the API's own error code, and `status`, `field`, `fix` and `retryAfter` come with it.

`pincast init --json` names the file that holds the key, in `env` and `keyIn`. It never prints the key itself. Read `PINCAST_KEY` from that file. `firstRun` says whether Pincast confirmed the starter's set and its one collect (`setConfirmed`, `collectConfirmed`, and `why` when it didn't), and `next` lists only the steps still left.

The command never prompts and never reads standard input, so it runs the same in a script, in CI or for an agent.

## Exit codes

| Code | Kind | Meaning |
|-:|:-|:-|
| 0 | | Done |
| 1 | `failed` | Something unexpected, or an answer the command couldn't read |
| 2 | `usage` | A command, option or argument it doesn't know, or one that's missing |
| 3 | `key` | No key or webhook secret, or Pincast refused the key |
| 4 | `refused` | Pincast refused the call as sent. Fix what `fix` names |
| 5 | `not_found` | The set or card isn't registered |
| 6 | `wait` | Too many calls. Try again after `retryAfter` seconds. The command never waits on its own |
| 7 | `later` | No answer, or a server error. Try again later |
| 8 | `local` | A file or folder on this machine, such as a folder that isn't empty |
| 9 | `live` | A live key without `--live` |
| 10 | `receiver` | Your webhook receiver answered with something other than a 2xx |
| 11 | `waiting` | The person isn't linked yet. Send their sign-in token, then send it again |
| 130 | `stopped` | Stopped with Ctrl-C. During `init`'s set and collect, the app is kept and the steps still print |

## For create-pincast

`npm create pincast` runs the same `init` code. Its package calls `runCreate` from `@pincast/cli/init`:

```js
import { runCreate } from '@pincast/cli/init'

process.exitCode = await runCreate(process.argv.slice(2), { command: 'npm create pincast' })
```

## License

MIT
