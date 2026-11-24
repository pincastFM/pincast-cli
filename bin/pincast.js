#!/usr/bin/env node
import { main } from '../src/cli.js'

// Node's default crash report prints the error's message and source. Neither may ever carry a key.
const json = process.argv.includes('--json')
const crash = () => {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, command: null, error: { code: 'failed', kind: 'failed', exitCode: 1, message: 'Something went wrong. No key was printed.' } }, null, 2)}\n`)
  } else {
    process.stderr.write('Something went wrong. No key was printed.\n')
  }
  process.exit(1)
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)

main(process.argv.slice(2)).then((code) => { process.exitCode = code }, crash)
