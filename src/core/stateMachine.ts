import type { Checkpoint, Phase, Plan, ProjectState, Role, SubStep, Task, UserInput, Verdict } from './schemas.js'

/** Pure pipeline transitions: no I/O, inputs are never mutated. */

export type Action = { kind: 'run'; role: Role; taskId?: string } | { kind: 'wait' } | { kind: 'done' }
export type StepOutcome = { ok: true; verdict?: Verdict } | { ok: false; error: string }

export const MAX_BUILD_ATTEMPTS = 3
export const MAX_OTHER_ATTEMPTS = 2

export class CheckpointMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointMismatchError'
  }
}

const PHASE_ROLE: Partial<Record<Phase, Role>> = {
  questions: 'analyst_questions',
  spec: 'analyst_spec',
  plan: 'architect',
  design: 'designer',
  finalize: 'finalizer',
}

export const SUBSTEP_ROLE: Record<SubStep, Role> = {
  implement: 'implementer',
  verify: 'verifier',
  review: 'reviewer',
}

const RUNNING_PHASES: Phase[] = ['questions', 'spec', 'plan', 'design', 'build', 'finalize']

const REVISE_PREFIX = 'User asked for changes:'

const MESSAGES = {
  answers: "Answer the analyst's questions",
  spec: 'Approve the spec',
  plan: 'Approve the plan',
  planWithDesign: 'Approve the plan and choose a design',
  demo: 'Review the MVP demo',
} as const

export function flattenTasks(plan: Plan): Task[] {
  return plan.milestones.flatMap((m) => m.tasks)
}

function requirePlan(plan: Plan | null, what: string): Plan {
  if (!plan) throw new Error(`${what} requires a plan`)
  return plan
}

export function nextAction(s: ProjectState, plan: Plan | null): Action {
  if (s.paused || s.limitUntil !== null || s.error !== null) return { kind: 'wait' }
  if (s.phase === 'done') return { kind: 'done' }
  if (s.phase === 'build') {
    const t = flattenTasks(requirePlan(plan, 'build phase'))[s.taskIndex]
    if (!t) throw new Error(`no task at index ${s.taskIndex}`)
    return { kind: 'run', role: SUBSTEP_ROLE[s.subStep], taskId: t.id }
  }
  const role = PHASE_ROLE[s.phase]
  return role ? { kind: 'run', role } : { kind: 'wait' }
}

function enterCheckpoint(s: ProjectState, phase: Phase, checkpoint: Checkpoint): void {
  s.phase = phase
  s.checkpoint = checkpoint
}

/** Moves past the current task: next task, the one-time MVP demo, or finalize. */
function advanceTask(s: ProjectState, plan: Plan): void {
  const tasks = flattenTasks(plan)
  const finished = s.taskIndex
  const mvp = plan.milestones.find((m) => m.mvp)
  const lastMvpTaskId = mvp?.tasks.at(-1)?.id
  s.taskIndex = finished + 1
  s.subStep = 'implement'
  s.attempt = 1
  s.taskBase = null
  s.feedback = null
  if (tasks[finished]?.id === lastMvpTaskId && !s.demoDone) {
    enterCheckpoint(s, 'await_demo', { kind: 'demo', message: MESSAGES.demo })
  } else if (s.taskIndex >= tasks.length) {
    s.phase = 'finalize'
  } else {
    s.phase = 'build'
  }
}

/**
 * A failed attempt: retry `retrySubStep` with feedback, or stop for help once the limit is exceeded.
 * The help pointer is `retrySubStep` too: a crash returns to the step that crashed, a failed
 * verdict returns to `implement` so the fix (and any user hint) reaches the implementer.
 */
function failAttempt(s: ProjectState, feedback: string, helpMessage: string, retrySubStep: SubStep): void {
  const limit = s.phase === 'build' ? MAX_BUILD_ATTEMPTS : MAX_OTHER_ATTEMPTS
  s.attempt += 1
  // Append: a crash on a retry must not wipe the revise comment, help hint or issues it was fixing.
  s.feedback = (s.feedback ? `${s.feedback}\n\n` : '') + feedback
  s.resumeNote = false // the step completed (badly); nothing is left half-done
  s.subStep = retrySubStep
  if (s.attempt > limit) {
    s.help = { phase: s.phase, subStep: retrySubStep }
    enterCheckpoint(s, 'needs_help', { kind: 'help', message: helpMessage })
  }
}

