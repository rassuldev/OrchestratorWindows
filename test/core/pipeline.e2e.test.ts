import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Config } from '../../src/config.js'
import { runClaude } from '../../src/agents/runClaude.js'
import { slashPath } from '../../src/agents/prompts.js'
import { appRunner, stopAll } from '../../src/core/appRunner.js'
import { EventBus } from '../../src/core/events.js'
import { execGit } from '../../src/core/git.js'
import { projectPaths } from '../../src/core/paths.js'
import { ProjectRunner, submitInput, verdictNotes } from '../../src/core/pipeline.js'
import type { ProjectState } from '../../src/core/schemas.js'
import { CheckpointMismatchError } from '../../src/core/stateMachine.js'
import { createProject, loadState, saveState } from '../../src/core/store.js'

const ROOT = resolve(import.meta.dirname, '../..')
const FAKE = join(ROOT, 'test/fixtures/fake-claude.mjs')

let workspace: string
let cfg: Config
let bus: EventBus
let fakeEnv: NodeJS.ProcessEnv
let notify: ReturnType<typeof vi.fn<(title: string, msg: string) => void>>

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'orch-pipeline-'))
  cfg = { orchestratorRoot: ROOT, workspace, port: 4321, claudeBin: FAKE, stepTimeoutMin: 1 }
  bus = new EventBus()
  fakeEnv = {}
  notify = vi.fn<(title: string, msg: string) => void>()
})

afterEach(async () => {
  await stopAll()
  await rm(workspace, { recursive: true, force: true })
})

/** Runs the real runClaude against the fake CLI with this test's FAKE_* env vars. */
const run: typeof runClaude = (opts) => runClaude({ ...opts, env: { ...opts.env, ...fakeEnv } })

const runner = (dir: string) => new ProjectRunner(cfg, dir, { bus, run, notify })

async function script(s: Record<string, string[]>): Promise<void> {
  const file = join(workspace, 'script.json')
  await writeFile(file, JSON.stringify(s))
  fakeEnv.FAKE_CLAUDE_SCRIPT = file
}

function argvFile(): string {
  const file = join(workspace, 'argv.jsonl')
  fakeEnv.FAKE_ARGV_FILE = file
  return file
}

async function prompts(file: string): Promise<string[]> {
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  return lines.map((l) => {
    const argv: string[] = JSON.parse(l)
    return argv[argv.indexOf('-p') + 1]
  })
}

const gitLog = (dir: string) => execGit(dir, 'log', '--oneline')

async function newProject(): Promise<string> {
  return (await createProject(cfg, { name: 'demo', task: 'Make a CLI' })).dir
}

/** Drives a fresh project through the questions/spec/plan checkpoints; returns at the start of build. */
async function toBuild(r: ProjectRunner, dir: string): Promise<void> {
  expect(await r.runUntilBlocked()).toBe('waiting')
  await submitInput(cfg, dir, { kind: 'answers', answers: { q1: 'yes' }, secrets: {} }, bus)
  expect(await r.runUntilBlocked()).toBe('waiting')
  await submitInput(cfg, dir, { kind: 'approve' }, bus)
  expect(await r.runUntilBlocked()).toBe('waiting')
  await submitInput(cfg, dir, { kind: 'approve' }, bus)
}

