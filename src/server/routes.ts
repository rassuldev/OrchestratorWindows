import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { extname, join, relative, sep } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { appRunner } from '../core/appRunner.js'
import type { EventBus } from '../core/events.js'
import { projectPaths } from '../core/paths.js'
import { InvalidInputError } from '../core/pipeline.js'
import type { Scheduler } from '../core/scheduler.js'
import {
  DesignOptionsSchema,
  LogEntrySchema,
  QuestionsSchema,
  UserInputSchema,
  type LogEntry,
  type Plan,
  type ProjectState,
} from '../core/schemas.js'
import { assertEnvKeys, maskSecrets, readSecretValues } from '../core/secrets.js'
import { CheckpointMismatchError } from '../core/stateMachine.js'
import { checkSourceRepo, createProject, findProject, listProjects, loadPlan, loadState, readJson } from '../core/store.js'

export type DisplayStatus = 'running' | 'waiting' | 'paused' | 'rate_limited' | 'error' | 'done' | 'queued'

export const HEARTBEAT_MS = 15_000
/** How long POST /resume waits for the scheduler before answering with the state as saved so far. */
const RESUME_WAIT_MS = 500

const NewProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  task: z.string().trim().min(10),
  /** Absolute path of a local git repo to continue instead of starting from scratch. */
  sourceRepo: z.string().trim().min(1).optional(),
})

const DOCS = ['task', 'spec', 'architecture', 'decisions', 'report', 'readme'] as const
type DocName = (typeof DOCS)[number]

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

/** Content types served as text, so secret values in them can be masked (images stay byte-exact). */
const isTextType = (type: string) => type.includes('charset=') || type.startsWith('image/svg')

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

function isAllowedHost(host: string, ports: number[]): boolean {
  return LOOPBACK_HOSTS.some((name) => ports.some((port) => host === `${name}:${port}`))
}

const ORCH_PREFIX = '.orchestrator/'

/** What the project list shows. Order matters: terminal and blocked states beat "is it the active one". */
export function displayStatus(
  state: ProjectState,
  _plan: Plan | null,
  activeDir: string | null,
  dir: string,
): DisplayStatus {
  if (state.phase === 'done') return 'done'
  if (state.error !== null) return 'error'
  if (state.paused) return 'paused'
  if (state.limitUntil !== null) return 'rate_limited'
  if (state.phase.startsWith('await_') || state.phase === 'needs_help') return 'waiting'
  if (dir === activeDir) return 'running'
  return 'queued'
}

function updatedAt(state: ProjectState): string {
  const last = state.steps.at(-1)
  return last?.endedAt ?? last?.startedAt ?? state.createdAt
}

/** Parses a JSON file against a schema; null when it is missing or invalid. */
async function readOptional<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return await readJson(file, schema)
  } catch {
    return null
  }
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
    throw e
  }
}

type AssetPath = { ok: true; segments: string[] } | { ok: false }

/** Lexical checks on a requested asset path: no absolute paths, backslashes, NULs or `..` segments. */
function parseAssetPath(raw: string): AssetPath {
  if (raw === '' || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) return { ok: false }
  const rel = raw.startsWith(ORCH_PREFIX) ? raw.slice(ORCH_PREFIX.length) : raw
  const segments = rel.split('/')
  if (segments.includes('..')) return { ok: false }
  return { ok: true, segments: segments.filter((s) => s !== '' && s !== '.') }
}

