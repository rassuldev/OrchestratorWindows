import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Config } from '../../src/config.js'
import { runClaude } from '../../src/agents/runClaude.js'
import { appRunner, stopAll } from '../../src/core/appRunner.js'
import { EventBus } from '../../src/core/events.js'
import { ProjectRunner, type RunStatus } from '../../src/core/pipeline.js'
import { Scheduler } from '../../src/core/scheduler.js'
import type { ProjectState } from '../../src/core/schemas.js'
import { CheckpointMismatchError } from '../../src/core/stateMachine.js'
import { createProject, loadState, saveState } from '../../src/core/store.js'

const ROOT = resolve(import.meta.dirname, '../..')
const FAKE = join(ROOT, 'test/fixtures/fake-claude.mjs')

let workspace: string
let cfg: Config
let bus: EventBus
let scheduler: Scheduler | null

beforeEach(async () => {
  vi.stubEnv('ORCH_NO_KEEP_AWAKE', '1')
  vi.stubEnv('ORCH_NO_NOTIFY', '1')
  workspace = await mkdtemp(join(tmpdir(), 'orch-scheduler-'))
  cfg = { orchestratorRoot: ROOT, workspace, port: 4321, claudeBin: FAKE, stepTimeoutMin: 1 }
  bus = new EventBus()
  scheduler = null
})

afterEach(async () => {
  await stopAll()
  scheduler?.stop()
  await scheduler?.idle()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(workspace, { recursive: true, force: true })
})

async function project(name: string, patch: Partial<ProjectState> = {}): Promise<string> {
  const { dir, state } = await createProject(cfg, { name, task: 'Make a CLI' })
  await saveState(dir, { ...state, ...patch })
  return dir
}

type StubRun = (dir: string, signal: AbortSignal) => Promise<RunStatus>

/** A runnerFactory whose runners call `run`; records every runner created. */
function stubFactory(run: StubRun) {
  const created: { dir: string; abort: ReturnType<typeof vi.fn> }[] = []
  const factory = (dir: string) => {
    const controller = new AbortController()
    const abort = vi.fn(() => controller.abort())
    created.push({ dir, abort })
    return { runUntilBlocked: () => run(dir, controller.signal), abort } as unknown as ProjectRunner
  }
  return { factory, created }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

function untilAborted(signal: AbortSignal): Promise<RunStatus> {
  return new Promise((res) => signal.addEventListener('abort', () => res('paused'), { once: true }))
}

/** Real runner against the fake CLI, with FAKE_* env vars for this test. */
function realFactory(fakeEnv: NodeJS.ProcessEnv) {
  const run: typeof runClaude = (opts) => runClaude({ ...opts, env: { ...opts.env, ...fakeEnv } })
  return (dir: string) => new ProjectRunner(cfg, dir, { bus, run, notify: () => {} })
}

async function prompts(file: string): Promise<string[]> {
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  return lines.map((l) => {
    const argv: string[] = JSON.parse(l)
    return argv[argv.indexOf('-p') + 1]
  })
}

describe('Scheduler.start', () => {
  it('start() leaves a project waiting at a checkpoint untouched', async () => {
    const dir = await project('waiting', {
      phase: 'await_spec',
      checkpoint: { kind: 'spec', message: 'Approve the spec' },
    })
    const before = await loadState(dir)
    const { factory, created } = stubFactory(async () => 'waiting')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await scheduler.start()
    await scheduler.idle()
    expect(created).toHaveLength(0)
    expect(await loadState(dir)).toEqual(before)
  })

  it('start() ignores paused, errored and done projects', async () => {
    await project('paused', { paused: true })
    await project('errored', { error: 'boom' })
    await project('finished', { phase: 'done' })
    const { factory, created } = stubFactory(async () => 'waiting')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await scheduler.start()
    await scheduler.idle()
    expect(created).toHaveLength(0)
  })

  it('start() enqueues a build-phase project whose plan.json is invalid (the runner fails the attempt)', async () => {
    const dir = await project('broken-plan', { phase: 'build' })
    await writeFile(join(dir, '.orchestrator/plan.json'), '{ nope')
    const { factory, created } = stubFactory(async () => 'waiting')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await scheduler.start()
    await scheduler.idle()
    expect(created.map((c) => c.dir)).toEqual([dir])
    expect(error).not.toHaveBeenCalled()
  })

  it('start() resumes an interrupted project', async () => {
    const dir = await project('interrupted')
    const s = await loadState(dir)
    const stuck = '1700000000000-analyst_questions'
    await saveState(dir, {
      ...s,
      currentStepId: stuck,
      steps: [{ id: stuck, role: 'analyst_questions', label: 'Вопросы аналитика', attempt: 1, status: 'running', startedAt: new Date().toISOString() }],
    })
    const argv = join(workspace, 'argv.jsonl')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: realFactory({ FAKE_ARGV_FILE: argv }) })
    await scheduler.start()
    await scheduler.idle()

    const after = await loadState(dir)
    expect(after.steps.map((st) => st.status)).toEqual(['interrupted', 'ok'])
    expect(after.phase).toBe('await_answers')
    expect(after.currentStepId).toBeNull()
    expect((await prompts(argv))[0]).toContain('was interrupted')
  })

  it('start() enqueues a project with an interrupted step even when it is paused', async () => {
    const dir = await project('paused-mid-step', { paused: true, currentStepId: 'x' })
    const { factory, created } = stubFactory(async () => 'paused')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await scheduler.start()
    await scheduler.idle()
    expect(created.map((c) => c.dir)).toEqual([dir])
  })

  it('start() clears a past limitUntil and enqueues the project', async () => {
    const dir = await project('limit-past', { limitUntil: new Date(Date.now() - 1000).toISOString(), limitHits: 1 })
    const seen: (string | null)[] = []
    const { factory } = stubFactory(async (d) => {
      seen.push((await loadState(d)).limitUntil)
      return 'waiting'
    })
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await scheduler.start()
    await scheduler.idle()
    expect(seen).toEqual([null])
    expect((await loadState(dir)).limitUntil).toBeNull()
  })

  it('start() waits for a future limitUntil, then clears it and enqueues', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const until = new Date(Date.now() + 10 * 60_000).toISOString()
    const dir = await project('limit-future', { limitUntil: until })
    const { factory, created } = stubFactory(async () => 'waiting')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await scheduler.start()
    await scheduler.idle()
    expect(created).toHaveLength(0)
    expect((await loadState(dir)).limitUntil).toBe(until)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await scheduler.idle()
    expect(created.map((c) => c.dir)).toEqual([dir])
    expect((await loadState(dir)).limitUntil).toBeNull()
  })
})

