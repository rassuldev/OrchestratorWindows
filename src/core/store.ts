import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { ZodError, type z } from 'zod'
import type { Config } from '../config.js'
import { execGit } from './git.js'
import { projectPaths } from './paths.js'
import { PlanSchema, ProjectStateSchema, type Plan, type ProjectState } from './schemas.js'

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

const MAX_SLUG = 40
const trimDashes = (s: string) => s.replace(/^-+|-+$/g, '')

/** Lowercase, Cyrillic transliterated, non-alphanumerics collapsed to `-`, max 40 chars; empty gives `project`. */
export function slugify(name: string): string {
  const latin = [...name.toLowerCase()].map((c) => CYRILLIC[c] ?? c).join('')
  const slug = trimDashes(trimDashes(latin.replace(/[^a-z0-9]+/g, '-')).slice(0, MAX_SLUG))
  return slug === '' ? 'project' : slug
}

let tmpCounter = 0

/** Writes via a temp file unique to this write, so concurrent writers can never rename each other's file. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await rename(tmp, file)
}

export async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(file, 'utf8')))
}

export async function loadState(dir: string): Promise<ProjectState> {
  return readJson(projectPaths(dir).state, ProjectStateSchema)
}

export async function saveState(dir: string, state: ProjectState): Promise<void> {
  await writeJsonAtomic(projectPaths(dir).state, state)
}

export async function loadPlan(dir: string): Promise<Plan | null> {
  try {
    return await readJson(projectPaths(dir).plan, PlanSchema)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Like loadPlan, but an unreadable or schema-invalid plan.json is reported instead of thrown:
 * `{ plan: null, error }` (error null when the file is simply missing).
 */
export async function loadPlanSafe(dir: string): Promise<{ plan: Plan | null; error: string | null }> {
  try {
    return { plan: await loadPlan(dir), error: null }
  } catch (e) {
    return { plan: null, error: `.orchestrator/plan.json is invalid: ${planErrorMessage(e)}` }
  }
}

function planErrorMessage(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ')
  }
  return e instanceof Error ? e.message : String(e)
}

export async function savePlan(dir: string, plan: Plan): Promise<void> {
  await writeJsonAtomic(projectPaths(dir).plan, plan)
}

/** Claims a fresh `<workspace>/<slug>[-N]` directory (mkdir is the atomic claim). */
async function claimProjectDir(workspace: string, slug: string): Promise<string> {
  await mkdir(workspace, { recursive: true })
  for (let n = 1; ; n++) {
    const dir = join(workspace, n === 1 ? slug : `${slug}-${n}`)
    try {
      await mkdir(dir)
      return dir
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}

/**
 * Why `path` cannot be imported as a project, or null when it can: it must be the top of a git work
 * tree with nothing uncommitted (the clone takes only commits, so local edits would be silently lost).
 */
export async function checkSourceRepo(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return 'path must be absolute'
  let real: string
  try {
    real = await realpath(path)
  } catch {
    return `not found: ${path}`
  }
  let top: string
  try {
    top = (await execGit(real, 'rev-parse', '--show-toplevel')).trim()
  } catch {
    return `not a git repository: ${path}`
  }
  if ((await realpath(top)) !== real) return `not the root of a git repository (root is ${top})`
  if ((await execGit(real, 'status', '--porcelain')).trim() !== '') return `has uncommitted changes: ${path}`
  return null
}

const ORCH_IGNORES = ['.orchestrator/', '.env']

/** Clones `src` into the empty `dir`, drops the remote and makes sure orchestrator files stay untracked. */
async function cloneSource(dir: string, src: string): Promise<void> {
  await execGit(dir, 'clone', '--quiet', src, '.')
  await execGit(dir, 'remote', 'remove', 'origin')
  const gitignore = join(dir, '.gitignore')
  const current = await readFile(gitignore, 'utf8').catch(() => '')
  const lines = new Set(current.split('\n').map((l) => l.trim()))
  const missing = ORCH_IGNORES.filter((l) => !lines.has(l))
  if (missing.length === 0) return
  const sep = current === '' || current.endsWith('\n') ? '' : '\n'
  await appendFile(gitignore, sep + missing.map((l) => `${l}\n`).join(''))
  await execGit(dir, 'add', '.gitignore')
  await execGit(dir, 'commit', '-m', 'chore: orchestrator init')
}

/** Without `sourceRepo` starts an empty repo; with it, continues a clone of that repo (see checkSourceRepo). */
export async function createProject(
  cfg: Config,
  input: { name: string; task: string; sourceRepo?: string },
): Promise<{ dir: string; state: ProjectState }> {
  const dir = await claimProjectDir(cfg.workspace, slugify(input.name))
  const p = projectPaths(dir)
  if (input.sourceRepo !== undefined) await cloneSource(dir, input.sourceRepo)
  for (const sub of [p.logsDir, p.screenshotsDir, p.verdictsDir, p.designDir]) {
    await mkdir(sub, { recursive: true })
  }
  await writeFile(p.task, input.task)
  await writeFile(p.decisions, '')

  if (input.sourceRepo === undefined) {
    await writeFile(join(dir, '.gitignore'), '.orchestrator/\n.env\n')
    await execGit(dir, 'init')
    await execGit(dir, 'add', '-A')
    await execGit(dir, 'commit', '-m', 'chore: init')
  }

  const state: ProjectState = {
    id: randomUUID(),
    slug: basename(dir),
    name: input.name,
    createdAt: new Date().toISOString(),
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
  }
  await saveState(dir, state)
  return { dir, state }
}

/** Project dirs in the workspace that have `.orchestrator/state.json`, newest first. */
export async function listProjects(cfg: Config): Promise<{ dir: string; state: ProjectState }[]> {
  let entries: string[]
  try {
    entries = await readdir(cfg.workspace)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const found: { dir: string; state: ProjectState; born: number }[] = []
  for (const name of entries) {
    const dir = join(cfg.workspace, name)
    try {
      const [state, info] = await Promise.all([loadState(dir), stat(dir)])
      found.push({ dir, state, born: info.birthtimeMs })
    } catch (e) {
      // A missing state.json just means "not a project"; anything else (corrupt JSON,
      // schema mismatch, EACCES) is a real project we cannot read, so say so.
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.warn(`listProjects: skipping ${dir}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  found.sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt) || b.born - a.born)
  return found.map(({ dir, state }) => ({ dir, state }))
}

export async function findProject(cfg: Config, id: string): Promise<string | null> {
  return (await listProjects(cfg)).find((p) => p.state.id === id)?.dir ?? null
}