describe('ProjectRunner', () => {
  it('full run with checkpoints produces a committed project', async () => {
    const dir = await newProject()
    const r = runner(dir)
    expect(await r.runUntilBlocked()).toBe('waiting') // at answers
    await submitInput(cfg, dir, { kind: 'answers', answers: { q1: 'yes' }, secrets: { API_KEY: 'secret-value-1' } }, bus)
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('API_KEY=secret-value-1')
    expect(JSON.parse(await readFile(projectPaths(dir).answers, 'utf8'))).toEqual({ q1: 'yes' })
    expect(JSON.stringify(await loadState(dir))).not.toContain('secret-value-1')
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'approve' }, bus) // spec
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'approve' }, bus) // plan (hasUI false)
    expect(await r.runUntilBlocked()).toBe('waiting')
    expect((await loadState(dir)).checkpoint?.kind).toBe('demo')
    await submitInput(cfg, dir, { kind: 'demo', comments: '' }, bus) // after mvp task
    expect(await r.runUntilBlocked()).toBe('done')

    const log = await gitLog(dir)
    expect(log).toMatch(/task-t1: First task \(attempt 1\)/)
    expect(log).toMatch(/task-t2: Second task \(attempt 1\)/)
    expect(log).toMatch(/docs: README and REPORT/)
    expect(existsSync(join(dir, 'REPORT.md'))).toBe(true)
    expect((await execGit(dir, 'status', '--porcelain')).trim()).toBe('')

    const s = await loadState(dir)
    expect(s.phase).toBe('done')
    expect(s.currentStepId).toBeNull()
    expect(s.steps.map((st) => st.role)).toEqual([
      'analyst_questions', 'analyst_spec', 'architect',
      'implementer', 'verifier', 'reviewer',
      'implementer', 'verifier', 'reviewer',
      'finalizer',
    ])
    expect(s.steps.every((st) => st.status === 'ok' && st.endedAt && st.sessionId === 'fake-session')).toBe(true)
    expect(s.steps[0].costUsd).toBe(0.01)
    expect(s.steps[0].id).toMatch(/^[\w-]+$/)
    expect(s.steps[0].label).toBe('Вопросы аналитика')
    expect(s.steps[3].label).toBe('Задача t1: First task — исполнитель (попытка 1)')
    expect(s.steps[3].taskId).toBe('t1')
    expect(JSON.stringify(s)).not.toContain('secret-value-1')

    const logFiles = await readdir(projectPaths(dir).logsDir)
    expect(logFiles.sort()).toEqual(s.steps.map((st) => `${st.id}.jsonl`).sort())

    expect(notify).toHaveBeenCalledWith('Orchestrator', 'demo: нужно ваше решение')
    expect(notify).toHaveBeenLastCalledWith('Orchestrator', 'demo: проект готов')
  })

  it('emits state and log events', async () => {
    const dir = await newProject()
    const states: ProjectState[] = []
    const logs: { stepId: string; text: string }[] = []
    bus.on('state', (_id: string, s: ProjectState) => states.push(s))
    bus.on('log', (_id: string, stepId: string, e: { text: string }) => logs.push({ stepId, text: e.text }))
    expect(await runner(dir).runUntilBlocked()).toBe('waiting')
    expect(states.at(-1)?.phase).toBe('await_answers')
    expect(states.some((s) => s.currentStepId !== null)).toBe(true)
    const stepId = states.at(-1)!.steps[0].id
    expect(logs.some((l) => l.stepId === stepId && l.text.includes('fake analyst_questions done'))).toBe(true)
  })

  it('implementer that changes nothing counts as a failed attempt', async () => {
    const dir = await newProject()
    const r = runner(dir)
    await toBuild(r, dir)
    await script({ implementer: ['noop', 'ok'] })
    const states: ProjectState[] = []
    bus.on('state', (_id: string, s: ProjectState) => states.push(structuredClone(s)))
    expect(await r.runUntilBlocked()).toBe('waiting') // at demo

    const afterFirst = states.find((s) => s.steps.at(-1)?.role === 'implementer' && s.steps.at(-1)?.status === 'failed')!
    expect(afterFirst.attempt).toBe(2)
    expect(afterFirst.subStep).toBe('implement')
    expect(afterFirst.feedback).toContain('No changes')
    expect(afterFirst.steps.at(-1)?.error).toBe('No changes were made to the project')
    const s = await loadState(dir)
    expect(s.checkpoint?.kind).toBe('demo')
    expect(await gitLog(dir)).toMatch(/task-t1: First task \(attempt 2\)/)
  })

  it('notes of passing verdicts are collected into followups.md and shown to the next implementer', async () => {
    const dir = await newProject()
    const r = runner(dir)
    await toBuild(r, dir)
    fakeEnv.FAKE_NOTES = 'grass grows through the paths'
    await script({ verifier: ['fail', 'ok'] })
    const argv = argvFile()
    expect(await r.runUntilBlocked()).toBe('waiting') // at demo
    const followups = await readFile(projectPaths(dir).followups, 'utf8')
    expect(followups).toMatch(/^# Замечания проверяющих/)
    expect(followups).toContain('## t1 · проверка (попытка 2)\n\n- [ ] verifier note: grass grows through the paths\n')
    expect(followups).toContain('## t1 · ревью (попытка 2)\n\n- [ ] reviewer note: grass grows through the paths\n')
    expect(followups).not.toContain('попытка 1') // a failed verdict's notes are not follow-ups: its issues went back as feedback

    await submitInput(cfg, dir, { kind: 'demo', comments: '' }, bus)
    await r.runUntilBlocked()
    const implementerPrompt = (await prompts(argv)).find((p) => p.includes('TASK_ID: t2'))!
    expect(implementerPrompt).toContain(slashPath(projectPaths(dir).followups))
    delete fakeEnv.FAKE_NOTES
  })

  it('verifier fail loops back to implementer with issues', async () => {
    const dir = await newProject()
    const r = runner(dir)
    await toBuild(r, dir)
    await script({ verifier: ['fail', 'ok'] })
    const argv = argvFile()
    expect(await r.runUntilBlocked()).toBe('waiting') // at demo

    const s = await loadState(dir)
    const build = s.steps.filter((st) => st.taskId === 't1')
    expect(build.map((st) => `${st.role}:${st.status}:${st.attempt}`)).toEqual([
      'implementer:ok:1', 'verifier:failed:1', 'implementer:ok:2', 'verifier:ok:2', 'reviewer:ok:2',
    ])
    expect(build[1].error).toContain('fake issue')
    expect(build[2].label).toBe('Задача t1: First task — исполнитель (попытка 2)')
    const ps = await prompts(argv)
    expect(ps[2]).toContain('TASK_ID: t1')
    expect(ps[2]).toContain('Verifier found:\n- fake issue')
  })

  it('rate limit sets limitUntil and returns rate_limited without consuming an attempt', async () => {
    const dir = await newProject()
    await script({ analyst_questions: ['rate_limit'] })
    const before = Date.now()
    expect(await runner(dir).runUntilBlocked()).toBe('rate_limited')
    const s = await loadState(dir)
    expect(s.phase).toBe('questions')
    expect(s.attempt).toBe(1)
    expect(s.feedback).toBeNull()
    expect(s.limitHits).toBe(1)
    expect(s.currentStepId).toBeNull()
    expect(s.steps.at(-1)?.status).toBe('limited')
    expect(s.resumeNote).toBe(true) // the stopped run may have left partial work behind
    const until = Date.parse(s.limitUntil!)
    expect(until).toBeGreaterThanOrEqual(before + 10 * 60_000)
    expect(until).toBeLessThan(Date.now() + 10 * 60_000 + 1000)

    // the next hit backs off longer; a waiting run reports rate_limited without spawning anything
    expect(await runner(dir).runUntilBlocked()).toBe('rate_limited')
    await saveState(dir, { ...(await loadState(dir)), limitUntil: null })
    expect(await runner(dir).runUntilBlocked()).toBe('waiting') // second script entry defaults to ok
    expect((await loadState(dir)).limitHits).toBe(0)
    expect((await loadState(dir)).resumeNote).toBe(false)
  })

  it('backs off 20 minutes on the second consecutive limit hit', async () => {
    const dir = await newProject()
    await script({ analyst_questions: ['rate_limit', 'rate_limit'] })
    await runner(dir).runUntilBlocked()
    await saveState(dir, { ...(await loadState(dir)), limitUntil: null })
    const before = Date.now()
    expect(await runner(dir).runUntilBlocked()).toBe('rate_limited')
    const s = await loadState(dir)
    expect(s.limitHits).toBe(2)
    expect(Date.parse(s.limitUntil!)).toBeGreaterThanOrEqual(before + 20 * 60_000)
  })

  it('pauseOnLimit pauses on a rate limit and notifies instead of backing off', async () => {
    const dir = await newProject()
    await saveState(dir, { ...(await loadState(dir)), pauseOnLimit: true })
    await script({ analyst_questions: ['rate_limit'] })
    expect(await runner(dir).runUntilBlocked()).toBe('paused')
    const s = await loadState(dir)
    expect(s.paused).toBe(true)
    expect(s.limitUntil).toBeNull()
    expect(s.error).toBeNull()
    expect(s.attempt).toBe(1)
    expect(s.currentStepId).toBeNull()
    expect(s.steps.at(-1)?.status).toBe('limited')
    expect(s.resumeNote).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await runner(dir).runUntilBlocked()).toBe('paused')
  })

  it('auth failure pauses with the login message', async () => {
    const dir = await newProject()
    await script({ analyst_questions: ['auth'] })
    expect(await runner(dir).runUntilBlocked()).toBe('error')
    const s = await loadState(dir)
    expect(s.paused).toBe(true)
    expect(s.error).toBe(
      'Claude CLI не авторизован: запустите `claude` в терминале и выполните /login, затем нажмите «Продолжить».',
    )
    expect(s.currentStepId).toBeNull()
    expect(s.steps.at(-1)?.status).toBe('failed')
    expect(s.attempt).toBe(1)
    expect(s.resumeNote).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await runner(dir).runUntilBlocked()).toBe('paused')
  })

  it('secrets are masked in logs/*.jsonl', async () => {
    const dir = await newProject()
    const r = runner(dir)
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'answers', answers: { q1: 'yes' }, secrets: { API_KEY: 'secret-value-1' } }, bus)
    fakeEnv.FAKE_ECHO_ENV = '1'
    const emitted: string[] = []
    bus.on('log', (_id: string, _stepId: string, e: { text: string }) => emitted.push(e.text))
    expect(await r.runUntilBlocked()).toBe('waiting') // spec

    const logsDir = projectPaths(dir).logsDir
    const s = await loadState(dir)
    const specLog = await readFile(join(logsDir, `${s.steps.at(-1)!.id}.jsonl`), 'utf8')
    const entries = specLog.trim().split('\n').map((l) => JSON.parse(l))
    expect(entries.length).toBeGreaterThan(1)
    expect(specLog).toContain('API_KEY=***')
    expect(specLog).not.toContain('secret-value-1')
    expect(emitted.join('\n')).toContain('API_KEY=***')
    expect(emitted.join('\n')).not.toContain('secret-value-1')
  })

  it('secrets echoed in an agent error or a verdict are masked before reaching state.json', async () => {
    const dir = await newProject()
    const leaked = new Set<string>()
    const leaky: typeof runClaude = async (opts) => {
      const r = await run(opts)
      const role = /^ROLE: (\S+)/.exec(opts.systemPrompt)?.[1] ?? ''
      if (leaked.has(role)) return r
      if (role === 'analyst_spec') {
        leaked.add(role)
        return { ...r, classified: { kind: 'error', message: 'crashed near secret-value-1' } }
      }
      if (role === 'verifier') {
        leaked.add(role)
        const vf = /^VERDICT_FILE: (.+)$/m.exec(opts.prompt)![1]
        await writeFile(vf, JSON.stringify({ pass: false, issues: ['found secret-value-1 in output'] }))
      }
      return r
    }
    const r = new ProjectRunner(cfg, dir, { bus, run: leaky, notify })
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'answers', answers: { q1: 'yes' }, secrets: { API_KEY: 'secret-value-1' } }, bus)
    expect(await r.runUntilBlocked()).toBe('waiting') // spec: failed once (masked), then ok
    await submitInput(cfg, dir, { kind: 'approve' }, bus)
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'approve' }, bus)
    const states: string[] = []
    bus.on('state', (_id: string, s: ProjectState) => states.push(JSON.stringify(s)))
    expect(await r.runUntilBlocked()).toBe('waiting') // demo, after a failed verdict

    const s = await loadState(dir)
    expect(s.steps.find((st) => st.role === 'analyst_spec')?.error).toBe('crashed near ***')
    expect(s.steps.find((st) => st.role === 'verifier')?.error).toBe('found *** in output')
    expect(states.some((j) => j.includes('Verifier found:\\n- found *** in output'))).toBe(true)
    expect(states.join('')).not.toContain('secret-value-1')
    expect(await readFile(projectPaths(dir).state, 'utf8')).not.toContain('secret-value-1')
  })

  it('project files changed by the verifier are reverted and fail the verdict, so the implementer redoes it', async () => {
    const dir = await newProject()
    let tampered = false
    const tampering: typeof runClaude = async (opts) => {
      const res = await run(opts)
      if (opts.systemPrompt.startsWith('ROLE: verifier') && !tampered) {
        tampered = true
        await writeFile(join(dir, 'src/t1.txt'), 'quietly fixed by the verifier\n')
        await writeFile(join(dir, 'hotfix.js'), 'x')
      }
      return res
    }
    const r = new ProjectRunner(cfg, dir, { bus, run: tampering, notify })
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'answers', answers: {}, secrets: { API_KEY: 'secret-value-1' } }, bus)
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'approve' }, bus)
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'approve' }, bus)
    const argv = argvFile()
    expect(await r.runUntilBlocked()).toBe('waiting') // at demo

    const build = (await loadState(dir)).steps.filter((st) => st.taskId === 't1')
    expect(build.map((st) => `${st.role}:${st.status}:${st.attempt}`)).toEqual([
      'implementer:ok:1', 'verifier:failed:1', 'implementer:ok:2', 'verifier:ok:2', 'reviewer:ok:2',
    ])
    expect(build[1].error).toMatch(/verifier changed project files .*reverted/i)
    expect(build[1].error).toContain('hotfix.js')
    expect(existsSync(join(dir, 'hotfix.js'))).toBe(false)
    expect(await readFile(join(dir, 'src/t1.txt'), 'utf8')).not.toContain('quietly fixed')
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain('secret-value-1')
    expect((await prompts(argv))[2]).toContain('hotfix.js') // the retrying implementer is told
  })

  it('a stale verdict file from an earlier run does not satisfy a verifier that writes nothing', async () => {
    const dir = await newProject()
    const r = runner(dir)
    await toBuild(r, dir)
    // e.g. left by a run before a help retry reset the attempt to 1
    await writeFile(join(projectPaths(dir).verdictsDir, 't1-a1-verify.json'), JSON.stringify({ pass: true, issues: [] }))
    await script({ verifier: ['noop', 'ok'] })
    expect(await r.runUntilBlocked()).toBe('waiting') // at demo
    const build = (await loadState(dir)).steps.filter((st) => st.taskId === 't1')
    expect(build.map((st) => `${st.role}:${st.status}:${st.attempt}`)).toEqual([
      'implementer:ok:1', 'verifier:failed:1', 'verifier:ok:2', 'reviewer:ok:2',
    ])
    expect(build[1].error).toContain('t1-a1-verify.json was not written')
  })

  it('an unexpected error after the step started becomes a failed attempt, not a stuck step', async () => {
    const dir = await newProject()
    // The implementer leaves a stale index.lock, so commitAll throws on every attempt.
    const locking: typeof runClaude = async (opts) => {
      const res = await run(opts)
      if (opts.systemPrompt.startsWith('ROLE: implementer')) await writeFile(join(dir, '.git/index.lock'), '')
      return res
    }
    const r = new ProjectRunner(cfg, dir, { bus, run: locking, notify })
    await toBuild(r, dir)
    expect(await r.runUntilBlocked()).toBe('waiting')
    const s = await loadState(dir)
    expect(s.currentStepId).toBeNull()
    expect(s.phase).toBe('needs_help')
    expect(s.checkpoint?.message).toMatch(/^Internal error: .*index\.lock/s)
    const impl = s.steps.filter((st) => st.role === 'implementer')
    expect(impl.map((st) => `${st.status}:${st.attempt}`)).toEqual(['failed:1', 'failed:2', 'failed:3'])
    expect(impl.every((st) => st.error?.startsWith('Internal error:') && st.endedAt)).toBe(true)
  })

  it('a log write failure does not break the step', async () => {
    const dir = await newProject()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const noLogs: typeof runClaude = async (opts) => {
        await rm(projectPaths(dir).logsDir, { recursive: true, force: true })
        return run(opts)
      }
      const logs: string[] = []
      bus.on('log', (_id: string, _stepId: string, e: { text: string }) => logs.push(e.text))
      expect(await new ProjectRunner(cfg, dir, { bus, run: noLogs, notify }).runUntilBlocked()).toBe('waiting')
      expect((await loadState(dir)).steps[0].status).toBe('ok')
      expect(logs.length).toBeGreaterThan(0)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('step ids stay unique when two steps start in the same millisecond', async () => {
    const dir = await newProject()
    const t = 1_700_000_000_000
    const s = await loadState(dir)
    const taken = `${t}-analyst_questions`
    await saveState(dir, {
      ...s,
      steps: [{ id: taken, role: 'analyst_questions', label: 'x', attempt: 1, status: 'failed', startedAt: new Date(t).toISOString() }],
    })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t)
    try {
      expect(await runner(dir).runUntilBlocked()).toBe('waiting')
    } finally {
      clock.mockRestore()
    }
    const ids = (await loadState(dir)).steps.map((st) => st.id)
    expect(ids).toEqual([taken, `${taken}-2`])
    expect(ids[1]).toMatch(/^[\w-]+$/)
  })

  it('interrupted step is re-run with the resume note', async () => {
    const dir = await newProject()
    const s = await loadState(dir)
    const stuck = '1700000000000-analyst_questions'
    await saveState(dir, {
      ...s,
      currentStepId: stuck,
      steps: [{ id: stuck, role: 'analyst_questions', label: 'Вопросы аналитика', attempt: 1, status: 'running', startedAt: new Date().toISOString() }],
    })
    const argv = argvFile()
    expect(await runner(dir).runUntilBlocked()).toBe('waiting')

    const after = await loadState(dir)
    expect(after.steps[0].status).toBe('interrupted')
    expect(after.steps[0].endedAt).toBeDefined()
    expect(after.steps[1].status).toBe('ok')
    expect(after.resumeNote).toBe(false)
    expect((await prompts(argv))[0]).toContain('was interrupted')
  })

  it('abort leaves the step current so the next run treats it as interrupted', async () => {
    const dir = await newProject()
    await script({ analyst_questions: ['hang'] })
    const r = runner(dir)
    const running = r.runUntilBlocked()
    await vi.waitFor(async () => expect((await loadState(dir)).currentStepId).not.toBeNull(), { timeout: 5000 })
    await new Promise((res) => setTimeout(res, 200)) // let the fake CLI start
    r.abort()
    expect(await running).toBe('paused')
    const s = await loadState(dir)
    expect(s.currentStepId).toBe(s.steps[0].id)
    expect(s.steps[0].status).toBe('running')

    expect(await runner(dir).runUntilBlocked()).toBe('waiting')
    const after = await loadState(dir)
    expect(after.steps.map((st) => st.status)).toEqual(['interrupted', 'ok'])
  })

  it('the demo app is stopped before the next step runs, so it no longer holds its port or database', async () => {
    const dir = await newProject()
    const r = runner(dir)
    await toBuild(r, dir)
    expect(await r.runUntilBlocked()).toBe('waiting') // at demo
    await appRunner.start(dir, `node -e "console.log('http://localhost:5199'); setInterval(() => {}, 1000)"`)
    expect(appRunner.status(dir).running).toBe(true)
    await submitInput(cfg, dir, { kind: 'demo', comments: '' }, bus)
    const seen: boolean[] = []
    const watching: typeof runClaude = (opts) => {
      seen.push(appRunner.status(dir).running)
      return run(opts)
    }
    expect(await new ProjectRunner(cfg, dir, { bus, run: watching, notify }).runUntilBlocked()).toBe('done')
    expect(seen[0]).toBe(false)
    expect(appRunner.status(dir).running).toBe(false)
  })

  it('a schema-invalid plan.json from the architect is retried once, then stops for help', async () => {
    const dir = await newProject()
    const task = (id: string) => ({ id, title: id, description: 'd', acceptance: ['a'], verify: [] })
    fakeEnv.FAKE_PLAN = JSON.stringify({
      platform: 'cli', hasUI: false, runCommand: 'x', testCommand: 'y',
      milestones: [
        { id: 'm1', title: 'a', mvp: true, tasks: [task('t1')] },
        { id: 'm2', title: 'b', mvp: true, tasks: [task('t2')] },
      ],
    })
    const argv = argvFile()
    const r = runner(dir)
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'answers', answers: {}, secrets: {} }, bus)
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'approve' }, bus)
    expect(await r.runUntilBlocked()).toBe('waiting')

    const s = await loadState(dir)
    expect(s.currentStepId).toBeNull()
    expect(s.phase).toBe('needs_help')
    expect(s.checkpoint?.message).toMatch(/plan\.json is invalid: .*exactly one milestone must have mvp: true \(found 2\)/)
    const arch = s.steps.filter((st) => st.role === 'architect')
    expect(arch.map((st) => `${st.status}:${st.attempt}`)).toEqual(['failed:1', 'failed:2'])
    expect((await prompts(argv)).at(-1)).toContain('exactly one milestone must have mvp: true')

    // "retry" from help must not trip over the invalid plan either
    await submitInput(cfg, dir, { kind: 'help', action: 'retry' }, bus)
    delete fakeEnv.FAKE_PLAN
    expect(await r.runUntilBlocked()).toBe('waiting')
    expect((await loadState(dir)).checkpoint?.kind).toBe('plan')
  })

  it('an invalid plan.json during build is an internal error, a failed attempt', async () => {
    const dir = await newProject()
    const r = runner(dir)
    await toBuild(r, dir)
    await writeFile(projectPaths(dir).plan, '{ not json')
    expect(await r.runUntilBlocked()).toBe('waiting')
    const s = await loadState(dir)
    expect(s.currentStepId).toBeNull()
    expect(s.phase).toBe('needs_help')
    expect(s.checkpoint?.message).toMatch(/^Internal error: .*plan\.json/)
    const impl = s.steps.filter((st) => st.role === 'implementer')
    expect(impl.map((st) => `${st.status}:${st.attempt}`)).toEqual(['failed:1', 'failed:2', 'failed:3'])
  })

  it('a non-build step that fails twice stops at the help checkpoint', async () => {
    const dir = await newProject()
    await script({ analyst_questions: ['crash', 'noop'] })
    expect(await runner(dir).runUntilBlocked()).toBe('waiting')
    const s = await loadState(dir)
    expect(s.phase).toBe('needs_help')
    expect(s.checkpoint?.message).toContain('questions.json')
    expect(s.steps.map((st) => st.label)).toEqual(['Вопросы аналитика', 'Вопросы аналитика (попытка 2)'])
    expect(notify).toHaveBeenCalledWith('Orchestrator', 'demo: нужно ваше решение')
  })
})