describe('Scheduler queue', () => {
  it('runs projects one at a time in FIFO order', async () => {
    const a = await project('a')
    const b = await project('b')
    const c = await project('c')
    const events: string[] = []
    const active: (string | null)[] = []
    const { factory } = stubFactory(async (dir) => {
      const name = dir.split('/').at(-1)!
      events.push(`start ${name}`)
      active.push(scheduler!.activeDir())
      await sleep(name === 'a' ? 30 : 5)
      events.push(`end ${name}`)
      return 'waiting'
    })
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    scheduler.enqueue(a)
    scheduler.enqueue(b)
    scheduler.enqueue(c)
    scheduler.enqueue(b) // duplicate
    await scheduler.idle()
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(active).toEqual([a, b, c])
    expect(scheduler.activeDir()).toBeNull()
  })

  it('an active project enqueued again runs once more after it finishes', async () => {
    const a = await project('a')
    let runs = 0
    const { factory } = stubFactory(async () => {
      runs++
      if (runs === 1) {
        scheduler!.enqueue(a)
        scheduler!.enqueue(a)
      }
      return 'waiting'
    })
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    scheduler.enqueue(a)
    await scheduler.idle()
    expect(runs).toBe(2)
  })

  it('a runner that throws does not stop the queue', async () => {
    const a = await project('a')
    const b = await project('b')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ran: string[] = []
    const { factory } = stubFactory(async (dir) => {
      ran.push(dir)
      if (dir === a) throw new Error('kaboom')
      return 'waiting'
    })
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    scheduler.enqueue(a)
    scheduler.enqueue(b)
    await scheduler.idle()
    expect(ran).toEqual([a, b])
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0].join(' '))).toContain('kaboom')
  })

  it('a runner that throws leaves the project in error with its step closed, not "queued" forever', async () => {
    const stuck = '1700000000000-analyst_questions'
    const dir = await project('thrower', {
      currentStepId: stuck,
      steps: [{ id: stuck, role: 'analyst_questions', label: 'Вопросы аналитика', attempt: 1, status: 'running', startedAt: new Date().toISOString() }],
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const states: ProjectState[] = []
    bus.on('state', (_id: string, s: ProjectState) => states.push(s))
    const { factory } = stubFactory(async () => {
      throw new Error('kaboom')
    })
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    scheduler.enqueue(dir)
    await scheduler.idle()
    const s = await loadState(dir)
    expect(s.error).toContain('kaboom')
    expect(s.currentStepId).toBeNull()
    expect(s.steps[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('kaboom') })
    expect(s.steps[0].endedAt).toBeDefined()
    expect(states.at(-1)?.error).toContain('kaboom')

    // «Продолжить» clears the error and runs it again
    const { factory: ok, created } = stubFactory(async () => 'waiting')
    scheduler.stop()
    scheduler = new Scheduler(cfg, bus, { runnerFactory: ok })
    await scheduler.resume(dir)
    await scheduler.idle()
    expect((await loadState(dir)).error).toBeNull()
    expect(created).toHaveLength(1)
  })

  it('input() submits the answer and enqueues the project', async () => {
    const dir = await project('input', { phase: 'await_spec', checkpoint: { kind: 'spec', message: 'Approve the spec' } })
    const { factory, created } = stubFactory(async () => 'waiting')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    const state = await scheduler.input(dir, { kind: 'approve' })
    expect(state.phase).toBe('plan')
    expect((await loadState(dir)).phase).toBe('plan')
    await scheduler.idle()
    expect(created.map((c) => c.dir)).toEqual([dir])
  })
})

