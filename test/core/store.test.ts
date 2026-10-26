import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  checkSourceRepo,
  createProject,
  findProject,
  listProjects,
  loadPlan,
  loadPlanSafe,
  loadState,
  readJson,
  saveState,
  savePlan,
  slugify,
} from '../../src/core/store.js'
import { execGit } from '../../src/core/git.js'
import { projectPaths } from '../../src/core/paths.js'
import { ProjectStateSchema, type Plan } from '../../src/core/schemas.js'
import type { Config } from '../../src/config.js'
import { z } from 'zod'

let workspace: string
let cfg: Config

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'orch-store-'))
  cfg = { orchestratorRoot: '/unused', workspace, port: 4321, claudeBin: 'claude', stepTimeoutMin: 45 }
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

const plan: Plan = {
  platform: 'web',
  hasUI: true,
  runCommand: 'npm start',
  testCommand: 'npm test',
  milestones: [
    {
      id: 'm1',
      title: 'MVP',
      mvp: true,
      tasks: [{ id: 't1', title: 'T', description: 'D', acceptance: ['a'], verify: [] }],
    },
  ],
}

it('slugify', () => {
  expect(slugify('Мой сайт!')).toBe('moy-sayt')
  expect(slugify('Todo App 2')).toBe('todo-app-2')
  expect(slugify('!!!')).toBe('project')
  expect(slugify('a'.repeat(60))).toHaveLength(40)
  expect(slugify(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39))
})

it('createProject makes a git repo with gitignore, task.md and queued state', async () => {
  const { dir, state } = await createProject(cfg, { name: 'Мой сайт', task: 'Сделай сайт' })
  expect(basename(dir)).toBe('moy-sayt')
  const gi = await readFile(join(dir, '.gitignore'), 'utf8')
  expect(gi).toBe('.orchestrator/\n.env\n')
  const p = projectPaths(dir)
  expect(await readFile(p.task, 'utf8')).toBe('Сделай сайт')
  expect(await readFile(p.decisions, 'utf8')).toBe('')
  for (const sub of [p.logsDir, p.screenshotsDir, p.verdictsDir, p.designDir]) {
    expect(await exists(sub)).toBe(true)
  }
  expect(state).toMatchObject({
    slug: 'moy-sayt',
    name: 'Мой сайт',
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
  })
  expect(ProjectStateSchema.parse(await loadState(dir))).toEqual(state)
  expect((await execGit(dir, 'log', '--oneline')).trim()).toMatch(/chore: init/)
  expect((await execGit(dir, 'status', '--porcelain')).trim()).toBe('')
})

it('same name twice gives moy-sayt-2', async () => {
  const a = await createProject(cfg, { name: 'Мой сайт', task: 'x' })
  const b = await createProject(cfg, { name: 'Мой сайт', task: 'y' })
  expect(basename(a.dir)).toBe('moy-sayt')
  expect(basename(b.dir)).toBe('moy-sayt-2')
  expect(b.state.slug).toBe('moy-sayt-2')
  expect(b.state.id).not.toBe(a.state.id)
})

/** A source repo outside the workspace with one commit and the given .gitignore. */
async function sourceRepo(gitignore: string): Promise<string> {
  const src = await mkdtemp(join(tmpdir(), 'orch-src-'))
  await writeFile(join(src, '.gitignore'), gitignore)
  await writeFile(join(src, 'main.swift'), 'print("hi")\n')
  await execGit(src, 'init')
  await execGit(src, 'add', '-A')
  await execGit(src, 'commit', '-m', 'first')
  return src
}

it('createProject with sourceRepo clones it with history and extends .gitignore', async () => {
  const src = await sourceRepo('build/\n')
  try {
    const { dir } = await createProject(cfg, { name: 'Drone', task: 'Finish the game', sourceRepo: src })
    expect(await readFile(join(dir, 'main.swift'), 'utf8')).toBe('print("hi")\n')
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('build/\n.orchestrator/\n.env\n')
    expect(await readFile(projectPaths(dir).task, 'utf8')).toBe('Finish the game')
    const log = (await execGit(dir, 'log', '--format=%s')).trim().split('\n')
    expect(log).toEqual(['chore: orchestrator init', 'first'])
    expect((await execGit(dir, 'status', '--porcelain')).trim()).toBe('')
    expect((await execGit(dir, 'remote')).trim()).toBe('') // nothing to push back to by accident
    expect((await execGit(src, 'log', '--format=%s')).trim()).toBe('first') // source untouched
  } finally {
    await rm(src, { recursive: true, force: true })
  }
})

it('createProject with sourceRepo skips the init commit when .gitignore already covers it', async () => {
  const src = await sourceRepo('.orchestrator/\n.env\n')
  try {
    const { dir } = await createProject(cfg, { name: 'Drone', task: 't', sourceRepo: src })
    expect((await execGit(dir, 'log', '--format=%s')).trim()).toBe('first')
  } finally {
    await rm(src, { recursive: true, force: true })
  }
})

