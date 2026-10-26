import { describe, it, expect } from 'vitest'
import {
  applyStepOutcome,
  applyUserInput,
  CheckpointMismatchError,
  flattenTasks,
  MAX_BUILD_ATTEMPTS,
  MAX_OTHER_ATTEMPTS,
  nextAction,
  type StepOutcome,
} from '../../src/core/stateMachine.js'
import type { Plan, ProjectState, Task } from '../../src/core/schemas.js'

/** Same shape as createProject's initial state (src/core/store.ts). */
function initial(over: Partial<ProjectState> = {}): ProjectState {
  return {
    id: 'p1',
    slug: 'demo',
    name: 'Demo',
    createdAt: '2026-10-18T00:00:00.000Z',
    phase: 'questions',
    subStep: 'implement',
    taskIndex: 0,
    attempt: 1,
    feedback: null,
    resumeNote: false,
    help: null,
    checkpoint: null,
    demoDone: false,
    chosenDesign: null,
    taskBase: null,
    feedbackRounds: 0,
    paused: false,
    limitUntil: null,
    limitHits: 0,
    pauseOnLimit: false,
    error: null,
    currentStepId: null,
    steps: [],
    ...over,
  }
}

const task = (id: string): Task => ({ id, title: id, description: `do ${id}`, acceptance: ['works'], verify: ['npm test'] })

const plan2: Plan = {
  platform: 'web',
  hasUI: true,
  runCommand: 'npm start',
  testCommand: 'npm test',
  milestones: [
    { id: 'm1', title: 'MVP', mvp: true, tasks: [task('t1')] },
    { id: 'm2', title: 'More', mvp: false, tasks: [task('t2')] },
  ],
}
const planNoUI: Plan = { ...plan2, hasUI: false }

const PASS: StepOutcome = { ok: true, verdict: { pass: true, issues: [] } }
const FAIL = (error = 'boom'): StepOutcome => ({ ok: false, error })

function run(s: ProjectState, plan: Plan | null, ...outcomes: StepOutcome[]): ProjectState {
  return outcomes.reduce((acc, o) => applyStepOutcome(acc, plan, o), s)
}

const atBuild = (over: Partial<ProjectState> = {}) => initial({ phase: 'build', ...over })
const atDemo = initial({
  phase: 'await_demo',
  taskIndex: 1,
  checkpoint: { kind: 'demo', message: 'Review the MVP demo' },
})

describe('constants and flattenTasks', () => {
  it('exposes the attempt limits', () => {
    expect(MAX_BUILD_ATTEMPTS).toBe(3)
    expect(MAX_OTHER_ATTEMPTS).toBe(2)
  })

  it('flattens milestones into task order', () =>
    expect(flattenTasks(plan2).map((t) => t.id)).toEqual(['t1', 't2']))
})

