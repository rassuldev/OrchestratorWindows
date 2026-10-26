import { expect, it } from 'vitest'
import { classifyResult } from '../../src/agents/classify.js'

it('success is ok', () => {
  expect(classifyResult({ subtype: 'success', is_error: false, result: 'done' }, 0, '')).toEqual({ kind: 'ok' })
})

it('real auth failure from CLI 2.1.251 is auth', () => {
  expect(
    classifyResult(
      { subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' },
      1,
      '',
    ),
  ).toMatchObject({ kind: 'auth', message: expect.stringContaining('Failed to authenticate') })
})

it('"You\'ve hit your session limit · resets 3:45pm" is rate_limited', () => {
  expect(
    classifyResult({ subtype: 'success', is_error: true, result: "You've hit your session limit · resets 3:45pm" }, 1, ''),
  ).toEqual({ kind: 'rate_limited' })
})

it('api_error_status 429 is rate_limited', () => {
  expect(classifyResult({ subtype: 'error_during_execution', is_error: true, api_error_status: 429 }, 1, '')).toEqual({ kind: 'rate_limited' })
})

it('api_error_status 401 and 403 are auth', () => {
  for (const s of [401, 403]) {
    expect(classifyResult({ subtype: 'error_during_execution', is_error: true, api_error_status: s, result: 'nope' }, 1, '')).toMatchObject({ kind: 'auth', message: 'nope' })
  }
})

it('rate-limit wording variants are rate_limited', () => {
  for (const m of ['rate limit exceeded', 'Rate-Limited', 'ratelimit', 'Error 429', 'Request rejected (429)', 'Too Many Requests', 'temporarily limiting requests', 'Claude usage limit reached']) {
    expect(classifyResult({ subtype: 'success', is_error: true, result: m }, 1, '')).toEqual({ kind: 'rate_limited' })
  }
})

it('auth wording variants are auth', () => {
  for (const m of ['Not logged in · Please run /login', 'Please run /login.', 'login expired', 'Invalid API key', 'token revoked', 'OAuth failure']) {
    expect(classifyResult({ subtype: 'success', is_error: true, result: m }, 1, '')).toMatchObject({ kind: 'auth' })
  }
})

it('non-success subtype without is_error is not ok', () => {
  expect(classifyResult({ subtype: 'error_max_turns', is_error: false }, 1, '')).toMatchObject({ kind: 'error' })
})

it('other errors are error with the result text', () => {
  expect(classifyResult({ subtype: 'error_max_turns', is_error: true, result: 'Reached max turns' }, 1, '')).toEqual({ kind: 'error', message: 'Reached max turns' })
})

it('no result + exit 1 is error with stderr tail', () => {
  expect(classifyResult(null, 1, 'boom: something broke')).toEqual({ kind: 'error', message: 'boom: something broke' })
})

it('no result, empty stderr falls back to the exit code', () => {
  expect(classifyResult(null, 2, '')).toEqual({ kind: 'error', message: 'exit code 2' })
  expect(classifyResult(null, null, '')).toEqual({ kind: 'error', message: 'exit code unknown' })
})

it('no result: stderr is classified too', () => {
  expect(classifyResult(null, 1, 'HTTP 429 Too Many Requests')).toEqual({ kind: 'rate_limited' })
  expect(classifyResult(null, 1, 'Not logged in · Please run /login')).toMatchObject({ kind: 'auth' })
})

it('stack-trace positions and ordinary words do not trigger rate_limited / auth', () => {
  for (const m of ['at cli.js:4290:12', 'x.js:429:1', 'Error in src/login.ts: catalog interface', 'blog index', 'reading /app/src/login.ts failed']) {
    expect(classifyResult({ subtype: 'success', is_error: true, result: m }, 1, '')).toEqual({ kind: 'error', message: m })
    expect(classifyResult(null, 1, m)).toEqual({ kind: 'error', message: m })
  }
})

it('empty result text falls back to stderr tail', () => {
  expect(classifyResult({ subtype: 'error_during_execution', is_error: true, result: '' }, 1, 'real cause')).toEqual({ kind: 'error', message: 'real cause' })
  expect(classifyResult({ subtype: 'error_during_execution', is_error: true, result: '' }, 3, '')).toEqual({ kind: 'error', message: 'exit code 3' })
})
