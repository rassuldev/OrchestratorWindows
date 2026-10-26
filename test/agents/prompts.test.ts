import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPrompt, slashPath } from '../../src/agents/prompts.js'
import { projectPaths } from '../../src/core/paths.js'
import { RoleSchema, type Plan, type ProjectState, type Role } from '../../src/core/schemas.js'

const orchestratorRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const BUILD_ROLES: Role[] = ['implementer', 'verifier', 'reviewer']

function state(over: Partial<ProjectState> = {}): ProjectState {
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

const plan: Plan = {
  platform: 'web',
  hasUI: true,
  runCommand: 'npm start',
  testCommand: 'npm test',
  milestones: [
    {
      id: 'm1',
      title: 'Core',
      mvp: true,
      tasks: [
        { id: 't1', title: 'Skeleton', description: 'Set up the app', acceptance: ['npm start serves a page'], verify: ['npm test'] },
        { id: 't2', title: 'List todos', description: 'Show todos', acceptance: ['todos are listed'], verify: ['npx vitest run todos'] },
      ],
    },
  ],
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orch-prompts-'))
  await mkdir(projectPaths(dir).designDir, { recursive: true })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const ctx = (s: Partial<ProjectState> = {}, p: Plan | null = null) => ({ dir, state: state(s), plan: p, orchestratorRoot })
const buildCtx = (s: Partial<ProjectState> = {}) =>
  ctx({ phase: 'build', taskIndex: 0, attempt: 2, taskBase: 'abc1234', ...s }, plan)
const ctxFor = (r: Role) => (BUILD_ROLES.includes(r) ? buildCtx() : ctx())

describe('buildPrompt', () => {
  it('system starts with ROLE line, then the common and the role prompt', async () => {
    const { system } = await buildPrompt('architect', ctx())
    expect(system.split('\n')[0]).toBe('ROLE: architect')
    expect(system).toMatch(/decisions\.md/)
    expect(system).toMatch(/plan\.json/)
    expect(system).toMatch(/mvp/)
  })

  it('every role has a prompt file', async () => {
    for (const r of RoleSchema.options) {
      const res = await buildPrompt(r, ctxFor(r))
      expect(res.system.split('\n')[0]).toBe(`ROLE: ${r}`)
      expect(res.prompt.length).toBeGreaterThan(0)
    }
  })

  it('verifier prompt has TASK_ID and VERDICT_FILE for current attempt', async () => {
    const r = await buildPrompt('verifier', buildCtx())
    expect(r.prompt).toContain('TASK_ID: t1')
    expect(r.verdictFile).toBe(join(projectPaths(dir).verdictsDir, 't1-a2-verify.json'))
    expect(r.prompt).toContain(`VERDICT_FILE: ${r.verdictFile}`)
  })

  it('TASK_ID and VERDICT_FILE lines parse the way fake-claude parses them', async () => {
    const r = await buildPrompt('verifier', buildCtx({ feedback: 'Verifier found:\n- broken' }))
    const line = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(r.prompt)?.[1].trim()
    expect(line('TASK_ID')).toBe('t1')
    expect(line('VERDICT_FILE')).toBe(r.verdictFile)
  })

  it('reviewer gets BASE_COMMIT and a review verdict file', async () => {
    const r = await buildPrompt('reviewer', buildCtx({ taskIndex: 1, attempt: 1 }))
    expect(r.prompt).toContain('TASK_ID: t2')
    expect(r.prompt).toContain('BASE_COMMIT: abc1234')
    expect(r.verdictFile).toBe(join(projectPaths(dir).verdictsDir, 't2-a1-review.json'))
    expect(r.prompt).toContain(`VERDICT_FILE: ${r.verdictFile}`)
  })

  it('reviewer without a task base is an error', async () => {
    await expect(buildPrompt('reviewer', buildCtx({ taskBase: null }))).rejects.toThrow(/taskBase/)
  })

  it('non-review roles get no verdict file', async () => {
    for (const r of ['implementer', 'architect'] as Role[]) {
      const res = await buildPrompt(r, ctxFor(r))
      expect(res.verdictFile).toBeUndefined()
      expect(res.prompt).not.toContain('VERDICT_FILE:')
    }
    expect((await buildPrompt('architect', ctx())).prompt).not.toContain('TASK_ID:')
  })

  it('build prompt carries the task JSON, commands and platform', async () => {
    const { prompt } = await buildPrompt('implementer', buildCtx({ taskIndex: 1 }))
    expect(prompt).toContain('TASK_ID: t2')
    expect(prompt).toContain('"title": "List todos"')
    expect(prompt).toContain('"description": "Show todos"')
    expect(prompt).toContain('"todos are listed"')
    expect(prompt).toContain('"npx vitest run todos"')
    expect(prompt).toContain('TEST_COMMAND: npm test')
    expect(prompt).toContain('RUN_COMMAND: npm start')
    expect(prompt).toContain('PLATFORM: web')
  })

  it('build roles throw without a plan or with the task index out of range', async () => {
    await expect(buildPrompt('implementer', ctx({ phase: 'build' }, null))).rejects.toThrow(/plan/)
    await expect(buildPrompt('verifier', ctx({ phase: 'build', taskIndex: 5, taskBase: 'x' }, plan))).rejects.toThrow(/index 5/)
  })

  it('includes FEEDBACK block only when feedback is set', async () => {
    expect((await buildPrompt('analyst_spec', ctx())).prompt).not.toContain('FEEDBACK:')
    const { prompt } = await buildPrompt('analyst_spec', ctx({ feedback: 'User asked for changes:\nAdd dark mode' }))
    expect(prompt).toContain('FEEDBACK:\nUser asked for changes:\nAdd dark mode')
  })

  it('includes the resume block when resumeNote', async () => {
    const note =
      'A previous run of this step was interrupted. First inspect `git status` and the working tree, keep good work, then finish the step.'
    expect((await buildPrompt('implementer', buildCtx())).prompt).not.toContain(note)
    expect((await buildPrompt('implementer', buildCtx({ resumeNote: true }))).prompt).toContain(note)
  })

  it('lists absolute paths of the .orchestrator files the role uses', async () => {
    const p = projectPaths(dir)
    const architect = (await buildPrompt('architect', ctx())).prompt
    for (const f of [p.task, p.spec, p.decisions, p.architecture, p.plan]) expect(architect).toContain(f)
    const questions = (await buildPrompt('analyst_questions', ctx())).prompt
    for (const f of [p.task, p.questions, p.decisions]) expect(questions).toContain(f)
    const spec = (await buildPrompt('analyst_spec', ctx())).prompt
    for (const f of [p.task, p.questions, p.answers, p.spec]) expect(spec).toContain(f)
    const designer = (await buildPrompt('designer', ctx())).prompt
    for (const f of [p.spec, p.plan, p.designDir, p.designOptions]) expect(designer).toContain(f)
    const finalizer = (await buildPrompt('finalizer', ctx({ phase: 'finalize' }, plan))).prompt
    for (const f of [p.spec, p.architecture, p.decisions, p.readme, p.report]) expect(finalizer).toContain(f)
  })

  it('gives the tool commands with absolute paths to the roles that take screenshots', async () => {
    for (const r of ['designer', 'verifier'] as Role[]) {
      const { prompt } = await buildPrompt(r, ctxFor(r))
      expect(prompt).toContain(`${orchestratorRoot}/bin/orch-shot <url> <outDir>`)
      expect(prompt).not.toContain('orch-sim')
    }
  })

  it('slashPath turns Windows separators into forward slashes for Git Bash', () => {
    expect(slashPath('C:\\Users\\me\\proj\\.orchestrator\\spec.md')).toBe('C:/Users/me/proj/.orchestrator/spec.md')
    expect(slashPath('/already/posix')).toBe('/already/posix')
  })

  it('roles without screenshot work get no TOOLS block', async () => {
    for (const r of ['analyst_questions', 'analyst_spec', 'architect', 'reviewer', 'finalizer'] as Role[]) {
      const ctxR = r === 'finalizer' ? ctx({ phase: 'finalize' }, plan) : ctxFor(r)
      const { prompt } = await buildPrompt(r, ctxR)
      expect(prompt).not.toContain('TOOLS')
      expect(prompt).not.toContain('orch-shot')
    }
  })

  it('architect and designer read their previous outputs (revise mode)', async () => {
    const p = projectPaths(dir)
    const readSection = (prompt: string) => prompt.slice(prompt.indexOf('Read these files first'), prompt.indexOf('You write:'))
    const architect = readSection((await buildPrompt('architect', ctx())).prompt)
    expect(architect).toContain(p.architecture)
    expect(architect).toContain(p.plan)
    expect(readSection((await buildPrompt('designer', ctx({}, plan))).prompt)).toContain(p.designOptions)
  })

  it('finalizer writes docs/ and .env.example in the project root', async () => {
    const { prompt } = await buildPrompt('finalizer', ctx({ phase: 'finalize' }, plan))
    const writes = prompt.slice(prompt.indexOf('You write:'))
    expect(writes).toContain(`- ${join(dir, 'docs')}/`)
    expect(writes).toContain(`- ${join(dir, '.env.example')}`)
  })

  it('implementer gets its own screenshots directory under .orchestrator', async () => {
    const { prompt } = await buildPrompt('implementer', buildCtx())
    expect(prompt).toContain(`SCREENSHOTS_DIR: ${join(projectPaths(dir).screenshotsDir, 't1-impl')}`)
  })

  it('verifier gets a per-attempt screenshots directory', async () => {
    const { prompt } = await buildPrompt('verifier', buildCtx())
    expect(prompt).toContain(join(projectPaths(dir).screenshotsDir, 't1-a2'))
  })

  it('implementer, verifier and reviewer get the chosen design HTML file from options.json', async () => {
    const p = projectPaths(dir)
    await writeFile(
      p.designOptions,
      JSON.stringify({
        options: [
          { id: 'a', title: 'A', description: 'a', file: 'a.html' },
          { id: 'b', title: 'B', description: 'b', file: 'bold.html' },
        ],
      }),
    )
    for (const r of ['implementer', 'verifier', 'reviewer'] as Role[]) {
      const { prompt } = await buildPrompt(r, buildCtx({ chosenDesign: 'b' }))
      expect(prompt).toContain(`CHOSEN_DESIGN: ${join(p.designDir, 'bold.html')}`)
    }
    expect((await buildPrompt('implementer', buildCtx())).prompt).not.toContain('CHOSEN_DESIGN')
  })

  it('falls back to the design directory and id when options.json is unreadable', async () => {
    const { prompt } = await buildPrompt('implementer', buildCtx({ chosenDesign: 'b' }))
    expect(prompt).toContain('CHOSEN_DESIGN:')
    expect(prompt).toContain(projectPaths(dir).designDir)
    expect(prompt).toContain('"b"')
  })

  it('names the .env secrets from questions.json, never their values', async () => {
    const p = projectPaths(dir)
    await writeFile(
      p.questions,
      JSON.stringify({ questions: [], secrets: [{ name: 'OPENAI_API_KEY', description: 'LLM calls' }] }),
    )
    await writeFile(p.env, 'OPENAI_API_KEY=sk-very-secret-value\n')
    const { prompt } = await buildPrompt('implementer', buildCtx())
    expect(prompt).toContain(p.env)
    expect(prompt).toContain('OPENAI_API_KEY')
    expect(prompt).not.toContain('sk-very-secret-value')
  })
})
