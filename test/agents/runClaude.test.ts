import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeCommand, runClaude } from '../../src/agents/runClaude.js'
import type { Config } from '../../src/config.js'
import type { LogEntry } from '../../src/core/schemas.js'

const FAKE = resolve(import.meta.dirname, '../fixtures/fake-claude.mjs')
let dir: string
let cfg: Config

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runclaude-'))
  cfg = { orchestratorRoot: '/orch', workspace: dir, port: 1, claudeBin: FAKE, stepTimeoutMin: 1 }
})

function run(role: string, env: NodeJS.ProcessEnv = {}, extra: Partial<Parameters<typeof runClaude>[0]> = {}) {
  const entries: LogEntry[] = []
  const p = runClaude({
    cfg,
    cwd: dir,
    systemPrompt: `ROLE: ${role}\nrest of prompt`,
    prompt: 'TASK_ID: t1\ndo it',
    onEntry: (e) => entries.push(e),
    env,
    ...extra,
  })
  return { p, entries }
}

function script(s: object): NodeJS.ProcessEnv {
  const file = join(dir, 'script.json')
  writeFileSync(file, JSON.stringify(s))
  return { FAKE_CLAUDE_SCRIPT: file }
}

describe('runClaude', () => {
  it('runs the fake CLI and streams entries; ok result', async () => {
    const { p, entries } = run('analyst_spec')
    const r = await p
    expect(r.classified).toEqual({ kind: 'ok' })
    expect(r.exitCode).toBe(0)
    expect(r.result?.session_id).toBe('fake-session')
    expect(entries.some((e) => e.kind === 'text')).toBe(true)
    expect(existsSync(join(dir, '.orchestrator/spec.md'))).toBe(true)
  })

  it('passes --append-system-prompt, --settings and --model', async () => {
    const argvFile = join(dir, 'argv.jsonl')
    cfg.model = 'opus'
    await run('analyst_spec', { FAKE_ARGV_FILE: argvFile }).p
    const argv: string[] = JSON.parse(readFileSync(argvFile, 'utf8').trim())
    expect(argv.slice(0, 2)).toEqual(['-p', 'TASK_ID: t1\ndo it'])
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('ROLE: analyst_spec\nrest of prompt')
    expect(argv).toContain('--verbose')
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1]).permissions.deny).toContain('Bash(git push *)')
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus')
  })

  it('merges the env option over process.env', async () => {
    const bin = join(dir, 'env-claude.mjs')
    const out = join(dir, 'env.txt')
    writeFileSync(bin, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, process.env.EXTRA + ' ' + typeof process.env.PATH)\n`)
    cfg.claudeBin = bin
    await run('analyst_spec', { EXTRA: 'yes' }).p
    expect(readFileSync(out, 'utf8')).toBe('yes string')
  })

  it('claudeCommand runs .js/.mjs under this Node and refuses .cmd shims', () => {
    expect(claudeCommand('claude')).toEqual(['claude', []])
    expect(claudeCommand('C:\\Tools\\claude.exe')).toEqual(['C:\\Tools\\claude.exe', []])
    expect(claudeCommand('C:/npm/node_modules/@anthropic-ai/claude-code/cli.js')).toEqual([
      process.execPath,
      ['C:/npm/node_modules/@anthropic-ai/claude-code/cli.js'],
    ])
    expect(() => claudeCommand('C:\\npm\\claude.cmd')).toThrow(/cli\.js/)
  })

  it('a .cmd claudeBin is an error result, not a crash', async () => {
    cfg.claudeBin = 'claude.cmd'
    const r = await run('analyst_spec').p
    expect(r.classified.kind).toBe('error')
  })

  it('applies the mask option to every entry', async () => {
    const { p, entries } = run('analyst_spec', {}, { mask: (t) => t.replaceAll('fake', '***') })
    await p
    const text = entries.find((e) => e.kind === 'text')!.text
    expect(text).toBe('*** analyst_spec done')
  })

  it('omits --model when not configured', async () => {
    const argvFile = join(dir, 'argv.jsonl')
    await run('analyst_spec', { FAKE_ARGV_FILE: argvFile }).p
    expect(readFileSync(argvFile, 'utf8')).not.toContain('--model')
  })

  it('timeout kills a hanging process and reports timeout', async () => {
    const t0 = Date.now()
    const { p } = run('implementer', script({ implementer: ['hang'] }), { timeoutMs: 300 })
    const r = await p
    expect(r.classified).toEqual({ kind: 'error', message: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(4000)
  })

  /** Waits until the grandchild whose pid the fake CLI wrote is gone (kills it if it never goes). */
  async function expectGrandchildGone(pidFile: string): Promise<void> {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 3000 })
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL')
    }
  }

  it('timeout kills the whole process tree, including processes the agent started', async () => {
    const pidFile = join(dir, 'child.pid')
    const env = { ...script({ implementer: ['hang_child'] }), FAKE_CHILD_PID_FILE: pidFile }
    const { p } = run('implementer', env, { timeoutMs: 500 })
    expect((await p).classified).toEqual({ kind: 'error', message: 'timeout' })
    await expectGrandchildGone(pidFile)
  })

  // Only Windows remembers an exited parent's pid in its orphans (macOS/Linux reparent them to pid 1).
  it.runIf(process.platform === 'win32')('processes the agent left running are stopped when it exits normally', async () => {
    const pidFile = join(dir, 'child.pid')
    const env = { ...script({ implementer: ['ok_child'] }), FAKE_CHILD_PID_FILE: pidFile }
    expect((await run('implementer', env).p).classified).toEqual({ kind: 'ok' })
    await expectGrandchildGone(pidFile)
  })

  it('abort signal kills the process', async () => {
    const ac = new AbortController()
    const { p } = run('implementer', script({ implementer: ['hang'] }), { signal: ac.signal })
    setTimeout(() => ac.abort(), 300)
    const r = await p
    expect(r.classified).toEqual({ kind: 'error', message: 'aborted' })
  })

  it('an already-aborted signal does not leave a running process', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await run('implementer', script({ implementer: ['hang'] }), { signal: ac.signal }).p
    expect(r.classified).toEqual({ kind: 'error', message: 'aborted' })
  })

  it('crash gives error with stderr tail "boom"', async () => {
    const r = await run('implementer', script({ implementer: ['crash'] })).p
    expect(r.classified).toEqual({ kind: 'error', message: 'boom' })
    expect(r.exitCode).toBe(1)
    expect(r.result).toBeNull()
  })

  it('classifies rate limit and auth results', async () => {
    const env = script({ implementer: ['rate_limit', 'auth'] })
    expect((await run('implementer', env).p).classified.kind).toBe('rate_limited')
    expect((await run('implementer', env).p).classified.kind).toBe('auth')
  })

  it('reports a missing binary as an error instead of throwing', async () => {
    cfg.claudeBin = join(dir, 'does-not-exist')
    const r = await run('implementer').p
    expect(r.classified.kind).toBe('error')
    expect((r.classified as { message: string }).message).toMatch(/ENOENT/)
    expect(r.exitCode).toBeNull()
  })

  it('script entries are consumed per role in order', async () => {
    const env = script({ verifier: ['fail', 'ok'] })
    const verdict = (pass: boolean) => ({ prompt: `VERDICT_FILE: ${join(dir, 'v/verdict.json')}\nTASK_ID: t1`, pass })
    for (const pass of [false, true]) {
      await run('verifier', env, { prompt: verdict(pass).prompt }).p
      expect(JSON.parse(readFileSync(join(dir, 'v/verdict.json'), 'utf8')).pass).toBe(pass)
    }
  })

  it('FAKE_PLAN overrides the built-in plan and the implementer writes src/<task>.txt', async () => {
    await run('architect', { FAKE_PLAN: '{"custom":true}' }).p
    expect(readFileSync(join(dir, '.orchestrator/plan.json'), 'utf8')).toBe('{"custom":true}')
    await run('implementer').p
    expect(existsSync(join(dir, 'src/t1.txt'))).toBe(true)
  })

  it('FAKE_ECHO_ENV exposes .env contents in the text stream', async () => {
    writeFileSync(join(dir, '.env'), 'API_KEY=s3cret\n')
    const { p, entries } = run('implementer', { FAKE_ECHO_ENV: '1' })
    await p
    expect(entries.some((e) => e.kind === 'text' && e.text.includes('API_KEY=s3cret'))).toBe(true)
  })
})
