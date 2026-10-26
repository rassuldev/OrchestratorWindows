import { expect, it } from 'vitest'
import { StreamParser } from '../../src/agents/streamParser.js'

const assistant = (...content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } })
const toolResult = (content: unknown) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content }] } })

it('joins a JSON line split across chunks', () => {
  const p = new StreamParser()
  const line = assistant({ type: 'text', text: 'hi' })
  expect(p.push(line.slice(0, 10))).toEqual([])
  expect(p.push(line.slice(10) + '\n')[0]).toMatchObject({ kind: 'text', text: 'hi' })
})

it('stamps entries with Date.now() at parse time', () => {
  const p = new StreamParser()
  const before = Date.now()
  const [e] = p.push(assistant({ type: 'text', text: 'x' }) + '\n')
  expect(e.t).toBeGreaterThanOrEqual(before)
  expect(e.t).toBeLessThanOrEqual(Date.now())
})

it('skips blank and non-JSON lines', () => {
  const p = new StreamParser()
  const out = p.push('\n   \nnot json at all\n{broken\n[1,2]\n"str"\n' + assistant({ type: 'text', text: 'ok' }) + '\n')
  expect(out).toHaveLength(1)
  expect(out[0]).toMatchObject({ kind: 'text', text: 'ok' })
})

it('survives a 2 MB line, delivered in many chunks', () => {
  const p = new StreamParser()
  const big = 'x'.repeat(2 * 1024 * 1024)
  const line = toolResult(big) + '\n'
  const out = []
  for (let i = 0; i < line.length; i += 1000) out.push(...p.push(line.slice(i, i + 1000)))
  expect(out).toHaveLength(1)
  expect(out[0].kind).toBe('tool_result')
  expect(out[0].text).toHaveLength(300)
  expect(p.push(assistant({ type: 'text', text: 'after' }) + '\n')[0]).toMatchObject({ text: 'after' })
})

it('handles several lines in one chunk', () => {
  const p = new StreamParser()
  const out = p.push(assistant({ type: 'text', text: 'a' }) + '\n' + assistant({ type: 'text', text: 'b' }) + '\n')
  expect(out.map((e) => e.text)).toEqual(['a', 'b'])
})

it('end() flushes a final line without trailing newline', () => {
  const p = new StreamParser()
  expect(p.push(assistant({ type: 'text', text: 'tail' }))).toEqual([])
  expect(p.end()).toMatchObject([{ kind: 'text', text: 'tail' }])
  expect(p.end()).toEqual([])
})

it('summarizes Bash tool_use by command', () => {
  const p = new StreamParser()
  const [e] = p.push(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }) + '\n')
  expect(e).toMatchObject({ kind: 'tool', text: 'Bash ls -la' })
})

it('truncates a long Bash command to 200 chars', () => {
  const p = new StreamParser()
  const [e] = p.push(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'c'.repeat(500) } }) + '\n')
  expect(e.text).toBe('Bash ' + 'c'.repeat(200))
})

it('summarizes Edit/Write/Read tool_use by file_path', () => {
  const p = new StreamParser()
  const out = p.push(
    ['Edit', 'Write', 'Read']
      .map((name) => assistant({ type: 'tool_use', name, input: { file_path: '/a/b.ts', content: 'zzz' } }))
      .join('\n') + '\n',
  )
  expect(out.map((e) => e.text)).toEqual(['Edit /a/b.ts', 'Write /a/b.ts', 'Read /a/b.ts'])
})

it('summarizes other tools as JSON truncated to 200 chars', () => {
  const p = new StreamParser()
  const [e] = p.push(assistant({ type: 'tool_use', name: 'Grep', input: { pattern: 'p'.repeat(500) } }) + '\n')
  expect(e.kind).toBe('tool')
  expect(e.text.startsWith('Grep {"pattern":"ppp')).toBe(true)
  expect(e.text).toBe('Grep ' + JSON.stringify({ pattern: 'p'.repeat(500) }).slice(0, 200))
})