describe('Scheduler pause/resume', () => {
  it('pause aborts the active runner; resume clears flags and enqueues', async () => {
    const dir = await project('p')
    const states: ProjectState[] = []
    bus.on('state', (_id, s: ProjectState) => states.push(s))
    let hang = true
    const { factory, created } = stubFactory(async (_d, signal) => (hang ? untilAborted(signal) : 'waiting'))
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    scheduler.enqueue(dir)
    await vi.waitFor(() => expect(scheduler!.activeDir()).toBe(dir))

    await scheduler.pause(dir)
    expect(created[0].abort).toHaveBeenCalledTimes(1)
    expect((await loadState(dir)).paused).toBe(true)
    expect(states.at(-1)?.paused).toBe(true)
    await scheduler.idle()
    expect(created).toHaveLength(1)

    const s = await loadState(dir)
    await saveState(dir, { ...s, error: 'old error', limitUntil: new Date(Date.now() + 60_000).toISOString() })
    hang = false
    await scheduler.resume(dir)
    const after = await loadState(dir)
    expect(after).toMatchObject({ paused: false, error: null, limitUntil: null })
    expect(states.at(-1)?.paused).toBe(false)
    await scheduler.idle()
    expect(created.map((c) => c.dir)).toEqual([dir, dir])
  })

  it('pause keeps the project paused even if the runner saved over the flag', async () => {
    const dir = await project('race')
    const { factory } = stubFactory(async (d, signal) => {
      await untilAborted(signal)
      // the runner was mid-save with state loaded before the pause
      await saveState(d, { ...(await loadState(d)), paused: false })
      return 'paused'
    })
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    scheduler.enqueue(dir)
    await vi.waitFor(() => expect(scheduler!.activeDir()).toBe(dir))
    await scheduler.pause(dir)
    await scheduler.idle()
    expect((await loadState(dir)).paused).toBe(true)
  })

  it('pause aborts the real runner; resume continues from the same step', async () => {
    const dir = await project('real')
    const scriptFile = join(workspace, 'script.json')
    await writeFile(scriptFile, JSON.stringify({ analyst_questions: ['hang'] }))
    const argv = join(workspace, 'argv.jsonl')
    scheduler = new Scheduler(cfg, bus, {
      runnerFactory: realFactory({ FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_ARGV_FILE: argv }),
    })
    scheduler.enqueue(dir)
    await vi.waitFor(async () => expect((await loadState(dir)).currentStepId).not.toBeNull(), { timeout: 5000 })
    await sleep(200) // let the fake CLI start

    await scheduler.pause(dir)
    await scheduler.idle()
    const paused = await loadState(dir)
    expect(paused.paused).toBe(true)
    expect(paused.currentStepId).toBe(paused.steps[0].id)
    expect(paused.steps[0].status).toBe('running')

    await scheduler.resume(dir)
    await scheduler.idle()
    const after = await loadState(dir)
    expect(after.steps.map((st) => [st.role, st.status])).toEqual([
      ['analyst_questions', 'interrupted'],
      ['analyst_questions', 'ok'],
    ])
    expect(after.phase).toBe('await_answers')
    expect((await prompts(argv))[1]).toContain('was interrupted')
  }, 15_000)
})

