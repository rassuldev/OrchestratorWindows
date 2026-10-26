import { appendFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config.js'
import { buildPrompt } from '../agents/prompts.js'
import { runClaude, type RunResult } from '../agents/runClaude.js'
import { appRunner } from './appRunner.js'
import type { EventBus } from './events.js'
import { commitAll, headCommit, revertUncommitted } from './git.js'
import { validateOutputs } from './outputs.js'
import { projectPaths } from './paths.js'
import { DesignOptionsSchema, type Plan, type ProjectState, type Role, type StepRecord, type Task, type UserInput } from './schemas.js'
import { assertEnvKeys, maskSecrets, readSecretValues, writeEnv } from './secrets.js'
import { SUBSTEP_ROLE, applyStepOutcome, applyUserInput, flattenTasks, nextAction, type StepOutcome } from './stateMachine.js'
import { loadPlanSafe, loadState, readJson, savePlan, saveState } from './store.js'

export type RunStatus = 'waiting' | 'done' | 'paused' | 'rate_limited' | 'error'

export type RunnerDeps = {
  bus: EventBus
  run?: typeof runClaude
  notify?: (title: string, msg: string) => void
}

const AUTH_ERROR =
  'Claude CLI не авторизован: запустите `claude` в терминале и выполните /login, затем нажмите «Продолжить».'
const LIMIT_BACKOFF_MIN = [10, 20, 40, 60]
const NO_CHANGES = 'No changes were made to the project'
const NOTIFY_TITLE = 'Orchestrator'

const ROLE_LABELS: Record<Role, string> = {
  analyst_questions: 'Вопросы аналитика',
  analyst_spec: 'Спецификация',
  architect: 'Архитектура и план',
  designer: 'Дизайн',
  implementer: 'исполнитель',
  verifier: 'проверка',
  reviewer: 'ревью',
  finalizer: 'Финализация',
}

function stepLabel(role: Role, attempt: number, task?: { id: string; title: string }): string {
  if (task) return `Задача ${task.id}: ${task.title} — ${ROLE_LABELS[role]} (попытка ${attempt})`
  return attempt > 1 ? `${ROLE_LABELS[role]} (попытка ${attempt})` : ROLE_LABELS[role]
}

function findStep(s: ProjectState, id: string): StepRecord {
  const step = s.steps.find((st) => st.id === id)
  if (!step) throw new Error(`step ${id} not found in state`)
  return step
}

function recordUsage(step: StepRecord, result: RunResult): void {
  if (result.result?.total_cost_usd !== undefined) step.costUsd = result.result.total_cost_usd
  if (result.result?.session_id !== undefined) step.sessionId = result.result.session_id
}

const now = () => new Date().toISOString()

const MAX_LISTED_PATHS = 10

/**
 * Verifier and reviewer only check: project files they changed are reverted (so the reviewed diff
 * stays the implementer's) and the attempt fails with an issue, so the implementer does it properly.
 */
async function rejectCheckerEdits(dir: string, role: 'verifier' | 'reviewer', outcome: StepOutcome): Promise<StepOutcome> {
  const paths = await revertUncommitted(dir)
  if (paths.length === 0) return outcome
  const listed = paths.slice(0, MAX_LISTED_PATHS).join(', ') + (paths.length > MAX_LISTED_PATHS ? ', …' : '')
  const issue =
    `The ${role} changed project files (${listed}); the changes were reverted. ` +
    'Make any needed fix in the implementation yourself; add generated artifacts (test results, coverage) to .gitignore.'
  if (!outcome.ok) return { ok: false, error: `${outcome.error}\n${issue}` }
  return { ok: true, verdict: { ...(outcome.verdict ?? { issues: [] }), pass: false, issues: [...(outcome.verdict?.issues ?? []), issue] } }
}

/** Drives one project's agent steps until it needs the user, hits a limit, fails hard, or finishes. */
export class ProjectRunner {
  private readonly run: typeof runClaude
  private readonly notify: (title: string, msg: string) => void
  private controller = new AbortController()

  constructor(
    private readonly cfg: Config,
    private readonly dir: string,
    private readonly deps: RunnerDeps,
  ) {
    this.run = deps.run ?? runClaude
    // Task 8 wires the real notifier in the scheduler.
    this.notify = deps.notify ?? (() => {})
  }

  /** Stops the running agent; its step stays current, so the next run treats it as interrupted. */
  abort(): void {
    this.controller.abort()
  }

  async runUntilBlocked(): Promise<RunStatus> {
    this.controller = new AbortController()
    const { signal } = this.controller
    for (;;) {
      if (signal.aborted) return 'paused'
      const status = await this.step(signal)
      if (status) return status
    }
  }

  private async save(s: ProjectState): Promise<void> {
    await saveState(this.dir, s)
    this.deps.bus.emitState(s.id, s)
  }

  /** One loop iteration; returns a status when the loop must stop. */
  private async step(signal: AbortSignal): Promise<RunStatus | null> {
    const { dir } = this
    let s = await loadState(dir)
    // An invalid plan.json must never throw out of the loop: outside build it counts as no plan
    // (the architect's validation fails and retries), in build it fails the attempt below.
    const { plan, error: planError } = await loadPlanSafe(dir)

    if (s.currentStepId !== null) {
      const interrupted = s.steps.find((st) => st.id === s.currentStepId)
      if (interrupted) Object.assign(interrupted, { status: 'interrupted', endedAt: now() })
      s.resumeNote = true
      s.currentStepId = null
      await this.save(s)
    }

    const blocked = s.paused || s.limitUntil !== null || s.error !== null
    if (s.phase === 'build' && plan === null && !blocked) {
      const stepId = await this.startStep(s, SUBSTEP_ROLE[s.subStep])
      const secrets = await readSecretValues(dir).catch(() => [])
      const error = `Internal error: ${planError ?? '.orchestrator/plan.json is missing'}`
      return this.finish(stepId, { ok: false, error }, secrets)
    }

    const action = nextAction(s, plan)
    if (action.kind === 'done') return 'done'
    if (action.kind === 'wait') {
      if (s.paused) return 'paused'
      if (s.limitUntil !== null) return 'rate_limited'
      if (s.error !== null) return 'error'
      return 'waiting'
    }

    const { role } = action
    const task = action.taskId ? flattenTasks(plan!).find((t) => t.id === action.taskId) : undefined
    if (role === 'implementer' && s.taskBase === null) s.taskBase = await headCommit(dir)
    const stepId = await this.startStep(s, role, task)

    try {
      return await this.execute(s, plan, role, task, stepId, signal)
    } catch (e) {
      // Never leave the step current after an unexpected error: that would re-run it as
      // "interrupted" forever without consuming an attempt.
      const secrets = await readSecretValues(this.dir).catch(() => [])
      return await this.finish(stepId, { ok: false, error: `Internal error: ${(e as Error).message}` }, secrets)
    }
  }

  /** Records a new running step as current, saves, and returns its id. */
  private async startStep(s: ProjectState, role: Role, task?: Task): Promise<string> {
    // The demo app must not hold its port or database while agents build and verify.
    await appRunner.stop(this.dir)
    const baseId = `${Date.now()}-${role}`
    let stepId = baseId
    for (let n = 2; s.steps.some((st) => st.id === stepId); n++) stepId = `${baseId}-${n}`
    s.steps.push({
      id: stepId,
      role,
      label: stepLabel(role, s.attempt, task),
      ...(task ? { taskId: task.id } : {}),
      attempt: s.attempt,
      status: 'running',
      startedAt: now(),
    })
    s.currentStepId = stepId
    await this.save(s)
    return stepId
  }

  /** Runs the agent for an already-recorded step and applies its outcome. */
  private async execute(
    s: ProjectState,
    plan: Plan | null,
    role: Role,
    task: Task | undefined,
    stepId: string,
    signal: AbortSignal,
  ): Promise<RunStatus | null> {
    const { dir, cfg } = this
    const projectId = s.id
    const secrets = await readSecretValues(dir)
    const mask = (text: string) => maskSecrets(text, secrets)
    let built: Awaited<ReturnType<typeof buildPrompt>> | null = null
    let promptError: string | null = null
    try {
      built = await buildPrompt(role, { dir, state: s, plan, orchestratorRoot: cfg.orchestratorRoot })
    } catch (e) {
      promptError = `Could not build the prompt: ${(e as Error).message}`
    }

    let result: RunResult | null = null
    if (built) {
      // A verdict left by an earlier run with the same attempt number must not count as this run's.
      if (built.verdictFile) await rm(built.verdictFile, { force: true })
      const logFile = join(projectPaths(dir).logsDir, `${stepId}.jsonl`)
      let logWarned = false
      result = await this.run({
        cfg,
        cwd: dir,
        systemPrompt: built.system,
        prompt: built.prompt,
        signal,
        timeoutMs: cfg.stepTimeoutMin * 60_000,
        mask,
        onEntry: (e) => {
          // Runs inside runClaude's stream handlers: a logging failure must never throw there.
          try {
            const masked = { ...e, text: mask(e.text) }
            try {
              appendFileSync(logFile, JSON.stringify(masked) + '\n')
            } catch (err) {
              if (!logWarned) console.warn(`ProjectRunner: cannot write ${logFile}: ${(err as Error).message}`)
              logWarned = true
            }
            this.deps.bus.emitLog(projectId, stepId, masked)
          } catch {
            // a throwing bus listener is not the runner's problem
          }
        },
      })
      // Leave the step current: the next run marks it interrupted and resumes it.
      if (signal.aborted && result.classified.kind === 'error') return 'paused'
    }

    if (result?.classified.kind === 'rate_limited' || result?.classified.kind === 'auth') {
      return this.stopForLimitOrAuth(stepId, result)
    }

    let outcome: StepOutcome
    if (!result) outcome = { ok: false, error: promptError! }
    else if (result.classified.kind === 'error') outcome = { ok: false, error: result.classified.message }
    else outcome = await validateOutputs(role, dir, built!.verdictFile)
    if (role === 'verifier' || role === 'reviewer') outcome = await rejectCheckerEdits(dir, role, outcome)
    if (outcome.ok && role === 'implementer') {
      if (!task) throw new Error('implementer step has no task')
      const message = `task-${task.id}: ${task.title} (attempt ${s.attempt})`
      if (!(await commitAll(dir, message))) outcome = { ok: false, error: NO_CHANGES }
    } else if (outcome.ok && role === 'finalizer') {
      await commitAll(dir, 'docs: README and REPORT')
    }
    return this.finish(stepId, outcome, secrets, result)
  }

  /** Records a rate-limited or unauthenticated run without consuming an attempt; pauses unless a limit is waited out. */
  private async stopForLimitOrAuth(stepId: string, result: RunResult): Promise<RunStatus> {
    // Reload: the scheduler may have changed flags (e.g. paused) while the agent ran.
    const s = await loadState(this.dir)
    const step = findStep(s, stepId)
    step.endedAt = now()
    recordUsage(step, result)
    s.currentStepId = null
    s.resumeNote = true // the run stopped mid-way: partial work may remain for the next run to inspect
    if (result.classified.kind === 'rate_limited' && s.pauseOnLimit) {
      // Not an error: the panel tells a limit pause apart by the last step being `limited`.
      step.status = 'limited'
      s.paused = true
      await this.save(s)
      this.notify(NOTIFY_TITLE, `${s.name}: достигнут лимит Claude, проект на паузе`)
      return 'paused'
    }
    if (result.classified.kind === 'rate_limited') {
      step.status = 'limited'
      s.limitHits += 1
      const minutes = LIMIT_BACKOFF_MIN[Math.min(s.limitHits - 1, LIMIT_BACKOFF_MIN.length - 1)]
      s.limitUntil = new Date(Date.now() + minutes * 60_000).toISOString()
      await this.save(s)
      return 'rate_limited'
    }
    step.status = 'failed'
    step.error = AUTH_ERROR
    s.error = AUTH_ERROR
    s.paused = true
    await this.save(s)
    this.notify(NOTIFY_TITLE, `${s.name}: Claude CLI не авторизован`)
    return 'error'
  }

  /** Applies the step outcome (masked) to freshly loaded state, finishes the step record, saves and notifies. */
  private async finish(
    stepId: string,
    outcome: StepOutcome,
    secrets: string[],
    result: RunResult | null = null,
  ): Promise<null> {
    const mask = (text: string) => maskSecrets(text, secrets)
    // Agent output can echo secrets; nothing derived from it reaches state.json unmasked.
    if (!outcome.ok) outcome = { ok: false, error: mask(outcome.error) }
    else if (outcome.verdict) outcome = { ok: true, verdict: { ...outcome.verdict, issues: outcome.verdict.issues.map(mask) } }

    // Reload: the scheduler may have changed flags (e.g. paused) and the architect wrote plan.json.
    const { plan } = await loadPlanSafe(this.dir)
    const verdictFailed = outcome.ok && outcome.verdict?.pass === false
    const s = applyStepOutcome(await loadState(this.dir), plan, outcome)
    const step = findStep(s, stepId)
    step.endedAt = now()
    if (result) recordUsage(step, result)
    step.status = outcome.ok && !verdictFailed ? 'ok' : 'failed'
    if (!outcome.ok) step.error = outcome.error
    else if (verdictFailed) step.error = outcome.verdict!.issues.join('\n')
    s.currentStepId = null
    await this.save(s)

    if (s.phase.startsWith('await_') || s.phase === 'needs_help') {
      this.notify(NOTIFY_TITLE, `${s.name}: нужно ваше решение`)
    } else if (s.phase === 'done') {
      this.notify(NOTIFY_TITLE, `${s.name}: проект готов`)
    }
    return null
  }
}

/**
 * Applies the user's answer to the project's checkpoint. For `answers`, writes answers.json and
 * `.env` (only when secrets were given) after the input is known to fit, before saving the transition.
 */
/** User input that fits the checkpoint but is not acceptable (the API answers 400). */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidInputError'
  }
}