it('emits one entry per content block of an assistant message', () => {
  const p = new StreamParser()
  const out = p.push(
    assistant({ type: 'text', text: 'let me look' }, { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }) + '\n',
  )
  expect(out.map((e) => e.kind)).toEqual(['text', 'tool'])
})

it('tool_result with string content is cut to 300 chars', () => {
  const p = new StreamParser()
  const [e] = p.push(toolResult('r'.repeat(1000)) + '\n')
  expect(e).toMatchObject({ kind: 'tool_result' })
  expect(e.text).toBe('r'.repeat(300))
})

it('tool_result with array content joins the text blocks', () => {
  const p = new StreamParser()
  const [e] = p.push(toolResult([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]) + '\n')
  expect(e).toMatchObject({ kind: 'tool_result', text: 'one\ntwo' })
})

it('system init becomes a session-started entry', () => {
  const p = new StreamParser()
  const [e] = p.push(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x', session_id: 's1' }) + '\n')
  expect(e).toMatchObject({ kind: 'system', text: 'session started (model claude-x)' })
})

it('ignores hook_started / hook_response system events', () => {
  const p = new StreamParser()
  const out = p.push(
    JSON.stringify({ type: 'system', subtype: 'hook_started' }) + '\n' + JSON.stringify({ type: 'system', subtype: 'hook_response' }) + '\n',
  )
  expect(out).toEqual([])
})

it('api_retry becomes a system entry with the error', () => {
  const p = new StreamParser()
  const [e] = p.push(
    JSON.stringify({ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, attempt: 1, max_retries: 5, retry_delay_ms: 1000 }) + '\n',
  )
  expect(e).toMatchObject({ kind: 'system', text: 'API retry: rate_limit' })
})

it('captures the result event', () => {
  const p = new StreamParser()
  expect(p.result).toBeNull()
  const ev = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's1', total_cost_usd: 0.12, num_turns: 3, api_error_status: null, terminal_reason: 'completed' }
  const [e] = p.push(JSON.stringify(ev) + '\n')
  expect(e).toMatchObject({ kind: 'result', text: 'done' })
  expect(p.result).toMatchObject({ subtype: 'success', is_error: false, result: 'done', session_id: 's1', total_cost_usd: 0.12, api_error_status: null, terminal_reason: 'completed' })
})

it('result without text falls back to the subtype', () => {
  const p = new StreamParser()
  const [e] = p.push(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }) + '\n')
  expect(e).toMatchObject({ kind: 'result', text: 'error_max_turns' })
  expect(p.result).toMatchObject({ subtype: 'error_max_turns', is_error: true })
})

it('ignores unknown event types and malformed shapes', () => {
  const p = new StreamParser()
  const out = p.push(
    [
      JSON.stringify({ type: 'stream_event' }),
      JSON.stringify({ type: 'assistant' }),
      JSON.stringify({ type: 'assistant', message: { content: 'plain' } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'prompt' }] } }),
      JSON.stringify({ type: 'result' }),
    ].join('\n') + '\n',
  )
  expect(out).toEqual([])
  expect(p.result).toBeNull()
})

it('masks secrets before truncating, so a secret straddling the cut leaks no prefix', () => {
  const secret = 'SECRETVALUE-0123456789'
  const mask = (t: string) => t.split(secret).join('***')
  const p = new StreamParser(mask)
  const result = 'x'.repeat(290) + secret + ' tail'
  const command = 'y'.repeat(190) + secret
  const out = p.push(
    toolResult(result) + '\n' + assistant({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command } }) + '\n',
  )
  expect(out[0]).toMatchObject({ kind: 'tool_result', text: 'x'.repeat(290) + '*** tail' })
  expect(out[1].text).toBe(`Bash ${'y'.repeat(190)}***`)
  for (const e of out) expect(e.text).not.toContain('SECRET')

  const unmasked = new StreamParser().push(toolResult(result) + '\n')
  expect(unmasked[0].text).toContain('SECRETVAL') // the prefix that leaked before
})
