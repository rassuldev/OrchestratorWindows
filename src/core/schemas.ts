import { z } from 'zod'

export const RoleSchema = z.enum([
  'analyst_questions',
  'analyst_spec',
  'architect',
  'designer',
  'implementer',
  'verifier',
  'reviewer',
  'finalizer',
])
export type Role = z.infer<typeof RoleSchema>

export const PhaseSchema = z.enum([
  'questions',
  'await_answers',
  'spec',
  'await_spec',
  'plan',
  'design',
  'await_plan',
  'build',
  'await_demo',
  'finalize',
  'needs_help',
  'done',
])
export type Phase = z.infer<typeof PhaseSchema>

export const SubStepSchema = z.enum(['implement', 'verify', 'review'])
export type SubStep = z.infer<typeof SubStepSchema>

export const QuestionsSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      options: z.array(z.string()).optional(),
    }),
  ),
  secrets: z.array(
    z.object({
      name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'secret name must be ENV_STYLE (A-Z, 0-9, _)'),
      description: z.string(),
    }),
  ),
})
export type Questions = z.infer<typeof QuestionsSchema>

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptance: z.array(z.string()).min(1),
  verify: z.array(z.string()),
})
export type Task = z.infer<typeof TaskSchema>

export const MilestoneSchema = z.object({
  id: z.string(),
  title: z.string(),
  mvp: z.boolean(),
  tasks: z.array(TaskSchema).min(1),
})
export type Milestone = z.infer<typeof MilestoneSchema>

export const PlanSchema = z
  .object({
    platform: z.enum(['web', 'cli', 'api', 'bot', 'desktop', 'other']),
    hasUI: z.boolean(),
    runCommand: z.string(),
    testCommand: z.string(),
    milestones: z.array(MilestoneSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const mvpCount = plan.milestones.filter((m) => m.mvp).length
    if (mvpCount !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['milestones'],
        message: `exactly one milestone must have mvp: true (found ${mvpCount})`,
      })
    }
    const seen = new Set<string>()
    plan.milestones.forEach((m, mi) =>
      m.tasks.forEach((t, ti) => {
        if (seen.has(t.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['milestones', mi, 'tasks', ti, 'id'],
            message: `duplicate task id "${t.id}"`,
          })
        }
        seen.add(t.id)
      }),
    )
  })
export type Plan = z.infer<typeof PlanSchema>

export const VerdictSchema = z.object({
  pass: z.boolean(),
  issues: z.array(z.string()),
  screenshots: z.array(z.string()).optional(),
})
export type Verdict = z.infer<typeof VerdictSchema>

export const DesignOptionsSchema = z.object({
  options: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        /** relative to design/ */
        file: z.string(),
      }),
    )
    .min(2)
    .max(3),
})
export type DesignOptions = z.infer<typeof DesignOptionsSchema>

export const CheckpointSchema = z.object({
  kind: z.enum(['answers', 'spec', 'plan', 'demo', 'help']),
  message: z.string(),
})
export type Checkpoint = z.infer<typeof CheckpointSchema>

export const StepRecordSchema = z.object({
  id: z.string(),
  role: RoleSchema,
  label: z.string(),
  taskId: z.string().optional(),
  attempt: z.number(),
  status: z.enum(['running', 'ok', 'failed', 'interrupted', 'limited']),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  costUsd: z.number().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
})
export type StepRecord = z.infer<typeof StepRecordSchema>

export const ProjectStateSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
  phase: PhaseSchema,
  subStep: SubStepSchema,
  taskIndex: z.number(),
  attempt: z.number(),
  /** fed to the next agent run, cleared after a successful step */
  feedback: z.string().nullable(),
  /** next run must first inspect the interrupted work */
  resumeNote: z.boolean(),
  /** where to return from needs_help */
  help: z.object({ phase: PhaseSchema, subStep: SubStepSchema }).nullable(),
  checkpoint: CheckpointSchema.nullable(),
  demoDone: z.boolean(),
  chosenDesign: z.string().nullable(),
  taskBase: z.string().nullable(),
  /** number of demo-feedback milestones appended */
  feedbackRounds: z.number(),
  paused: z.boolean(),
  limitUntil: z.string().nullable(),
  limitHits: z.number(),
  /** on a rate limit, pause and notify instead of retrying after a backoff (toggle in the panel) */
  pauseOnLimit: z.boolean().default(false),
  error: z.string().nullable(),
  currentStepId: z.string().nullable(),
  steps: z.array(StepRecordSchema),
})
export type ProjectState = z.infer<typeof ProjectStateSchema>

export const UserInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('answers'),
    answers: z.record(z.string(), z.string()),
    secrets: z.record(z.string(), z.string()),
  }),
  z.object({ kind: z.literal('approve'), designId: z.string().optional() }),
  z.object({ kind: z.literal('revise'), comment: z.string() }),
  /** '' = all good */
  z.object({ kind: z.literal('demo'), comments: z.string() }),
  z.object({
    kind: z.literal('help'),
    action: z.enum(['retry', 'skip', 'continue']),
    hint: z.string().optional(),
  }),
])
export type UserInput = z.infer<typeof UserInputSchema>

export const LogEntrySchema = z.object({
  t: z.number(),
  kind: z.enum(['text', 'tool', 'tool_result', 'system', 'result', 'error']),
  text: z.string(),
})
export type LogEntry = z.infer<typeof LogEntrySchema>