export function applyStepOutcome(state: ProjectState, plan: Plan | null, o: StepOutcome): ProjectState {
  const s = structuredClone(state)
  if (!RUNNING_PHASES.includes(s.phase)) {
    throw new Error(`no step is running in phase ${s.phase}`)
  }
  // A failure needs no plan: an unreadable plan.json in build is itself reported as a failed attempt.
  if (!o.ok) {
    failAttempt(s, `Previous attempt failed: ${o.error}`, o.error, s.subStep)
    return s
  }
  if (s.phase === 'build') requirePlan(plan, 'build step outcome')

  if (s.phase === 'build' && s.subStep !== 'implement') {
    if (!o.verdict) throw new Error(`${s.subStep} outcome requires a verdict`)
    if (!o.verdict.pass) {
      const who = s.subStep === 'verify' ? 'Verifier' : 'Reviewer'
      const issues = `${who} found:\n${o.verdict.issues.map((i) => `- ${i}`).join('\n')}`
      failAttempt(s, issues, issues, 'implement')
      return s
    }
  }

  const userRevision = s.feedback?.startsWith(REVISE_PREFIX) ? s.feedback : null
  s.feedback = null
  s.resumeNote = false
  s.limitHits = 0
  // In build the attempt counts the whole implement->verify->review loop; advanceTask resets it.
  if (s.phase !== 'build') s.attempt = 1

  switch (s.phase) {
    case 'questions':
      enterCheckpoint(s, 'await_answers', { kind: 'answers', message: MESSAGES.answers })
      break
    case 'spec':
      enterCheckpoint(s, 'await_spec', { kind: 'spec', message: MESSAGES.spec })
      break
    case 'plan':
      if (requirePlan(plan, 'plan step outcome').hasUI) {
        s.phase = 'design'
        s.feedback = userRevision // the regenerated design must honour the plan revision too
      } else enterCheckpoint(s, 'await_plan', { kind: 'plan', message: MESSAGES.plan })
      break
    case 'design':
      enterCheckpoint(s, 'await_plan', { kind: 'plan', message: MESSAGES.planWithDesign })
      break
    case 'finalize':
      s.phase = 'done'
      break
    case 'build':
      if (s.subStep === 'implement') s.subStep = 'verify'
      else if (s.subStep === 'verify') s.subStep = 'review'
      else advanceTask(s, plan!)
      break
  }
  return s
}

function mismatch(s: ProjectState, input: UserInput): never {
  throw new CheckpointMismatchError(
    `input "${input.kind}" does not fit checkpoint ${s.checkpoint ? `"${s.checkpoint.kind}"` : '(none)'}`,
  )
}

export function applyUserInput(
  state: ProjectState,
  plan: Plan | null,
  input: UserInput,
): { state: ProjectState; plan: Plan | null } {
  const s = structuredClone(state)
  const p = structuredClone(plan)
  const at = s.checkpoint?.kind

  switch (input.kind) {
    case 'answers':
      if (at !== 'answers') mismatch(s, input)
      s.checkpoint = null
      s.phase = 'spec'
      s.attempt = 1
      s.feedback = null
      break

    case 'approve':
      if (at === 'spec') {
        s.checkpoint = null
        s.phase = 'plan'
        s.attempt = 1
        s.feedback = null
      } else if (at === 'plan') {
        s.checkpoint = null
        s.phase = 'build'
        s.subStep = 'implement'
        s.taskIndex = 0
        s.attempt = 1
        s.taskBase = null
        s.feedback = null
        s.chosenDesign = input.designId ?? null
      } else mismatch(s, input)
      break

    case 'revise':
      if (at !== 'spec' && at !== 'plan') mismatch(s, input)
      s.checkpoint = null
      s.phase = at
      s.attempt = 1
      s.feedback = `${REVISE_PREFIX}\n${input.comment}`
      break

    case 'demo': {
      if (at !== 'demo') mismatch(s, input)
      const demoPlan = requirePlan(p, 'demo input')
      s.checkpoint = null
      s.demoDone = true
      if (input.comments.trim() !== '') {
        const milestoneIds = new Set(demoPlan.milestones.map((m) => m.id))
        const taskIds = new Set(flattenTasks(demoPlan).map((t) => t.id))
        let n = s.feedbackRounds + 1
        while (milestoneIds.has(`feedback-${n}`) || taskIds.has(`fb-${n}`)) n++
        demoPlan.milestones.push({
          id: `feedback-${n}`,
          title: 'Demo feedback',
          mvp: false,
          tasks: [
            {
              id: `fb-${n}`,
              title: 'Address demo feedback',
              description: input.comments,
              acceptance: ['Every point of the demo feedback is addressed'],
              verify: [demoPlan.testCommand],
            },
          ],
        })
        s.feedbackRounds += 1
      }
      s.phase = s.taskIndex < flattenTasks(demoPlan).length ? 'build' : 'finalize'
      break
    }

    case 'help': {
      const help = s.help
      if (at !== 'help' || !help) mismatch(s, input)
      if (input.action === 'skip' && help.phase !== 'build') mismatch(s, input)
      const lastProblem = s.checkpoint!.message
      s.checkpoint = null
      s.help = null
      s.attempt = 1
      if (input.action === 'skip') {
        advanceTask(s, requirePlan(p, 'help skip'))
        break
      }
      s.phase = help.phase
      if (input.action === 'continue' && help.phase === 'build') {
        s.subStep = 'verify'
        s.feedback = input.hint ? `User hint: ${input.hint}` : null
      } else {
        // retry (and non-build continue): keep both the user's hint and the last issues/error
        s.subStep = help.subStep
        s.feedback = (input.hint ? `User hint: ${input.hint}\n\n` : '') + lastProblem
      }
      break
    }
  }
  return { state: s, plan: p }
}