it('checkSourceRepo rejects relative, missing, non-git and dirty paths', async () => {
  const src = await sourceRepo('')
  try {
    expect(await checkSourceRepo(src)).toBeNull()
    expect(await checkSourceRepo('relative/path')).toMatch(/absolute/)
    expect(await checkSourceRepo(join(src, 'nope'))).toMatch(/not found/)
    expect(await checkSourceRepo(workspace)).toMatch(/git/)
    await writeFile(join(src, 'main.swift'), 'changed\n')
    expect(await checkSourceRepo(src)).toMatch(/uncommitted/)
  } finally {
    await rm(src, { recursive: true, force: true })
  }
})

it('saveState is atomic and round-trips; no .tmp left behind', async () => {
  const { dir, state } = await createProject(cfg, { name: 'App', task: 't' })
  const next = { ...state, phase: 'spec' as const, feedback: 'fix it', attempt: 2 }
  await saveState(dir, next)
  expect(await loadState(dir)).toEqual(next)
  expect(await readdir(projectPaths(dir).orch)).not.toContain('state.json.tmp')
})

it('listProjects returns both projects, newest first, ignoring foreign dirs', async () => {
  const a = await createProject(cfg, { name: 'First', task: 't' })
  await new Promise((r) => setTimeout(r, 15))
  const b = await createProject(cfg, { name: 'Second', task: 't' })
  await mkdir(join(workspace, 'not-a-project'))
  const list = await listProjects(cfg)
  expect(list.map((p) => p.dir)).toEqual([b.dir, a.dir])
  expect(list[0]!.state.id).toBe(b.state.id)
})

it('listProjects skips a dir with an invalid state.json and warns naming it', async () => {
  const good = await createProject(cfg, { name: 'Good', task: 't' })
  const bad = await createProject(cfg, { name: 'Bad', task: 't' })
  await writeFile(projectPaths(bad.dir).state, '{ not json')
  const schemaBad = await createProject(cfg, { name: 'Schema', task: 't' })
  await writeFile(projectPaths(schemaBad.dir).state, JSON.stringify({ id: 1 }))
  await mkdir(join(workspace, 'not-a-project'))

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const list = await listProjects(cfg)
    expect(list.map((p) => p.dir)).toEqual([good.dir])
    expect(await findProject(cfg, bad.state.id)).toBeNull()
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes(bad.dir))).toBe(true)
    expect(messages.some((m) => m.includes(schemaBad.dir))).toBe(true)
    expect(messages.some((m) => m.includes('not-a-project'))).toBe(false)
  } finally {
    warn.mockRestore()
  }
})

it('listProjects on a missing workspace returns []', async () => {
  expect(await listProjects({ ...cfg, workspace: join(workspace, 'nope') })).toEqual([])
})

it('findProject locates a dir by state id', async () => {
  const a = await createProject(cfg, { name: 'First', task: 't' })
  const b = await createProject(cfg, { name: 'Second', task: 't' })
  expect(await findProject(cfg, b.state.id)).toBe(b.dir)
  expect(await findProject(cfg, a.state.id)).toBe(a.dir)
  expect(await findProject(cfg, 'missing')).toBeNull()
})

it('readJson validates against the schema', async () => {
  const f = join(workspace, 'x.json')
  await writeFile(f, JSON.stringify({ a: 1 }))
  expect(await readJson(f, z.object({ a: z.number() }))).toEqual({ a: 1 })
  await expect(readJson(f, z.object({ a: z.string() }))).rejects.toThrow()
})

it('loadPlan returns null when absent; savePlan round-trips', async () => {
  const { dir } = await createProject(cfg, { name: 'App', task: 't' })
  expect(await loadPlan(dir)).toBeNull()
  await savePlan(dir, plan)
  expect(await loadPlan(dir)).toEqual(plan)
  expect(await readdir(projectPaths(dir).orch)).not.toContain('plan.json.tmp')
})

it('loadPlanSafe reports an unreadable or schema-invalid plan instead of throwing', async () => {
  const { dir } = await createProject(cfg, { name: 'Safe', task: 't' })
  expect(await loadPlanSafe(dir)).toEqual({ plan: null, error: null })
  await savePlan(dir, plan)
  expect(await loadPlanSafe(dir)).toEqual({ plan, error: null })
  await writeFile(projectPaths(dir).plan, '{ nope')
  expect((await loadPlanSafe(dir)).error).toMatch(/^\.orchestrator\/plan\.json is invalid: /)
  await writeFile(projectPaths(dir).plan, JSON.stringify({ ...plan, milestones: [] }))
  const r = await loadPlanSafe(dir)
  expect(r.plan).toBeNull()
  expect(r.error).toContain('milestones:')
})

it('concurrent saveState/savePlan calls never collide on a temp file and leave no temp files behind', async () => {
  const { dir, state } = await createProject(cfg, { name: 'Race', task: 'Make a small CLI tool' })
  await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => saveState(dir, { ...state, name: `n${i}` })),
    ...Array.from({ length: 20 }, () => savePlan(dir, plan)),
  ])
  expect((await loadState(dir)).name).toMatch(/^n\d+$/)
  expect(await loadPlan(dir)).toEqual(plan)
  expect((await readdir(projectPaths(dir).orch)).filter((f) => f.endsWith('.tmp'))).toEqual([])
})