describe('state machine', () => {
  it('happy path reaches done with checkpoints in order', () => {
    let s = initial()
    expect(nextAction(s, null)).toEqual({ kind: 'run', role: 'analyst_questions' })
    s = applyStepOutcome(s, null, { ok: true })
    expect(s.phase).toBe('await_answers')
    expect(s.checkpoint).toEqual({ kind: 'answers', message: "Answer the analyst's questions" })
    expect(nextAction(s, null)).toEqual({ kind: 'wait' })
    s = applyUserInput(s, null, { kind: 'answers', answers: {}, secrets: {} }).state
    expect(s.phase).toBe('spec')
    expect(s.checkpoint).toBeNull()
    expect(nextAction(s, null)).toEqual({ kind: 'run', role: 'analyst_spec' })
    s = applyStepOutcome(s, null, { ok: true })
    expect(s.phase).toBe('await_spec')
    expect(s.checkpoint).toEqual({ kind: 'spec', message: 'Approve the spec' })
    s = applyUserInput(s, null, { kind: 'approve' }).state
    expect(s.phase).toBe('plan')
    expect(nextAction(s, null)).toEqual({ kind: 'run', role: 'architect' })
    s = applyStepOutcome(s, plan2, { ok: true })
    expect(s.phase).toBe('design')
    expect(s.checkpoint).toBeNull()
    expect(nextAction(s, plan2)).toEqual({ kind: 'run', role: 'designer' })
    s = applyStepOutcome(s, plan2, { ok: true })
    expect(s.phase).toBe('await_plan')
    expect(s.checkpoint).toEqual({ kind: 'plan', message: 'Approve the plan and choose a design' })
    s = applyUserInput(s, plan2, { kind: 'approve', designId: 'b' }).state
    expect(s).toMatchObject({ phase: 'build', taskIndex: 0, subStep: 'implement', checkpoint: null })
    expect(s.chosenDesign).toBe('b')
    expect(nextAction(s, plan2)).toEqual({ kind: 'run', role: 'implementer', taskId: 't1' })
    s = applyStepOutcome(s, plan2, { ok: true })
    expect(s.subStep).toBe('verify')
    expect(nextAction(s, plan2)).toEqual({ kind: 'run', role: 'verifier', taskId: 't1' })
    s = applyStepOutcome(s, plan2, PASS)
    expect(s.subStep).toBe('review')
    expect(nextAction(s, plan2)).toEqual({ kind: 'run', role: 'reviewer', taskId: 't1' })
    s = applyStepOutcome(s, plan2, PASS)
    expect(s.phase).toBe('await_demo')
    expect(s.checkpoint).toEqual({ kind: 'demo', message: 'Review the MVP demo' })
    expect(s).toMatchObject({ taskIndex: 1, subStep: 'implement', attempt: 1, taskBase: null })
    const afterDemo = applyUserInput(s, plan2, { kind: 'demo', comments: '' })
    s = afterDemo.state
    expect(afterDemo.plan).toEqual(plan2)
    expect(s).toMatchObject({ phase: 'build', demoDone: true, checkpoint: null })
    expect(nextAction(s, plan2)).toEqual({ kind: 'run', role: 'implementer', taskId: 't2' })
    s = run(s, plan2, { ok: true }, PASS, PASS)
    expect(s.phase).toBe('finalize')
    expect(nextAction(s, plan2)).toEqual({ kind: 'run', role: 'finalizer' })
    s = applyStepOutcome(s, plan2, { ok: true })
    expect(s.phase).toBe('done')
    expect(nextAction(s, plan2)).toEqual({ kind: 'done' })
  })

  it('hasUI=false skips design', () => {
    const s = applyStepOutcome(initial({ phase: 'plan' }), planNoUI, { ok: true })
    expect(s.phase).toBe('await_plan')
    expect(s.checkpoint).toEqual({ kind: 'plan', message: 'Approve the plan' })
    const { state } = applyUserInput(s, planNoUI, { kind: 'approve' })
    expect(state).toMatchObject({ phase: 'build', chosenDesign: null, taskIndex: 0 })
  })

  it('success clears feedback, resumeNote and limitHits and resets attempt', () => {
    const s = applyStepOutcome(
      initial({ phase: 'spec', attempt: 2, feedback: 'x', resumeNote: true, limitHits: 3 }),
      null,
      { ok: true },
    )
    expect(s).toMatchObject({ phase: 'await_spec', attempt: 1, feedback: null, resumeNote: false, limitHits: 0 })
  })

  it('verify fail sends issues back to implementer as feedback, attempt 2', () => {
    const s = applyStepOutcome(atBuild({ subStep: 'verify' }), plan2, {
      ok: true,
      verdict: { pass: false, issues: ['button broken', 'no title'] },
    })
    expect(s).toMatchObject({ phase: 'build', subStep: 'implement', attempt: 2 })
    expect(s.feedback).toBe('Verifier found:\n- button broken\n- no title')
  })

  it('review fail sends issues back to implementer as feedback', () => {
    const s = applyStepOutcome(atBuild({ subStep: 'review' }), plan2, {
      ok: true,
      verdict: { pass: false, issues: ['messy code'] },
    })
    expect(s).toMatchObject({ phase: 'build', subStep: 'implement', attempt: 2 })
    expect(s.feedback).toBe('Reviewer found:\n- messy code')
  })

  it('third failed attempt goes to needs_help with help pointer', () => {
    let s = run(atBuild(), plan2, FAIL('e1'), FAIL('e2'))
    expect(s).toMatchObject({ phase: 'build', subStep: 'implement', attempt: 3 })
    expect(s.feedback).toBe('Previous attempt failed: e1\n\nPrevious attempt failed: e2')
    s = applyStepOutcome(s, plan2, FAIL('e3'))
    expect(s.phase).toBe('needs_help')
    expect(s.help).toEqual({ phase: 'build', subStep: 'implement' })
    expect(s.checkpoint).toEqual({ kind: 'help', message: 'e3' })
    expect(nextAction(s, plan2)).toEqual({ kind: 'wait' })
  })

  it('third failed verdict goes to needs_help with the issues as message', () => {
    const s = applyStepOutcome(atBuild({ subStep: 'review', attempt: 3 }), plan2, {
      ok: true,
      verdict: { pass: false, issues: ['still broken'] },
    })
    expect(s.phase).toBe('needs_help')
    expect(s.help).toEqual({ phase: 'build', subStep: 'implement' })
    expect(s.checkpoint).toEqual({ kind: 'help', message: 'Reviewer found:\n- still broken' })
  })

  it('help retry after exhausted review sends hint and issues to the implementer', () => {
    const stuck = applyStepOutcome(atBuild({ subStep: 'review', attempt: 3 }), plan2, {
      ok: true,
      verdict: { pass: false, issues: ['header overlaps'] },
    })
    expect(stuck.phase).toBe('needs_help')
    expect(stuck.help).toEqual({ phase: 'build', subStep: 'implement' })
    const { state } = applyUserInput(stuck, plan2, { kind: 'help', action: 'retry', hint: 'use port 3001' })
    expect(nextAction(state, plan2)).toEqual({ kind: 'run', role: 'implementer', taskId: 't1' })
    expect(state).toMatchObject({ phase: 'build', subStep: 'implement', attempt: 1, help: null, checkpoint: null })
    expect(state.feedback).toBe('User hint: use port 3001\n\nReviewer found:\n- header overlaps')
  })

  it('a crash on a retry keeps the earlier feedback (revise comment, help hint, issues)', () => {
    const revising = initial({ phase: 'plan', feedback: 'User asked for changes:\nuse SQLite' })
    expect(applyStepOutcome(revising, null, FAIL('timeout')).feedback).toBe(
      'User asked for changes:\nuse SQLite\n\nPrevious attempt failed: timeout',
    )
    const hinted = atBuild({ feedback: 'User hint: port 3001\n\nVerifier found:\n- broken' })
    expect(applyStepOutcome(hinted, plan2, FAIL('crash')).feedback).toBe(
      'User hint: port 3001\n\nVerifier found:\n- broken\n\nPrevious attempt failed: crash',
    )
  })

  it('any completed step outcome clears resumeNote, a failure too', () => {
    expect(applyStepOutcome(initial({ phase: 'spec', resumeNote: true }), null, FAIL()).resumeNote).toBe(false)
    const verdict = { ok: true as const, verdict: { pass: false, issues: ['x'] } }
    expect(applyStepOutcome(atBuild({ subStep: 'verify', resumeNote: true }), plan2, verdict).resumeNote).toBe(false)
  })

  it('demo feedback ids never collide with ids already in the plan', () => {
    const taken: Plan = {
      ...plan2,
      milestones: [...plan2.milestones, { id: 'feedback-1', title: 'x', mvp: false, tasks: [task('fb-2')] }],
    }
    const { state, plan } = applyUserInput(atDemo, taken, { kind: 'demo', comments: 'more' })
    expect(plan!.milestones.at(-1)).toMatchObject({ id: 'feedback-3', tasks: [{ id: 'fb-3' }] })
    expect(state.feedbackRounds).toBe(1)
  })

  it('non-build failure retries once then needs_help', () => {
    let s = applyStepOutcome(initial({ phase: 'spec' }), null, FAIL('bad json'))
    expect(s).toMatchObject({ phase: 'spec', attempt: 2, feedback: 'Previous attempt failed: bad json' })
    s = applyStepOutcome(s, null, FAIL('bad json again'))
    expect(s.phase).toBe('needs_help')
    expect(s.help).toEqual({ phase: 'spec', subStep: 'implement' })
    expect(s.checkpoint).toEqual({ kind: 'help', message: 'bad json again' })
  })

  it('help retry returns to the failed step with the hint as feedback', () => {
    const stuck = run(atBuild({ subStep: 'verify' }), plan2, FAIL(), FAIL(), FAIL())
    expect(stuck.phase).toBe('needs_help')
    const { state } = applyUserInput(stuck, plan2, { kind: 'help', action: 'retry', hint: 'use port 3001' })
    expect(state).toMatchObject({
      phase: 'build',
      subStep: 'verify',
      attempt: 1,
      feedback: 'User hint: use port 3001\n\nboom',
      help: null,
      checkpoint: null,
    })
    const noHint = applyUserInput(stuck, plan2, { kind: 'help', action: 'retry' }).state
    expect(noHint.feedback).toBe('boom')
  })

  it('help retry outside build returns to that phase', () => {
    const stuck = run(initial({ phase: 'plan' }), plan2, FAIL(), FAIL())
    const { state } = applyUserInput(stuck, null, { kind: 'help', action: 'retry' })
    expect(state).toMatchObject({ phase: 'plan', attempt: 1, help: null, checkpoint: null })
    expect(nextAction(state, null)).toEqual({ kind: 'run', role: 'architect' })
  })

  it('help continue outside build behaves like retry', () => {
    const stuck = run(initial({ phase: 'finalize' }), plan2, FAIL(), FAIL())
    const { state } = applyUserInput(stuck, plan2, { kind: 'help', action: 'continue', hint: 'h' })
    expect(state).toMatchObject({ phase: 'finalize', attempt: 1, feedback: 'User hint: h\n\nboom', help: null })
  })

  it('help skip advances to the next task; help continue goes to verify', () => {
    const plan3: Plan = {
      ...plan2,
      milestones: [
        { id: 'm1', title: 'MVP', mvp: true, tasks: [task('t1'), task('t2')] },
        { id: 'm2', title: 'More', mvp: false, tasks: [task('t3')] },
      ],
    }
    const stuck = run(atBuild(), plan3, FAIL(), FAIL(), FAIL())
    const skipped = applyUserInput(stuck, plan3, { kind: 'help', action: 'skip' }).state
    expect(skipped).toMatchObject({
      phase: 'build',
      taskIndex: 1,
      subStep: 'implement',
      attempt: 1,
      taskBase: null,
      feedback: null,
      help: null,
      checkpoint: null,
    })
    expect(nextAction(skipped, plan3)).toEqual({ kind: 'run', role: 'implementer', taskId: 't2' })

    const continued = applyUserInput(stuck, plan3, { kind: 'help', action: 'continue', hint: 'it works now' }).state
    expect(continued).toMatchObject({
      phase: 'build',
      taskIndex: 0,
      subStep: 'verify',
      attempt: 1,
      feedback: 'User hint: it works now',
      help: null,
    })
    expect(nextAction(continued, plan3)).toEqual({ kind: 'run', role: 'verifier', taskId: 't1' })
  })

  it('help skip on the last mvp task goes to the demo checkpoint', () => {
    const stuck = run(atBuild(), plan2, FAIL(), FAIL(), FAIL())
    const { state } = applyUserInput(stuck, plan2, { kind: 'help', action: 'skip' })
    expect(state).toMatchObject({ phase: 'await_demo', taskIndex: 1, help: null })
    expect(state.checkpoint?.kind).toBe('demo')
  })

  it('help skip outside build throws CheckpointMismatchError', () => {
    const stuck = run(initial({ phase: 'spec' }), null, FAIL(), FAIL())
    expect(() => applyUserInput(stuck, null, { kind: 'help', action: 'skip' })).toThrow(CheckpointMismatchError)
  })

  it('help retry without a help pointer throws CheckpointMismatchError', () => {
    const s = initial({ phase: 'needs_help', checkpoint: { kind: 'help', message: 'x' } })
    expect(() => applyUserInput(s, null, { kind: 'help', action: 'retry' })).toThrow(CheckpointMismatchError)
  })

  it('revise spec re-runs analyst_spec with the comment as feedback', () => {
    const s = initial({ phase: 'await_spec', checkpoint: { kind: 'spec', message: 'Approve the spec' } })
    const { state } = applyUserInput(s, null, { kind: 'revise', comment: 'add dark mode' })
    expect(state).toMatchObject({ phase: 'spec', feedback: 'User asked for changes:\nadd dark mode', checkpoint: null })
    expect(nextAction(state, null)).toEqual({ kind: 'run', role: 'analyst_spec' })
  })

  it('verify failing after every successful implement exhausts the build attempts', () => {
    const verifyFail: StepOutcome = { ok: true, verdict: { pass: false, issues: ['still broken'] } }
    let s = run(atBuild(), plan2, { ok: true }, verifyFail)
    expect(s).toMatchObject({ subStep: 'implement', attempt: 2 })
    s = applyStepOutcome(s, plan2, { ok: true })
    expect(nextAction(s, plan2)).toEqual({ kind: 'run', role: 'verifier', taskId: 't1' })
    expect(s.attempt).toBe(2)
    s = run(s, plan2, verifyFail, { ok: true })
    expect(s).toMatchObject({ subStep: 'verify', attempt: 3 })
    s = applyStepOutcome(s, plan2, PASS)
    expect(s).toMatchObject({ subStep: 'review', attempt: 3 })
    s = run(atBuild(), plan2, { ok: true }, verifyFail, { ok: true }, verifyFail, { ok: true }, verifyFail)
    expect(s.phase).toBe('needs_help')
    expect(s.help).toEqual({ phase: 'build', subStep: 'implement' })
  })

  it('advancing to the next task resets the build attempt', () => {
    const s = run(atBuild({ attempt: 3, subStep: 'review', demoDone: true }), plan2, PASS)
    expect(s).toMatchObject({ phase: 'build', taskIndex: 1, subStep: 'implement', attempt: 1 })
  })

  it('plan revise feedback reaches the designer and is cleared after design', () => {
    const s0 = initial({ phase: 'await_plan', checkpoint: { kind: 'plan', message: 'Approve the plan and choose a design' } })
    let s = applyUserInput(s0, plan2, { kind: 'revise', comment: 'fewer tasks' }).state
    s = applyStepOutcome(s, plan2, { ok: true })
    expect(s).toMatchObject({ phase: 'design', feedback: 'User asked for changes:\nfewer tasks' })
    s = applyStepOutcome(s, plan2, { ok: true })
    expect(s).toMatchObject({ phase: 'await_plan', feedback: null })
  })

  it('architect failure feedback is not passed on to the designer', () => {
    const s = run(initial({ phase: 'plan' }), plan2, FAIL('bad plan'), { ok: true })
    expect(s).toMatchObject({ phase: 'design', feedback: null, attempt: 1 })
  })

  it('revise plan re-runs architect with the comment as feedback', () => {
    const s = initial({ phase: 'await_plan', checkpoint: { kind: 'plan', message: 'Approve the plan' } })
    const { state } = applyUserInput(s, plan2, { kind: 'revise', comment: 'fewer tasks' })
    expect(state).toMatchObject({ phase: 'plan', feedback: 'User asked for changes:\nfewer tasks', checkpoint: null })
    expect(nextAction(state, plan2)).toEqual({ kind: 'run', role: 'architect' })
  })

  it('demo comments append a feedback milestone and build it before finalize', () => {
    const { state, plan } = applyUserInput(atDemo, plan2, { kind: 'demo', comments: 'make header blue' })
    expect(flattenTasks(plan!).at(-1)).toMatchObject({ id: 'fb-1', description: 'make header blue' })
    expect(plan!.milestones.at(-1)).toEqual({
      id: 'feedback-1',
      title: 'Demo feedback',
      mvp: false,
      tasks: [
        {
          id: 'fb-1',
          title: 'Address demo feedback',
          description: 'make header blue',
          acceptance: ['Every point of the demo feedback is addressed'],
          verify: ['npm test'],
        },
      ],
    })
    expect(plan2.milestones).toHaveLength(2) // input plan untouched
    expect(state).toMatchObject({ phase: 'build', demoDone: true, feedbackRounds: 1, checkpoint: null })
    let s = run(state, plan!, { ok: true }, PASS, PASS) // t2
    expect(nextAction(s, plan!)).toEqual({ kind: 'run', role: 'implementer', taskId: 'fb-1' })
    s = run(s, plan!, { ok: true }, PASS, PASS) // fb-1
    expect(s.phase).toBe('finalize')
  })

  it('demo with no tasks left goes to finalize', () => {
    const onlyMvp: Plan = { ...plan2, milestones: [plan2.milestones[0]] }
    const { state } = applyUserInput(atDemo, onlyMvp, { kind: 'demo', comments: '' })
    expect(state).toMatchObject({ phase: 'finalize', demoDone: true, feedbackRounds: 0 })
  })

  it('demo is offered only once', () => {
    const s = run(atBuild({ demoDone: true }), plan2, { ok: true }, PASS, PASS)
    expect(s).toMatchObject({ phase: 'build', taskIndex: 1, checkpoint: null })
  })

  it('approve while at answers checkpoint throws CheckpointMismatchError', () => {
    const s = initial({ phase: 'await_answers', checkpoint: { kind: 'answers', message: 'm' } })
    expect(() => applyUserInput(s, null, { kind: 'approve' })).toThrow(CheckpointMismatchError)
  })

  it('second approve after the first (no checkpoint) throws CheckpointMismatchError', () => {
    const s = initial({ phase: 'await_spec', checkpoint: { kind: 'spec', message: 'Approve the spec' } })
    const first = applyUserInput(s, null, { kind: 'approve' }).state
    expect(() => applyUserInput(first, null, { kind: 'approve' })).toThrow(CheckpointMismatchError)
  })

  it('paused / limitUntil / error → wait', () => {
    expect(nextAction(initial({ paused: true }), null)).toEqual({ kind: 'wait' })
    expect(nextAction(initial({ limitUntil: '2026-10-18T10:00:00Z' }), null)).toEqual({ kind: 'wait' })
    expect(nextAction(initial({ error: 'disk full' }), null)).toEqual({ kind: 'wait' })
  })

  it('does not mutate its inputs', () => {
    const s = atBuild({ subStep: 'verify' })
    const snapshot = structuredClone(s)
    applyStepOutcome(s, plan2, { ok: true, verdict: { pass: false, issues: ['x'] } })
    expect(s).toEqual(snapshot)
  })

  it('applyStepOutcome rejects non-running phases and missing plans', () => {
    expect(() => applyStepOutcome(initial({ phase: 'await_spec' }), null, { ok: true })).toThrow(Error)
    expect(() => applyStepOutcome(initial({ phase: 'done' }), null, { ok: true })).toThrow(Error)
    expect(() => applyStepOutcome(initial({ phase: 'plan' }), null, { ok: true })).toThrow(Error)
    expect(() => applyStepOutcome(atBuild(), null, { ok: true })).toThrow(Error)
    // a failure needs no plan: an unreadable plan.json in build is itself a failed attempt
    expect(applyStepOutcome(atBuild(), null, FAIL('plan.json is invalid'))).toMatchObject({ phase: 'build', attempt: 2 })
    expect(() => applyStepOutcome(atBuild({ subStep: 'verify' }), plan2, { ok: true })).toThrow(/verdict/)
    expect(() => applyStepOutcome(atBuild({ subStep: 'review' }), plan2, { ok: true })).toThrow(/verdict/)
  })

  it('answers input never stores secret values in state', () => {
    const s = initial({ phase: 'await_answers', checkpoint: { kind: 'answers', message: 'm' } })
    const { state } = applyUserInput(s, null, {
      kind: 'answers',
      answers: { q1: 'yes' },
      secrets: { API_KEY: 'sk-very-secret-123' },
    })
    expect(state.phase).toBe('spec')
    expect(JSON.stringify(state)).not.toContain('sk-very-secret-123')
  })
})
