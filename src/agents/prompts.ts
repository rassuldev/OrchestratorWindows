import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { projectPaths, type ProjectPaths } from '../core/paths.js'
import { DesignOptionsSchema, QuestionsSchema, type Plan, type ProjectState, type Role, type Task } from '../core/schemas.js'
import { MAX_BUILD_ATTEMPTS, flattenTasks } from '../core/stateMachine.js'
import { readJson } from '../core/store.js'

const { join } = posix

/**
 * `C:\\x\\y` -> `C:/x/y`. Agents' Bash commands run in Git Bash, where an unquoted backslash is an
 * escape; Windows itself and the Read/Write tools accept forward slashes. Prompts show only these.
 */
export const slashPath = (p: string): string => p.replaceAll('\\', '/')

function slashPaths(paths: ProjectPaths): ProjectPaths {
  return Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, slashPath(v)])) as unknown as ProjectPaths
}

export interface PromptContext {
  dir: string
  state: ProjectState
  plan: Plan | null
  orchestratorRoot: string
}

export interface BuiltPrompt {
  system: string
  prompt: string
  verdictFile?: string
}

type PathKey = keyof ProjectPaths
/** A ProjectPaths key, or a path relative to the project root for files outside `.orchestrator`. */
type FileRef = PathKey | { rel: string }

/** The files each role reads first and the ones it writes (decisions.md is appended by everyone). */
const FILES: Record<Role, { read: FileRef[]; write: FileRef[] }> = {
  analyst_questions: { read: ['task', 'decisions'], write: ['questions', 'decisions'] },
  analyst_spec: { read: ['task', 'questions', 'answers', 'decisions'], write: ['spec', 'decisions'] },
  architect: {
    // architecture.md and plan.json exist when the user asked for a revision
    read: ['task', 'spec', 'architecture', 'plan', 'decisions'],
    write: ['architecture', 'plan', 'decisions'],
  },
  designer: {
    // design/ already holds the previous options when the user asked for a revision
    read: ['task', 'spec', 'architecture', 'plan', 'designOptions', 'decisions'],
    write: ['designDir', 'designOptions', 'decisions'],
  },
  implementer: { read: ['task', 'spec', 'architecture', 'plan', 'decisions', 'followups'], write: ['decisions', 'followups'] },
  verifier: { read: ['task', 'spec', 'architecture', 'plan', 'decisions'], write: ['decisions'] },
  reviewer: { read: ['task', 'spec', 'architecture', 'plan', 'decisions', 'followups'], write: ['decisions'] },
  finalizer: {
    read: ['task', 'questions', 'spec', 'architecture', 'plan', 'decisions', 'followups'],
    write: ['readme', 'report', { rel: 'docs/' }, { rel: '.env.example' }, 'decisions', 'followups'],
  },
}

const BUILD_ROLES: Role[] = ['implementer', 'verifier', 'reviewer']
const TOOL_ROLES: Role[] = ['designer', 'implementer', 'verifier']

const RESUME_NOTE =
  'A previous run of this step was interrupted. First inspect `git status` and the working tree, keep good work, then finish the step.'

function currentTask(
  plan: Plan | null,
  taskIndex: number,
): { plan: Plan; task: Task; index: number; total: number; milestone: string } {
  if (!plan) throw new Error('build roles require a plan')
  const tasks = flattenTasks(plan)
  const task = tasks[taskIndex]
  if (!task) throw new Error(`no task at index ${taskIndex} (plan has ${tasks.length})`)
  const m = plan.milestones.find((ms) => ms.tasks.some((t) => t.id === task.id))!
  const milestone = `${m.id} "${m.title}"${m.mvp ? ', the MVP milestone' : ''}`
  return { plan, task, index: taskIndex, total: tasks.length, milestone }
}

function planLines(plan: Plan): string {
  return `PLATFORM: ${plan.platform} (hasUI: ${plan.hasUI})\nTEST_COMMAND: ${plan.testCommand}\nRUN_COMMAND: ${plan.runCommand}`
}

async function chosenDesignLine(p: ProjectPaths, id: string): Promise<string> {
  try {
    const opt = (await readJson(p.designOptions, DesignOptionsSchema)).options.find((o) => o.id === id)
    if (opt) {
      const shot = (size: string) => join(p.designDir, `${id}-${size}.png`)
      return `CHOSEN_DESIGN: ${join(p.designDir, opt.file)}\n(the user picked option "${id}"; its screenshots, if present: ${shot('desktop')}, ${shot('mobile')})`
    }
  } catch {
    // fall through to the directory hint
  }
  return `CHOSEN_DESIGN: option "${id}" in ${p.designDir} (options.json could not be read; find that option's HTML file in the directory)`
}