describe('submitInput', () => {
  it('submitInput with the wrong checkpoint throws CheckpointMismatchError and does not change state', async () => {
    const dir = await newProject()
    const before = await loadState(dir) // phase questions, no checkpoint
    await expect(
      submitInput(cfg, dir, { kind: 'answers', answers: { q1: 'x' }, secrets: { API_KEY: 'secret-value-1' } }, bus),
    ).rejects.toBeInstanceOf(CheckpointMismatchError)
    expect(await loadState(dir)).toEqual(before)
    expect(existsSync(join(dir, '.env'))).toBe(false)
    expect(existsSync(projectPaths(dir).answers)).toBe(false)

    expect(await runner(dir).runUntilBlocked()).toBe('waiting') // at answers
    const waiting = await loadState(dir)
    await expect(submitInput(cfg, dir, { kind: 'approve' }, bus)).rejects.toBeInstanceOf(CheckpointMismatchError)
    expect(await loadState(dir)).toEqual(waiting)
  })

  it('rejects a secret name that is not ENV_STYLE before writing anything', async () => {
    const dir = await newProject()
    expect(await runner(dir).runUntilBlocked()).toBe('waiting') // at answers
    const before = await loadState(dir)
    await expect(
      submitInput(cfg, dir, { kind: 'answers', answers: { q1: 'x' }, secrets: { 'OK\nEVIL': 'secret-value-1' } }, bus),
    ).rejects.toThrow(/invalid secret name/)
    expect(await loadState(dir)).toEqual(before)
    expect(existsSync(join(dir, '.env'))).toBe(false)
    expect(existsSync(projectPaths(dir).answers)).toBe(false)
  })

  it('does not write .env when no secrets are given, and emits the new state', async () => {
    const dir = await newProject()
    expect(await runner(dir).runUntilBlocked()).toBe('waiting')
    const states: ProjectState[] = []
    bus.on('state', (_id: string, s: ProjectState) => states.push(s))
    const s = await submitInput(cfg, dir, { kind: 'answers', answers: { q1: 'yes' }, secrets: {} }, bus)
    expect(s.phase).toBe('spec')
    expect(await loadState(dir)).toEqual(s)
    expect(states).toEqual([s])
    expect(existsSync(join(dir, '.env'))).toBe(false)
  })

  it('a plan without UI needs no design choice even if design options are left over', async () => {
    const dir = await newProject()
    const r = runner(dir)
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'answers', answers: {}, secrets: {} }, bus)
    expect(await r.runUntilBlocked()).toBe('waiting')
    await submitInput(cfg, dir, { kind: 'approve' }, bus)
    expect(await r.runUntilBlocked()).toBe('waiting') // at plan; builtin plan has hasUI false
    const p = projectPaths(dir)
    await writeFile(join(p.designDir, 'a.html'), '<p>a</p>')
    await writeFile(join(p.designDir, 'b.html'), '<p>b</p>')
    await writeFile(p.designOptions, JSON.stringify({
      options: [
        { id: 'a', title: 'A', description: 'a', file: 'a.html' },
        { id: 'b', title: 'B', description: 'b', file: 'b.html' },
      ],
    }))
    expect((await submitInput(cfg, dir, { kind: 'approve' }, bus)).phase).toBe('build')
  })

  it('«continue» after help in build commits the user\'s manual fix so the reviewer sees it', async () => {
    const dir = await newProject()
    const r = runner(dir)
    await toBuild(r, dir)
    await script({ implementer: ['crash', 'crash', 'crash'] })
    expect(await r.runUntilBlocked()).toBe('waiting')
    expect((await loadState(dir)).phase).toBe('needs_help')
    await writeFile(join(dir, 'fixed-by-hand.txt'), 'manual fix\n')
    await submitInput(cfg, dir, { kind: 'help', action: 'continue' }, bus)
    expect(await gitLog(dir)).toMatch(/task-t1: manual fix by user/)
    expect((await execGit(dir, 'status', '--porcelain')).trim()).toBe('')
    const { taskBase } = await loadState(dir)
    expect(await execGit(dir, 'diff', `${taskBase}..HEAD`, '--name-only')).toContain('fixed-by-hand.txt')
  })

  it('a help retry with a clean tree makes no commit', async () => {
    const dir = await newProject()
    const r = runner(dir)
    await toBuild(r, dir)
    await script({ implementer: ['crash', 'crash', 'crash'] })
    expect(await r.runUntilBlocked()).toBe('waiting')
    const before = await gitLog(dir)
    await submitInput(cfg, dir, { kind: 'help', action: 'retry' }, bus)
    expect(await gitLog(dir)).toBe(before)
  })

  it('demo comments append a feedback milestone to the saved plan', async () => {
    const dir = await newProject()
    const r = runner(dir)
    await toBuild(r, dir)
    expect(await r.runUntilBlocked()).toBe('waiting') // at demo
    await submitInput(cfg, dir, { kind: 'demo', comments: 'Make it blue' }, bus)
    const plan = JSON.parse(await readFile(projectPaths(dir).plan, 'utf8'))
    expect(plan.milestones.at(-1).tasks[0]).toMatchObject({ id: 'fb-1', description: 'Make it blue' })
  })
})

describe('verdictNotes', () => {
  it('takes notes, and issues of a passing verdict (the older contract), skipping blanks', () => {
    expect(verdictNotes({ pass: true, issues: ['old-style note'], notes: ['a', '  '] })).toEqual(['a', 'old-style note'])
    expect(verdictNotes({ pass: false, issues: ['defect'], notes: ['n'] })).toEqual(['n'])
  })
})
