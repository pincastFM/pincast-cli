// Exit codes. Each failure has a code (the API's own error code when Pincast answered with one) and one
// of these kinds, and the kind sets the exit code. Scripts branch on the exit code; --json also gives
// the code itself. The numbers only ever gain new entries.
export const EXIT = Object.freeze({
  ok: 0,
  failed: 1, // something unexpected, or an answer this command couldn't read
  usage: 2, // a command, option or argument it doesn't know or is missing
  key: 3, // no key or webhook secret, or Pincast refused the key
  refused: 4, // Pincast refused the call as sent
  not_found: 5, // the set or card isn't registered, or no such service
  wait: 6, // too many calls: try again after retryAfter seconds
  later: 7, // no answer, a server error or a redirect: try again later
  local: 8, // a file or folder on this machine
  live: 9, // a live key, and --live wasn't passed
  receiver: 10, // the webhook receiver answered with something other than 2xx
  waiting: 11, // person_not_signed_in: link the person, then send it again
  stopped: 130, // Ctrl-C
})

const KEY_CODES = new Set(['key_missing', 'key_invalid', 'key_expired', 'key_conflict', 'key_ability_missing', 'key_kind_refused', 'secret_missing', 'secret_invalid'])
const BY_CODE = {
  usage: 'usage', folder_invalid: 'usage', api_invalid: 'usage', address_not_local: 'usage',
  folder_unreadable: 'local', folder_is_file: 'local', folder_not_empty: 'local', env_not_written: 'local',
  id_not_written: 'local', readme_not_written: 'local', file_unreadable: 'local', file_not_json: 'local', env_file_unreadable: 'local',
  set_not_registered: 'not_found', card_not_registered: 'not_found', no_test_app_service: 'not_found',
  rate_limited: 'wait', quota_exceeded: 'wait', test_apps_limit: 'wait',
  redirected: 'later', server_error: 'later', answer_lost: 'later', unreachable: 'later', signin_check_unavailable: 'later',
  answer_unreadable: 'failed', failed: 'failed',
  person_not_signed_in: 'waiting',
  test_person_required: 'refused',
  live_needs_flag: 'live',
  receiver_refused: 'receiver', receiver_unreachable: 'later',
  stopped: 'stopped',
}

/** The kind for an error code and, when Pincast answered, its status. */
export function kindOf(code, status = null) {
  if (code && KEY_CODES.has(code)) return 'key'
  if (code && BY_CODE[code]) return BY_CODE[code]
  if (status == null) return 'failed'
  if (status === 401) return 'key'
  if (status === 404) return 'not_found'
  if (status === 429) return 'wait'
  if (status === 408 || status >= 500 || status < 400) return 'later'
  return 'refused'
}

export const exitCodeOf = (code, status) => EXIT[kindOf(code, status)]