async function secretsBlock(p: ProjectPaths): Promise<string | null> {
  const questions = await readJson(p.questions, QuestionsSchema).catch(() => null)
  if (!questions || questions.secrets.length === 0) return null
  return [
    `SECRETS: the user was asked for these values; whatever they provided is in ${p.env} (KEY=value lines).`,
    'Load them at runtime from the environment / .env. Never print, log, copy or commit the values.',
    ...questions.secrets.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n')
}

function toolsBlock(root: string): string {
  return [
    'TOOLS (run each as its own Bash command with the absolute path exactly as shown):',
    `- ${root}/bin/orch-shot <url> <outDir> — screenshots a page (http(s):// or file://) as <outDir>/desktop.png (1440 wide, full page) and <outDir>/mobile.png (390 wide only if the page sets a viewport meta tag; otherwise it renders at 980 wide, which is itself a mobile defect); prints both paths. Open the PNGs with the Read tool to look at them.`,
  ].join('\n')
}

export async function buildPrompt(role: Role, ctx: PromptContext): Promise<BuiltPrompt> {
  const { state, plan } = ctx
  const dir = slashPath(ctx.dir)
  const orchestratorRoot = slashPath(ctx.orchestratorRoot)
  const p = slashPaths(projectPaths(ctx.dir))
  const promptsDir = join(orchestratorRoot, 'prompts')
  const [common, rolePrompt] = await Promise.all([
    readFile(join(promptsDir, '_common.md'), 'utf8'),
    readFile(join(promptsDir, `${role}.md`), 'utf8'),
  ])
  const system = `ROLE: ${role}\n${common.trimEnd()}\n\n${rolePrompt.trimEnd()}\n`

  const header: string[] = [
    `Project "${state.name}". You are the ${role} step.`,
    `PROJECT_DIR: ${dir} (your working directory, a git repository)`,
  ]
  const sections: string[] = []
  let verdictFile: string | undefined

  if (BUILD_ROLES.includes(role)) {
    const { plan: buildPlan, task, index, total, milestone } = currentTask(plan, state.taskIndex)
    header.push(`TASK_ID: ${task.id}`, `ATTEMPT: ${state.attempt} of ${MAX_BUILD_ATTEMPTS}`)
    if (role === 'verifier' || role === 'reviewer') {
      const kind = role === 'verifier' ? 'verify' : 'review'
      verdictFile = join(p.verdictsDir, `${task.id}-a${state.attempt}-${kind}.json`)
      header.push(`VERDICT_FILE: ${verdictFile}`)
    }
    if (role === 'reviewer') {
      if (!state.taskBase) throw new Error('reviewer requires state.taskBase (the commit before the task started)')
      header.push(`BASE_COMMIT: ${state.taskBase}`)
    }
    const { id, title, description, acceptance, verify } = task
    sections.push(
      planLines(buildPlan),
      [
        `CURRENT TASK (${index + 1} of ${total}, milestone ${milestone}):`,
        '```json',
        JSON.stringify({ id, title, description, acceptance, verify }, null, 2),
        '```',
        'Tasks before this one are implemented and committed; tasks after it are out of scope for this run.',
      ].join('\n'),
    )
    if (role === 'verifier') sections.push(`SCREENSHOTS_DIR: ${join(p.screenshotsDir, `${task.id}-a${state.attempt}`)}`)
    if (role === 'implementer') sections.push(`SCREENSHOTS_DIR: ${join(p.screenshotsDir, `${task.id}-impl`)}`)
    if (state.chosenDesign) sections.push(await chosenDesignLine(p, state.chosenDesign))
  } else if (plan) {
    sections.push(planLines(plan))
  }

  const files = FILES[role]
  const path = (f: FileRef) => `- ${typeof f === 'string' ? p[f] : join(dir, f.rel)}`
  sections.unshift(
    ['Read these files first (a file that does not exist yet is simply not produced yet):', ...files.read.map(path)].join('\n'),
    ['You write:', ...files.write.map(path), ...(verdictFile ? [`- ${verdictFile}`] : [])].join('\n'),
  )

  const secrets = await secretsBlock(p)
  if (secrets) sections.push(secrets)
  if (TOOL_ROLES.includes(role)) sections.push(toolsBlock(orchestratorRoot))
  if (state.resumeNote) sections.push(RESUME_NOTE)
  // Feedback goes last so line-oriented parsers find the header lines first.
  if (state.feedback) sections.push(`FEEDBACK:\n${state.feedback}`)
  sections.push('Do the whole step now, in this run, following your role instructions.')

  return { system, prompt: `${header.join('\n')}\n\n${sections.join('\n\n')}\n`, verdictFile }
}
