# Changelog

Every release of `@pincast/cli`, newest first. The README's Versions section says what a patch, a minor and a major mean for this package. npm keeps the date of each release.

## 0.1.0

The first release of the `pincast` command. It depends on `@pincast/api` 0.1.0, exactly.

### Added

- `pincast init [folder]`: makes a starter app and one test app with no account, saves the key in `.env` (mode 600), then sends the starter's set and one collect for `test_demo`. If either of those two doesn't go through, the app is kept and the command prints what's left to send.
- `pincast sets put <file>` and `pincast sets get <set>`.
- `pincast collect <set> <card>` and `pincast collects <set>`, for a test person by default. A live key needs `--live` and `--person`.
- `pincast webhooks sign`: signs a sample event by the Standard Webhooks rules and posts it to a receiver on this machine.
- `--json` on every command: one JSON object on stdout and nothing on stderr. `init --json` names the file that holds the key and never prints the key.
- Exit codes by kind of failure, listed in the README.
- `@pincast/cli/init`, the code `npm create pincast` runs from version 0.2.0 on.