/** At the plan checkpoint of a plan with UI, valid design options make a known `designId` mandatory. */
async function assertDesignChoice(dir: string, state: ProjectState, plan: Plan | null, input: UserInput): Promise<void> {
  if (input.kind !== 'approve' || state.checkpoint?.kind !== 'plan') return
  // Options left over from before a revision that dropped the UI do not count.
  if (plan?.hasUI !== true) return
  const options = await readJson(projectPaths(dir).designOptions, DesignOptionsSchema).catch(() => null)
  if (!options) return
  const ids = options.options.map((o) => o.id)
  if (input.designId === undefined) throw new InvalidInputError(`Choose a design: designId must be one of ${ids.join(', ')}`)
  if (!ids.includes(input.designId)) {
    throw new InvalidInputError(`Unknown design "${input.designId}": designId must be one of ${ids.join(', ')}`)
  }
}

export async function submitInput(cfg: Config, dir: string, input: UserInput, bus: EventBus): Promise<ProjectState> {
  const state = await loadState(dir)
  const { plan } = await loadPlanSafe(dir)
  const next = applyUserInput(state, plan, input) // throws CheckpointMismatchError before any side effect
  await assertDesignChoice(dir, state, plan, input)

  if (input.kind === 'answers') {
    assertEnvKeys(input.secrets) // before any write, so a bad key leaves no files behind
    await writeFile(projectPaths(dir).answers, JSON.stringify(input.answers, null, 2))
    if (Object.keys(input.secrets).length > 0) await writeEnv(dir, input.secrets)
  }
  if (input.kind === 'help' && input.action !== 'skip' && state.help?.phase === 'build') {
    // «Исправил сам»: commit the user's own edits, so the reviewer's diff (taskBase..HEAD) includes them.
    const taskId = plan ? flattenTasks(plan)[state.taskIndex]?.id : undefined
    await commitAll(dir, `task-${taskId ?? state.taskIndex + 1}: manual fix by user`)
  }
  if (next.plan && JSON.stringify(next.plan) !== JSON.stringify(plan)) await savePlan(dir, next.plan)
  await saveState(dir, next.state)
  bus.emitState(next.state.id, next.state)
  return next.state
}