/** PNG files under `.orchestrator/<folder>/` (symlinks skipped), as `<folder>/…` paths with their mtime. */
async function listPngs(orch: string, folder: string): Promise<{ path: string; mtime: number }[]> {
  let names: string[]
  try {
    names = await readdir(join(orch, folder), { recursive: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw e
  }
  const found: { path: string; mtime: number }[] = []
  for (const name of names) {
    if (extname(name).toLowerCase() !== '.png') continue
    const file = join(orch, folder, name)
    const info = await lstat(file).catch(() => null)
    if (!info?.isFile()) continue
    found.push({ path: relative(orch, file).split(sep).join('/'), mtime: info.mtimeMs })
  }
  return found
}

export function buildServer(cfg: Config, deps: { scheduler: Scheduler; bus: EventBus }): FastifyInstance {
  const { scheduler, bus } = deps
  const app = Fastify({ logger: false })
  const boundPort = () => (app.server.address() as AddressInfo | null)?.port ?? cfg.port

  // Tolerate `content-type: application/json` with an empty body (POST pause/resume send none).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined)
    try {
      done(null, JSON.parse(body as string))
    } catch (e) {
      const err = e as Error & { statusCode?: number }
      err.statusCode = 400
      done(err, undefined)
    }
  })

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    if (status < 500) return reply.code(status).send({ error: err.message })
    console.error(`${req.method} ${req.url} failed:`, err)
    return reply.code(status).send({ error: 'Internal error' })
  })

  // DNS-rebinding guard: only requests addressed to this server's own loopback name are served,
  // and state-changing requests must come from the same origin.
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase()
    if (!isAllowedHost(host, [cfg.port, boundPort()])) return reply.code(403).send({ error: 'forbidden host' })
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== undefined) {
      let originHost: string | null = null
      try {
        originHost = new URL(req.headers.origin).host.toLowerCase()
      } catch {
        // "null" and other non-URLs fall through as foreign
      }
      if (originHost !== host) return reply.code(403).send({ error: 'forbidden origin' })
    }
  })

  const notFound = (reply: FastifyReply, what = 'project') => reply.code(404).send({ error: `${what} not found` })

  /** Resolves `:id` to a project dir, or sends 404 and returns null. */
  async function resolveDir(id: string, reply: FastifyReply): Promise<string | null> {
    const dir = await findProject(cfg, id)
    if (dir === null) {
      await notFound(reply)
      return null
    }
    return dir
  }

  app.get('/api/projects', async () => {
    const active = scheduler.activeDir()
    const projects = await listProjects(cfg)
    return Promise.all(
      projects.map(async ({ dir, state }) => ({
        id: state.id,
        name: state.name,
        phase: state.phase,
        displayStatus: displayStatus(state, await loadPlan(dir).catch(() => null), active, dir),
        updatedAt: updatedAt(state),
      })),
    )
  })

  app.post('/api/projects', async (req, reply) => {
    const parsed = NewProjectSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues })
    if (parsed.data.sourceRepo !== undefined) {
      const problem = await checkSourceRepo(parsed.data.sourceRepo)
      if (problem !== null) return reply.code(400).send({ error: `sourceRepo ${problem}` })
    }
    const { dir, state } = await createProject(cfg, parsed.data)
    scheduler.enqueue(dir)
    bus.emitState(state.id, state)
    return reply.code(201).send({ id: state.id })
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    const p = projectPaths(dir)
    const [state, plan, questions, designOptions] = await Promise.all([
      loadState(dir),
      loadPlan(dir).catch(() => null),
      readOptional(p.questions, QuestionsSchema),
      readOptional(p.designOptions, DesignOptionsSchema),
    ])
    return { state, plan, questions, designOptions, app: appRunner.status(dir) }
  })

  app.get<{ Params: { id: string; name: string } }>('/api/projects/:id/doc/:name', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    const name = req.params.name as DocName
    if (!DOCS.includes(name)) return notFound(reply, 'doc')
    const text = await readTextOrNull(projectPaths(dir)[name])
    if (text === null) return notFound(reply, 'doc')
    // Agents write these docs and may have copied a secret into them.
    return reply.type('text/markdown; charset=utf-8').send(maskSecrets(text, await readSecretValues(dir)))
  })

  app.get<{ Params: { id: string; '*': string } }>('/api/projects/:id/asset/*', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    const parsed = parseAssetPath(req.params['*'])
    if (!parsed.ok) return reply.code(400).send({ error: 'invalid asset path' })
    if (parsed.segments.length === 0) return notFound(reply, 'asset')

    const { orch } = projectPaths(dir)
    const file = join(orch, ...parsed.segments)
    let real: string
    let orchReal: string
    try {
      orchReal = await realpath(orch)
      real = await realpath(file)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return notFound(reply, 'asset')
      throw e
    }
    // A symlink inside .orchestrator/ must not lead out of it.
    if (!real.startsWith(orchReal + sep)) return reply.code(400).send({ error: 'invalid asset path' })
    if (!(await stat(real)).isFile()) return notFound(reply, 'asset')

    const type = CONTENT_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream'
    reply.type(type).header('x-content-type-options', 'nosniff')
    // Agent-written pages may run scripts, but in an opaque origin: they cannot call /api.
    if (type.startsWith('text/html') || type.startsWith('image/svg')) {
      reply.header('content-security-policy', 'sandbox allow-scripts')
    }
    const body = await readFile(real)
    if (!isTextType(type)) return reply.send(body)
    return reply.send(maskSecrets(body.toString('utf8'), await readSecretValues(dir)))
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id/screenshots', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    const { orch } = projectPaths(dir)
    const shots = (await Promise.all([listPngs(orch, 'screenshots'), listPngs(orch, 'design')])).flat()
    return shots.sort((a, b) => b.mtime - a.mtime).map((s) => s.path)
  })

  app.get<{ Params: { id: string; stepId: string } }>('/api/projects/:id/logs/:stepId', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    if (!/^[\w-]+$/.test(req.params.stepId)) return reply.code(400).send({ error: 'invalid step id' })
    const text = await readTextOrNull(join(projectPaths(dir).logsDir, `${req.params.stepId}.jsonl`))
    const entries: LogEntry[] = []
    for (const line of (text ?? '').split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = LogEntrySchema.safeParse(JSON.parse(line))
        if (parsed.success) entries.push(parsed.data)
      } catch {
        // a half-written last line is skipped
      }
    }
    return entries
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/input', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    const parsed = UserInputSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', issues: parsed.error.issues })
    try {
      if (parsed.data.kind === 'answers') assertEnvKeys(parsed.data.secrets)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    try {
      return { state: await scheduler.input(dir, parsed.data) }
    } catch (e) {
      if (e instanceof CheckpointMismatchError) return reply.code(409).send({ error: e.message })
      if (e instanceof InvalidInputError) return reply.code(400).send({ error: e.message })
      throw e
    }
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/pause', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    await scheduler.pause(dir)
    return { state: await loadState(dir) }
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/pause-on-limit', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input', issues: parsed.error.issues })
    await scheduler.setPauseOnLimit(dir, parsed.data.enabled)
    return { state: await loadState(dir) }
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/resume', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    // scheduler.resume waits for the project's active step to wind down; don't hold the request for that.
    const outcome = scheduler.resume(dir).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let timer: NodeJS.Timeout | undefined
    const first = await Promise.race([outcome, new Promise<'late'>((res) => (timer = setTimeout(() => res('late'), RESUME_WAIT_MS)))])
    clearTimeout(timer)
    if (first === 'late') {
      void outcome.then((o) => {
        if (!o.ok) console.error(`resume of ${dir} failed after the response was sent:`, o.error)
      })
    } else if (!first.ok) {
      throw first.error
    }
    return { state: await loadState(dir) }
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/app/start', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    const plan = await loadPlan(dir).catch(() => null)
    if (!plan || plan.runCommand.trim() === '') return reply.code(409).send({ error: 'project has no run command yet' })
    const { url } = await appRunner.start(dir, plan.runCommand)
    return { running: appRunner.status(dir).running, url }
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/app/stop', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    await appRunner.stop(dir)
    return appRunner.status(dir)
  })

  const streams = new Set<() => void>()
  app.addHook('preClose', async () => {
    for (const close of [...streams]) close()
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id/events', async (req, reply) => {
    const dir = await resolveDir(req.params.id, reply)
    if (dir === null) return
    const id = req.params.id

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    // Listeners must never throw: they run inside the runner's and scheduler's emit calls.
    const write = (chunk: () => string) => {
      try {
        raw.write(chunk())
      } catch {
        // an unserialisable payload or a dead socket; the close handler cleans up
      }
    }
    const onState = (stateId: string, state: ProjectState) => {
      if (stateId === id) write(() => `event: state\ndata: ${JSON.stringify(state)}\n\n`)
    }
    const onLog = (logId: string, stepId: string, entry: LogEntry) => {
      if (logId === id) write(() => `event: log\ndata: ${JSON.stringify({ stepId, entry })}\n\n`)
    }
    const heartbeat = setInterval(() => write(() => ': ping\n\n'), HEARTBEAT_MS)
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      bus.off('state', onState)
      bus.off('log', onLog)
      streams.delete(cleanup)
      try {
        raw.end()
      } catch {
        // already closed
      }
    }
    streams.add(cleanup)
    raw.on('close', cleanup)
    raw.on('error', cleanup)

    // Listen before reading, so an update made meanwhile is delivered (the state read is at least as new).
    bus.on('state', onState)
    bus.on('log', onLog)
    try {
      const initial = await loadState(dir)
      write(() => `event: state\ndata: ${JSON.stringify(initial)}\n\n`)
    } catch (e) {
      console.error(`events: cannot read the state of ${dir}:`, e)
      cleanup()
    }
  })

  return app
}
