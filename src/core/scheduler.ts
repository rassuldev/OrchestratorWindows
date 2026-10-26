import type { Config } from '../config.js'
import { appRunner } from './appRunner.js'
import type { EventBus } from './events.js'
import { keepAwake, notify } from './notify.js'
import { ProjectRunner, submitInput, type RunStatus } from './pipeline.js'
import type { ProjectState, UserInput } from './schemas.js'
import { maskSecrets, readSecretValues } from './secrets.js'
import { nextAction } from './stateMachine.js'
import { listProjects, loadPlanSafe, loadState, saveState } from './store.js'

export type SchedulerDeps = {
  runnerFactory?: (dir: string) => ProjectRunner
}

/** Whether the project has an agent step to run; a build without a readable plan does (the runner fails it). */
async function wantsRun(dir: string, state: ProjectState): Promise<boolean> {
  const { plan } = await loadPlanSafe(dir)
  if (state.phase === 'build' && plan === null) return !state.paused && state.limitUntil === null && state.error === null
  return nextAction(state, plan).kind === 'run'
}

type Active = { dir: string; runner: ProjectRunner; done: Promise<void> }

/**
 * Runs projects one at a time from a FIFO queue, recovers interrupted projects on start,
 * re-enqueues rate-limited ones when their limit expires, and handles pause/resume.
 */
export class Scheduler {
  private readonly runnerFactory: (dir: string) => ProjectRunner
  private readonly queue: string[] = []
  private active: Active | null = null
  private loop: Promise<void> | null = null
  private readonly limitTimers = new Map<string, NodeJS.Timeout>()
  /** In-flight async work outside the loop (limit clears), so `idle()` can wait for it. */
  private readonly pending = new Set<Promise<void>>()
  /** Tail of each project's mutation chain: user input, pause, resume and limit clears run one at a time. */
  private readonly locks = new Map<string, Promise<void>>()
  private stopped = false

  constructor(
    private readonly cfg: Config,
    private readonly bus: EventBus,
    deps: SchedulerDeps = {},
  ) {
    this.runnerFactory = deps.runnerFactory ?? ((dir) => new ProjectRunner(cfg, dir, { bus, notify }))
  }

  /** Enqueues runnable and interrupted projects; schedules rate-limited ones for when the limit expires. */
  async start(): Promise<void> {
    for (const { dir, state } of await listProjects(this.cfg)) {
      try {
        if (state.limitUntil !== null) {
          await this.track(this.scheduleLimit(dir, state.limitUntil))
        } else if (state.currentStepId !== null || (await wantsRun(dir, state))) {
          this.enqueue(dir)
        }
      } catch (e) {
        console.error(`Scheduler: cannot recover ${dir}:`, e)
      }
    }
  }

  /**
   * Adds a project to the queue and starts the loop if it is idle. No duplicates in the queue;
   * the active project may be queued once more (it re-checks its state after the current run).
   */
  enqueue(dir: string): void {
    if (this.stopped || this.queue.includes(dir)) return
    this.queue.push(dir)
    this.loop ??= this.drain()
  }

  async input(dir: string, input: UserInput): Promise<ProjectState> {
    return this.locked(dir, async () => {
      const state = await submitInput(this.cfg, dir, input, this.bus)
      if (input.kind === 'demo') await appRunner.stop(dir) // the demo is over; free its port and database
      this.enqueue(dir)
      return state
    })
  }

  async pause(dir: string): Promise<void> {
    await appRunner.stop(dir)
    await this.update(dir, (s) => {
      s.paused = true
    })
    const idx = this.queue.indexOf(dir)
    if (idx !== -1) this.queue.splice(idx, 1)
    const active = this.active
    if (active?.dir !== dir) return
    active.runner.abort()
    await active.done
    // The runner may have saved state it loaded before the pause; make sure the flag stuck.
    if (!(await loadState(dir)).paused) {
      await this.update(dir, (s) => {
        s.paused = true
      })
    }
  }

  /** Clears `paused`, `error` and `limitUntil` (resume means "try now") and enqueues the project. */
  async resume(dir: string): Promise<void> {
    this.clearLimitTimer(dir)
    if (this.active?.dir === dir) await this.active.done
    await this.update(dir, (s) => {
      s.paused = false
      s.error = null
      s.limitUntil = null
    })
    this.enqueue(dir)
  }

  /** Turning it on while a limit is being waited out pauses the project now instead of at the next hit. */
  async setPauseOnLimit(dir: string, enabled: boolean): Promise<void> {
    if (enabled) this.clearLimitTimer(dir)
    await this.update(dir, (s) => {
      s.pauseOnLimit = enabled
      if (enabled && s.limitUntil !== null) {
        s.limitUntil = null
        s.paused = true
      }
    })
  }