describe('Scheduler and the demo app', () => {
  const app = `node -e "console.log('http://localhost:5198'); setInterval(() => {}, 1000)"`

  it('accepting the demo stops the app at once', async () => {
    const dir = await project('demo', { phase: 'await_demo', checkpoint: { kind: 'demo', message: 'Review the MVP demo' } })
    await writeFile(join(dir, '.orchestrator/plan.json'), JSON.stringify({
      platform: 'cli', hasUI: false, runCommand: 'x', testCommand: 'y',
      milestones: [{ id: 'm1', title: 'a', mvp: true, tasks: [{ id: 't1', title: 't', description: 'd', acceptance: ['a'], verify: [] }] }],
    }))
    await appRunner.start(dir, app)
    const { factory } = stubFactory(async () => 'waiting')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await scheduler.input(dir, { kind: 'demo', comments: '' })
    expect(appRunner.status(dir).running).toBe(false)
  })

  it('pausing a project stops its app', async () => {
    const dir = await project('paused-app', { phase: 'await_demo', checkpoint: { kind: 'demo', message: 'Review the MVP demo' } })
    await appRunner.start(dir, app)
    scheduler = new Scheduler(cfg, bus, { runnerFactory: stubFactory(async () => 'waiting').factory })
    await scheduler.pause(dir)
    expect(appRunner.status(dir).running).toBe(false)
  })
})

describe('Scheduler rate limits', () => {
  it('rate-limited project is re-enqueued after limitUntil', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const a = await project('a')
    const b = await project('b')
    const ran: string[] = []
    const { factory } = stubFactory(async (dir) => {
      ran.push(dir)
      const s = await loadState(dir)
      if (dir === a && ran.length === 1) {
        await saveState(dir, { ...s, limitUntil: new Date(Date.now() + 10 * 60_000).toISOString(), limitHits: 1 })
        return 'rate_limited'
      }
      return 'waiting'
    })
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    scheduler.enqueue(a)
    scheduler.enqueue(b)
    await scheduler.idle()
    expect(ran).toEqual([a, b]) // the limited project does not block the queue

    await vi.advanceTimersByTimeAsync(9 * 60_000)
    await scheduler.idle()
    expect(ran).toEqual([a, b])

    await vi.advanceTimersByTimeAsync(60_000)
    await scheduler.idle()
    expect(ran).toEqual([a, b, a])
    expect((await loadState(a)).limitUntil).toBeNull()
  })

  it('turning pauseOnLimit on while waiting out a limit pauses now and cancels the retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const dir = await project('limited-toggle', { limitUntil: new Date(Date.now() + 60_000).toISOString() })
    const { factory, created } = stubFactory(async () => 'waiting')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await scheduler.start()
    await scheduler.setPauseOnLimit(dir, true)
    expect(await loadState(dir)).toMatchObject({ pauseOnLimit: true, paused: true, limitUntil: null })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    await scheduler.idle()
    expect(created).toHaveLength(0)

    await scheduler.setPauseOnLimit(dir, false)
    expect(await loadState(dir)).toMatchObject({ pauseOnLimit: false, paused: true }) // stays paused until «Продолжить»
  })

  it('stop() cancels pending limit timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const until = new Date(Date.now() + 60_000).toISOString()
    const dir = await project('limited', { limitUntil: until })
    const { factory, created } = stubFactory(async () => 'waiting')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await scheduler.start()
    scheduler.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    await scheduler.idle()
    expect(created).toHaveLength(0)
    expect((await loadState(dir)).limitUntil).toBe(until)
  })
})

describe('Scheduler per-project locking', () => {
  it('two parallel approves: exactly one applies, the other is a checkpoint mismatch', async () => {
    const dir = await project('Locked', { phase: 'await_spec', checkpoint: { kind: 'spec', message: 'm' } })
    const { factory } = stubFactory(async () => 'waiting')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    const results = await Promise.allSettled([
      scheduler.input(dir, { kind: 'approve' }),
      scheduler.input(dir, { kind: 'approve' }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(CheckpointMismatchError)
    expect(await loadState(dir)).toMatchObject({ phase: 'plan', checkpoint: null })
  })

  it('a failing locked call does not block later ones', async () => {
    const dir = await project('Locked2', { phase: 'await_spec', checkpoint: { kind: 'spec', message: 'm' } })
    const { factory } = stubFactory(async () => 'waiting')
    scheduler = new Scheduler(cfg, bus, { runnerFactory: factory })
    await expect(scheduler.input(dir, { kind: 'demo', comments: '' })).rejects.toBeInstanceOf(CheckpointMismatchError)
    expect((await scheduler.input(dir, { kind: 'approve' })).phase).toBe('plan')
  })
})
