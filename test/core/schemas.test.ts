import { describe, it, expect } from 'vitest'
import {
  PlanSchema,
  QuestionsSchema,
  DesignOptionsSchema,
  ProjectStateSchema,
  UserInputSchema,
  VerdictSchema,
  CheckpointSchema,
} from '../../src/core/schemas.js'

const plan = {
  platform: 'web',
  hasUI: true,
  runCommand: 'npm start',
  testCommand: 'npm test',
  milestones: [
    {
      id: 'm1',
      title: 'Core',
      mvp: true,
      tasks: [{ id: 't1', title: 'Skeleton', description: 'd', acceptance: ['runs'], verify: ['npm test'] }],
    },
  ],
}

describe('PlanSchema', () => {
  it('accepts a valid plan', () => expect(PlanSchema.parse(plan)).toEqual(plan))

  it('rejects a plan without an mvp milestone', () =>
    expect(() => PlanSchema.parse({ ...plan, milestones: [{ ...plan.milestones[0], mvp: false }] })).toThrow())

  it('rejects a plan with no milestones', () =>
    expect(() => PlanSchema.parse({ ...plan, milestones: [] })).toThrow())

  it('rejects more than one mvp milestone', () => {
    const m2 = { ...plan.milestones[0], id: 'm2', tasks: [{ ...plan.milestones[0].tasks[0], id: 't2' }] }
    expect(() => PlanSchema.parse({ ...plan, milestones: [plan.milestones[0], m2] })).toThrow()
  })

  it('rejects duplicate task ids across milestones', () => {
    const m2 = { ...plan.milestones[0], id: 'm2', mvp: false }
    expect(() => PlanSchema.parse({ ...plan, milestones: [plan.milestones[0], m2] })).toThrow(/duplicate/i)
  })

  it('rejects a task with empty acceptance', () => {
    const bad = { ...plan.milestones[0], tasks: [{ ...plan.milestones[0].tasks[0], acceptance: [] }] }
    expect(() => PlanSchema.parse({ ...plan, milestones: [bad] })).toThrow()
  })

  it('rejects a milestone with no tasks', () =>
    expect(() => PlanSchema.parse({ ...plan, milestones: [{ ...plan.milestones[0], tasks: [] }] })).toThrow())

  it('rejects an unknown platform', () => expect(() => PlanSchema.parse({ ...plan, platform: 'toaster' })).toThrow())
})

describe('QuestionsSchema', () => {
  it('accepts questions with optional options and ENV_STYLE secrets', () => {
    const q = {
      questions: [{ id: 'q1', text: 'Which DB?', options: ['sqlite', 'json'] }, { id: 'q2', text: 'Name?' }],
      secrets: [{ name: 'BOT_TOKEN', description: 'telegram token' }],
    }
    expect(QuestionsSchema.parse(q)).toEqual(q)
  })

  it('rejects secret names that are not ENV_STYLE', () => {
    for (const name of ['bot token', 'bot_token', '1TOKEN', '_TOKEN', '']) {
      expect(() => QuestionsSchema.parse({ questions: [], secrets: [{ name, description: '' }] })).toThrow()
    }
  })
})

describe('DesignOptionsSchema', () => {
  const opt = (id: string) => ({ id, title: id, description: 'd', file: `${id}.html` })

  it('requires 2..3 design options', () => {
    expect(() => DesignOptionsSchema.parse({ options: [] })).toThrow()
    expect(() => DesignOptionsSchema.parse({ options: [opt('a')] })).toThrow()
    expect(() => DesignOptionsSchema.parse({ options: ['a', 'b', 'c', 'd'].map(opt) })).toThrow()
    expect(DesignOptionsSchema.parse({ options: [opt('a'), opt('b')] }).options).toHaveLength(2)
    expect(DesignOptionsSchema.parse({ options: ['a', 'b', 'c'].map(opt) }).options).toHaveLength(3)
  })
})

describe('VerdictSchema and CheckpointSchema', () => {
  it('accepts a verdict with optional screenshots', () => {
    expect(VerdictSchema.parse({ pass: true, issues: [] })).toEqual({ pass: true, issues: [] })
    expect(VerdictSchema.parse({ pass: false, issues: ['x'], screenshots: ['a.png'] }).screenshots).toEqual(['a.png'])
  })
  it('rejects an unknown checkpoint kind', () =>
    expect(() => CheckpointSchema.parse({ kind: 'nope', message: 'm' })).toThrow())
})

describe('UserInputSchema', () => {
  it('parses each variant', () => {
    expect(UserInputSchema.parse({ kind: 'answers', answers: { q1: 'a' }, secrets: { K: 'v' } }).kind).toBe('answers')
    expect(UserInputSchema.parse({ kind: 'approve' }).kind).toBe('approve')
    expect(UserInputSchema.parse({ kind: 'approve', designId: 'a' })).toEqual({ kind: 'approve', designId: 'a' })
    expect(UserInputSchema.parse({ kind: 'revise', comment: 'c' }).kind).toBe('revise')
    expect(UserInputSchema.parse({ kind: 'demo', comments: '' }).kind).toBe('demo')
    expect(UserInputSchema.parse({ kind: 'help', action: 'retry', hint: 'h' }).kind).toBe('help')
  })
  it('rejects bad help action and unknown kind', () => {
    expect(() => UserInputSchema.parse({ kind: 'help', action: 'explode' })).toThrow()
    expect(() => UserInputSchema.parse({ kind: 'what' })).toThrow()
  })
})

describe('ProjectStateSchema', () => {
  const state = {
    id: 'p1',
    slug: 'todo-app',
    name: 'Todo app',
    createdAt: '2026-10-18T00:00:00.000Z',
    phase: 'questions',
    subStep: 'implement',
    taskIndex: 0,
    attempt: 0,
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
  }

  it('round-trips a valid state', () => expect(ProjectStateSchema.parse(state)).toEqual(state))

  it('defaults pauseOnLimit to false for state written before the toggle existed', () => {
    const { pauseOnLimit: _, ...old } = state
    expect(ProjectStateSchema.parse(old).pauseOnLimit).toBe(false)
  })

  it('accepts help, checkpoint and step records', () => {
    const full = {
      ...state,
      phase: 'needs_help',
      help: { phase: 'build', subStep: 'verify' },
      checkpoint: { kind: 'help', message: 'stuck' },
      steps: [{ id: 's1', role: 'implementer', label: 'impl t1', taskId: 't1', attempt: 1, status: 'running', startedAt: 'now' }],
    }
    expect(ProjectStateSchema.parse(full)).toEqual(full)
  })

  it('rejects an unknown phase and a bad step role', () => {
    expect(() => ProjectStateSchema.parse({ ...state, phase: 'limbo' })).toThrow()
    expect(() =>
      ProjectStateSchema.parse({ ...state, steps: [{ id: 's', role: 'janitor', label: 'l', attempt: 1, status: 'ok', startedAt: 'x' }] }),
    ).toThrow()
  })
})