  activeDir(): string | null {
    return this.active?.dir ?? null
  }

  /** Resolves when the queue is empty, nothing is running and no limit clear is in flight. */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.pending, ...(this.loop ? [this.loop] : [])]
      if (busy.length === 0) return
      await Promise.allSettled(busy)
    }
  }

  /** Cancels limit timers, drops the queue and aborts the active runner (its step resumes on next start). */
  stop(): void {
    this.stopped = true
    for (const timer of this.limitTimers.values()) clearTimeout(timer)
    this.limitTimers.clear()
    this.queue.length = 0
    this.active?.runner.abort()
  }

  private async drain(): Promise<void> {
    await null // return to enqueue first, so `loop` is set before any runner starts
    for (let dir = this.queue.shift(); dir !== undefined; dir = this.queue.shift()) {
      await this.runOne(dir)
    }
    this.loop = null // same synchronous turn as the empty-queue check: no enqueue can slip between
  }

  private async runOne(dir: string): Promise<void> {
    let finish!: () => void
    const done = new Promise<void>((res) => (finish = res))
    keepAwake.acquire()
    try {
      const runner = this.runnerFactory(dir)
      this.active = { dir, runner, done }
      const status: RunStatus = await runner.runUntilBlocked()
      if (status === 'rate_limited' && !this.stopped) {
        const { limitUntil } = await loadState(dir)
        if (limitUntil !== null) await this.scheduleLimit(dir, limitUntil)
      }
    } catch (e) {
      console.error(`Scheduler: run of ${dir} failed:`, e)
      await this.recordCrash(dir, e).catch((err: unknown) => console.error(`Scheduler: cannot record the failure of ${dir}:`, err))
    } finally {
      this.active = null
      keepAwake.release()
      finish()
    }
  }

  /**
   * A runner that threw would otherwise leave the project looking "queued" forever: show the error
   * (cleared by «Продолжить») and close the step it was running.
   */
  private async recordCrash(dir: string, e: unknown): Promise<void> {
    const secrets = await readSecretValues(dir).catch(() => [])
    const message = maskSecrets(`Внутренняя ошибка: ${e instanceof Error ? e.message : String(e)}`, secrets)
    await this.update(dir, (s) => {
      const step = s.steps.find((st) => st.id === s.currentStepId)
      if (step) Object.assign(step, { status: 'failed', endedAt: new Date().toISOString(), error: message })
      if (s.currentStepId !== null) s.resumeNote = true // the step may have left partial work
      s.currentStepId = null
      s.error = message
    })
  }

  /** Clears `limitUntil` and enqueues the project now if it has passed, otherwise when it does. */
  private async scheduleLimit(dir: string, limitUntil: string): Promise<void> {
    this.clearLimitTimer(dir)
    const delay = Date.parse(limitUntil) - Date.now()
    if (!(delay > 0)) return this.clearLimit(dir)
    const timer = setTimeout(() => {
      this.limitTimers.delete(dir)
      void this.track(this.clearLimit(dir))
    }, delay)
    this.limitTimers.set(dir, timer)
  }

  private async clearLimit(dir: string): Promise<void> {
    try {
      await this.update(dir, (s) => {
        s.limitUntil = null
      })
      this.enqueue(dir)
    } catch (e) {
      console.error(`Scheduler: cannot clear the rate limit of ${dir}:`, e)
    }
  }

  private clearLimitTimer(dir: string): void {
    const timer = this.limitTimers.get(dir)
    if (timer) clearTimeout(timer)
    this.limitTimers.delete(dir)
  }

  /** Serialised read-modify-write of a project's state. */
  private update(dir: string, change: (s: ProjectState) => void): Promise<void> {
    return this.locked(dir, async () => {
      const s = await loadState(dir)
      change(s)
      await saveState(dir, s)
      this.bus.emitState(s.id, s)
    })
  }

  /** Runs `fn` after every earlier `locked` call for the same project has settled (never held across a step). */
  private locked<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(dir) ?? Promise.resolve()).then(fn)
    const tail = run.then(
      () => {},
      () => {},
    )
    this.locks.set(dir, tail)
    void tail.then(() => {
      if (this.locks.get(dir) === tail) this.locks.delete(dir)
    })
    return run
  }

  private track(p: Promise<void>): Promise<void> {
    this.pending.add(p)
    return p.finally(() => this.pending.delete(p))
  }
}
