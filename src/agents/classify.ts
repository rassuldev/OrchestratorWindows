import type { ResultEvent } from './streamParser.js'

export type Classified =
  | { kind: 'ok' }
  | { kind: 'rate_limited' }
  | { kind: 'auth'; message: string }
  | { kind: 'error'; message: string }

// A bare 429 would match stack-trace positions like `cli.js:4290:12`, so it must not touch ':' or digits.
const RATE_LIMIT_RE = /hit your .*limit|rate.?limit|too many requests|temporarily limiting|usage limit|(?<![:\d])429(?![:\d])/i
// No bare "log ?in" (matches "catalog interface"); "/login" must be a standalone command, not a path like src/login.ts.
const AUTH_RE = /authenticat|oauth|not logged in|login expired|invalid api key|token revoked|(?<![\w.\-/])\/login(?![\w/]|\.\w)/i

/**
 * `subtype: 'success'` alone never means success: CLI 2.1.251 reports auth failures
 * as `{subtype:'success', is_error:true, result:'Failed to authenticate: …'}`.
 */
export function classifyResult(result: ResultEvent | null, exitCode: number | null, stderrTail: string): Classified {
  if (result && !result.is_error && result.subtype === 'success') return { kind: 'ok' }
  const msg = result?.result || stderrTail
  const status = result?.api_error_status
  if (status === 429 || RATE_LIMIT_RE.test(msg)) return { kind: 'rate_limited' }
  const message = msg || `exit code ${exitCode ?? 'unknown'}`
  if (status === 401 || status === 403 || AUTH_RE.test(msg)) return { kind: 'auth', message }
  return { kind: 'error', message }
}
