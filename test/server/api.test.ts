import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance, InjectOptions } from 'fastify'
import type { Config } from '../../src/config.js'
import { appRunner, stopAll } from '../../src/core/appRunner.js'
import { EventBus } from '../../src/core/events.js'
import type { ProjectRunner, RunStatus } from '../../src/core/pipeline.js'
import { projectPaths } from '../../src/core/paths.js'
import { Scheduler } from '../../src/core/scheduler.js'
import type { Plan, ProjectState } from '../../src/core/schemas.js'
import { createProject, loadState, savePlan, saveState } from '../../src/core/store.js'
import { buildServer, displayStatus, HEARTBEAT_MS } from '../../src/server/routes.js'

const ROOT = resolve(import.meta.dirname, '../..')

let workspace: string
let cfg: Config
let bus: EventBus
let scheduler: Scheduler
let app: FastifyInstance
/** `app.inject` addressed to the configured host, like a browser on http://localhost:4321. */
const inject = (opts: InjectOptions) =>
  app.inject({ authority: 'localhost:4321', ...opts })
/** Runs that the stub runner is currently blocked in, released by `release()`. */
let blockers: (() => void)[]

beforeEach(async () => {
  vi.stubEnv('ORCH_NO_KEEP_AWAKE', '1')
  vi.stubEnv('ORCH_NO_NOTIFY', '1')
  workspace = await mkdtemp(join(tmpdir(), 'orch-api-'))
  cfg = { orchestratorRoot: ROOT, workspace, port: 4321, claudeBin: 'unused', stepTimeoutMin: 1 }
  bus = new EventBus()
  blockers = []
  scheduler = new Scheduler(cfg, bus, {
    runnerFactory: (dir) => {
      let unblock!: () => void
      const gate = new Promise<RunStatus>((res) => (unblock = () => res('waiting')))
      return {
        // Stub runner: projects named "slow-*" stay busy until released; the rest finish at once.
        runUntilBlocked: async () => {
          if (!dir.includes('slow-')) return 'waiting'
          blockers.push(unblock)
          return gate
        },
        abort: () => unblock(),
      } as unknown as ProjectRunner
    },
  })
  app = buildServer(cfg, { scheduler, bus })
})

afterEach(async () => {
  vi.useRealTimers()
  blockers.forEach((b) => b())
  scheduler.stop()
  await scheduler.idle()
  await app.close()
  await stopAll()
  vi.unstubAllEnvs()
  await rm(workspace, { recursive: true, force: true })
})

const PLAN: Plan = {
  platform: 'cli',
  hasUI: false,
  runCommand: `node -e "console.log('http://localhost:5555'); setInterval(()=>{},1000)"`,
  testCommand: 'npm test',
  milestones: [
    {
      id: 'm1',
      title: 'MVP',
      mvp: true,
      tasks: [{ id: 't1', title: 'T', description: 'd', acceptance: ['a'], verify: [] }],
    },
  ],
}

async function project(name: string, patch: Partial<ProjectState> = {}): Promise<{ id: string; dir: string }> {
  const { dir, state } = await createProject(cfg, { name, task: 'Make a small CLI tool' })
  await saveState(dir, { ...state, ...patch })
  return { id: state.id, dir }
}

const atSpec = { phase: 'await_spec', checkpoint: { kind: 'spec', message: 'Approve the spec' } } as const

/** A real HTTP request that sends `path` exactly as given (inject may normalise dot segments). */
async function rawGet(path: string): Promise<{ status: number; type: string; body: Buffer }> {
  await app.listen({ host: '127.0.0.1', port: 0 }).catch(() => {})
  const { port } = app.server.address() as AddressInfo
  return new Promise((res, rej) => {
    request({ host: '127.0.0.1', port, path, method: 'GET' }, (r) => {
      const parts: Buffer[] = []
      r.on('data', (c: Buffer) => parts.push(c))
      r.on('end', () =>
        res({ status: r.statusCode ?? 0, type: String(r.headers['content-type'] ?? ''), body: Buffer.concat(parts) }),
      )
    })
      .on('error', rej)
      .end()
  })
}

describe('displayStatus', () => {
  const base = {
    id: 'x', slug: 'x', name: 'X', createdAt: '2026-01-01T00:00:00.000Z', phase: 'build', subStep: 'implement',
    taskIndex: 0, attempt: 1, feedback: null, resumeNote: false, help: null, checkpoint: null, demoDone: false,
    chosenDesign: null, taskBase: null, feedbackRounds: 0, paused: false, limitUntil: null, limitHits: 0, pauseOnLimit: false,
    error: null, currentStepId: null, steps: [],
  } as ProjectState
  const st = (patch: Partial<ProjectState>): ProjectState => ({ ...base, ...patch })

  it.each([
    ['done beats everything', st({ phase: 'done', error: 'e', paused: true }), '/a', 'done'],
    ['error beats paused', st({ error: 'e', paused: true }), '/a', 'error'],
    ['paused beats a limit', st({ paused: true, limitUntil: '2030-01-01' }), '/a', 'paused'],
    ['a limit beats waiting', st({ limitUntil: '2030-01-01', phase: 'await_spec' }), '/a', 'rate_limited'],
    ['await_* is waiting even if active', st({ phase: 'await_demo' }), '/a', 'waiting'],
    ['needs_help is waiting', st({ phase: 'needs_help' }), '/b', 'waiting'],
    ['the active dir is running', st({}), '/a', 'running'],
    ['otherwise queued', st({}), '/b', 'queued'],
    ['no active project: queued', st({}), null, 'queued'],
  ] as const)('%s', (_name, state, active, expected) => {
    expect(displayStatus(state, null, active, '/a')).toBe(expected)
  })
})

describe('GET/POST /api/projects', () => {
  it('POST validates and creates, enqueueing the project', async () => {
    const short = await inject({ method: 'POST', url: '/api/projects', payload: { name: 'A', task: 'too short' } })
    expect(short.statusCode).toBe(400)
    const noName = await inject({ method: 'POST', url: '/api/projects', payload: { name: '', task: 'long enough task' } })
    expect(noName.statusCode).toBe(400)
    const longName = await inject({
      method: 'POST', url: '/api/projects', payload: { name: 'x'.repeat(81), task: 'long enough task' },
    })
    expect(longName.statusCode).toBe(400)

    const ok = await inject({ method: 'POST', url: '/api/projects', payload: { name: 'My app', task: 'Build a todo list app' } })
    expect(ok.statusCode).toBe(201)
    const { id } = ok.json()
    const list = (await inject({ url: '/api/projects' })).json()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, name: 'My app', phase: 'questions' })
    expect(await readFile(join(workspace, 'my-app/.orchestrator/task.md'), 'utf8')).toBe('Build a todo list app')
    await scheduler.idle() // the enqueued stub run completed
  })

  it('POST with sourceRepo rejects a path that is not a clean git repo', async () => {
    const r = await inject({
      method: 'POST', url: '/api/projects', payload: { name: 'A', task: 'long enough task', sourceRepo: workspace },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/^sourceRepo not a git repository/)
    expect((await inject({ url: '/api/projects' })).json()).toHaveLength(0)
  })

  it('lists displayStatus and updatedAt per project', async () => {
    const a = await project('Alpha', {
      phase: 'await_spec', checkpoint: { kind: 'spec', message: 'm' },
      steps: [
        { id: 's1', role: 'analyst_spec', label: 'l', attempt: 1, status: 'ok', startedAt: '2026-02-01T00:00:00.000Z', endedAt: '2026-02-01T00:05:00.000Z' },
      ],
    })
    await project('Beta', { paused: true })
    await project('Gamma')
    const list: { id: string; name: string; displayStatus: string; updatedAt: string }[] = (
      await inject({ url: '/api/projects' })
    ).json()
    const by = Object.fromEntries(list.map((p) => [p.name, p]))
    expect(by.Alpha).toMatchObject({ id: a.id, displayStatus: 'waiting', updatedAt: '2026-02-01T00:05:00.000Z' })
    expect(by.Beta?.displayStatus).toBe('paused')
    expect(by.Gamma?.displayStatus).toBe('queued')
    expect(by.Gamma?.updatedAt).toBe((await loadState(join(workspace, 'gamma'))).createdAt)
  })

  it('shows the project the scheduler is running as running', async () => {
    const slow = await project('slow-one')
    scheduler.enqueue(slow.dir)
    await vi.waitFor(() => expect(scheduler.activeDir()).toBe(slow.dir))
    const list = (await inject({ url: '/api/projects' })).json()
    expect(list[0].displayStatus).toBe('running')
  })

  it('unknown ids are 404 on every project route', async () => {
    for (const [method, url] of [
      ['GET', '/api/projects/nope'], ['GET', '/api/projects/nope/doc/spec'], ['GET', '/api/projects/nope/asset/a.png'],
      ['GET', '/api/projects/nope/logs/s1'], ['POST', '/api/projects/nope/input'], ['POST', '/api/projects/nope/pause'],
      ['POST', '/api/projects/nope/resume'], ['POST', '/api/projects/nope/app/start'], ['POST', '/api/projects/nope/app/stop'],
      ['GET', '/api/projects/nope/events'],
    ] as const) {
      const r = await inject({ method, url, payload: method === 'POST' ? {} : undefined })
      expect(r.statusCode, `${method} ${url}`).toBe(404)
    }
  })
})

describe('GET /api/projects/:id', () => {
  it('returns state, plan, questions, designOptions and app status', async () => {
    const { id, dir } = await project('Full')
    await savePlan(dir, PLAN)
    const p = projectPaths(dir)
    await writeFile(p.questions, JSON.stringify({ questions: [{ id: 'q1', text: 'Why?' }], secrets: [{ name: 'API_KEY', description: 'k' }] }))
    await writeFile(p.designOptions, JSON.stringify({
      options: [
        { id: 'a', title: 'A', description: 'd', file: 'a.html' },
        { id: 'b', title: 'B', description: 'd', file: 'b.html' },
      ],
    }))
    const body = (await inject({ url: `/api/projects/${id}` })).json()
    expect(body.state.id).toBe(id)
    expect(body.plan.runCommand).toBe(PLAN.runCommand)
    expect(body.questions.questions[0].id).toBe('q1')
    expect(body.designOptions.options).toHaveLength(2)
    expect(body.app).toEqual({ running: false, url: null })
  })

  it('questions, designOptions and plan are null when missing or invalid', async () => {
    const { id, dir } = await project('Sparse')
    let body = (await inject({ url: `/api/projects/${id}` })).json()
    expect(body).toMatchObject({ plan: null, questions: null, designOptions: null })

    await writeFile(projectPaths(dir).questions, '{"questions": "nope"}')
    await writeFile(projectPaths(dir).designOptions, 'not json')
    body = (await inject({ url: `/api/projects/${id}` })).json()
    expect(body.questions).toBeNull()
    expect(body.designOptions).toBeNull()
  })

  it('never contains .env values', async () => {
    const secret = 'sup3r-s3cret-value-123'
    const { id, dir } = await project('Secretive', { phase: 'await_answers', checkpoint: { kind: 'answers', message: 'm' } })
    const put = await inject({
      method: 'POST', url: `/api/projects/${id}/input`,
      payload: { kind: 'answers', answers: { q1: 'blue' }, secrets: { API_KEY: secret } },
    })
    expect(put.statusCode).toBe(200)
    expect(put.body).not.toContain(secret)
    expect(await readFile(join(dir, '.env'), 'utf8')).toContain(secret) // it did land in .env

    const responses = [
      await inject({ url: `/api/projects/${id}` }),
      await inject({ url: '/api/projects' }),
      await inject({ url: `/api/projects/${id}/doc/task` }),
      await inject({ url: `/api/projects/${id}/asset/../.env` }),
      await inject({ url: `/api/projects/${id}/asset/%2E%2E%2F.env` }),
    ]
    for (const r of responses) expect(r.body).not.toContain(secret)
    expect((await rawGet(`/api/projects/${id}/asset/../../.env`)).body.toString()).not.toContain(secret)
  })
})

describe('docs', () => {
  it('serves known docs as markdown, 404 for unknown names and missing files', async () => {
    const { id, dir } = await project('Docs')
    await writeFile(projectPaths(dir).spec, '# Spec\n')
    await writeFile(projectPaths(dir).readme, '# Readme\n')
    const spec = await inject({ url: `/api/projects/${id}/doc/spec` })
    expect(spec.statusCode).toBe(200)
    expect(spec.headers['content-type']).toContain('text/markdown')
    expect(spec.body).toBe('# Spec\n')
    expect((await inject({ url: `/api/projects/${id}/doc/readme` })).body).toBe('# Readme\n')
    expect((await inject({ url: `/api/projects/${id}/doc/task` })).body).toBe('Make a small CLI tool')
    expect((await inject({ url: `/api/projects/${id}/doc/report` })).statusCode).toBe(404) // not written yet
    expect((await inject({ url: `/api/projects/${id}/doc/state` })).statusCode).toBe(404)
    expect((await inject({ url: `/api/projects/${id}/doc/..%2Fstate.json` })).statusCode).toBe(404)
  })
})

describe('secret masking in served files', () => {
  it('masks .env values in docs and in text assets, never in binary ones', async () => {
    const secret = 'sup3r-s3cret-value-123'
    const { id, dir } = await project('Masked')
    await writeFile(join(dir, '.env'), `API_KEY=${secret}\n`)
    const p = projectPaths(dir)
    await writeFile(p.spec, `# Spec\n\nKey: ${secret}\n`)
    await writeFile(join(p.designDir, 'a.html'), `<p>${secret}</p>`)
    await writeFile(join(p.verdictsDir, 'v.json'), JSON.stringify({ pass: false, issues: [`saw ${secret}`] }))
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(secret)])
    await writeFile(join(p.screenshotsDir, 'x.png'), png)

    const spec = await inject({ url: `/api/projects/${id}/doc/spec` })
    expect(spec.body).toBe('# Spec\n\nKey: ***\n')
    const html = await inject({ url: `/api/projects/${id}/asset/design/a.html` })
    expect(html.body).toBe('<p>***</p>')
    const json = await inject({ url: `/api/projects/${id}/asset/verdicts/v.json` })
    expect(json.body).not.toContain(secret)
    expect(JSON.parse(json.body).issues).toEqual(['saw ***'])
    const shot = await inject({ url: `/api/projects/${id}/asset/screenshots/x.png` })
    expect(Buffer.compare(shot.rawPayload, png)).toBe(0)
  })
})

describe('assets', () => {
  async function withShot() {
    const proj = await project('Shots')
    const shot = join(projectPaths(proj.dir).screenshotsDir, 't1-a1/home/desktop.png')
    await mkdir(join(shot, '..'), { recursive: true })
    await writeFile(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    return proj
  }

  it('serves files relative to .orchestrator/ or prefixed with it, with the right content type', async () => {
    const { id, dir } = await withShot()
    await writeFile(join(projectPaths(dir).designDir, 'a.html'), '<h1>A</h1>')
    for (const path of ['screenshots/t1-a1/home/desktop.png', '.orchestrator/screenshots/t1-a1/home/desktop.png']) {
      const r = await inject({ url: `/api/projects/${id}/asset/${path}` })
      expect(r.statusCode, path).toBe(200)
      expect(r.headers['content-type']).toBe('image/png')
      expect([...r.rawPayload]).toEqual([0x89, 0x50, 0x4e, 0x47])
    }
    const html = await inject({ url: `/api/projects/${id}/asset/design/a.html` })
    expect(html.headers['content-type']).toContain('text/html')
    expect(html.headers['content-security-policy']).toBe('sandbox allow-scripts')
    expect(html.headers['x-content-type-options']).toBe('nosniff')
    await writeFile(join(projectPaths(dir).designDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const svg = await inject({ url: `/api/projects/${id}/asset/design/logo.svg` })
    expect(svg.headers['content-security-policy']).toBe('sandbox allow-scripts')
    const png = await inject({ url: `/api/projects/${id}/asset/screenshots/t1-a1/home/desktop.png` })
    expect(png.headers['content-security-policy']).toBeUndefined()
    const json = await inject({ url: `/api/projects/${id}/asset/state.json` })
    expect(json.headers['content-type']).toContain('application/json')
  })

  it('missing file or a directory is 404', async () => {
    const { id } = await withShot()
    expect((await inject({ url: `/api/projects/${id}/asset/screenshots/nope.png` })).statusCode).toBe(404)
    expect((await inject({ url: `/api/projects/${id}/asset/screenshots/t1-a1` })).statusCode).toBe(404)
    expect((await inject({ url: `/api/projects/${id}/asset/no/such/dir/x.png` })).statusCode).toBe(404)
  })

  it('asset path traversal (../state.json, ../../.env, encoded, absolute, symlink) → 400', async () => {
    const { id, dir } = await withShot()
    await writeFile(join(dir, '.env'), 'API_KEY=x')
    const outside = join(workspace, 'outside.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, join(projectPaths(dir).designDir, 'link.html'))
    const base = `/api/projects/${id}/asset/`
    const bad = [
      '../state.json', '../../.env', '..%2Fstate.json', '%2e%2e/state.json', '%2e%2e%2f%2e%2e%2f.env',
      'screenshots/../../.env', '.orchestrator/../.env', '%2Fetc%2Fpasswd', '/etc/passwd', 'a%5C..%5Cb', 'design/link.html',
    ]
    for (const path of bad) {
      const raw = await rawGet(base + path)
      expect(raw.status, `raw ${path}`).toBe(400)
      expect(raw.body.toString()).not.toContain('API_KEY')
      expect(raw.body.toString()).not.toContain('outside')
    }
    // inject may normalise literal dot segments before routing; the encoded forms still reach the handler
    for (const path of ['..%2Fstate.json', '%2Fetc%2Fpasswd', 'a%5C..%5Cb']) {
      expect((await inject({ url: base + path })).statusCode, `inject ${path}`).toBe(400)
    }
  })
})

describe('screenshots', () => {
  it('lists PNGs under screenshots/ and design/ relative to .orchestrator/, newest first', async () => {
    const { id, dir } = await project('Gallery')
    const p = projectPaths(dir)
    const files = [
      [join(p.screenshotsDir, 't1-a1/home/desktop.png'), 1_000],
      [join(p.designDir, 'a-desktop.png'), 3_000],
      [join(p.screenshotsDir, 't2-a1/home/mobile.png'), 2_000],
    ] as const
    for (const [file, sec] of files) {
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, Buffer.from([0x89]))
      await utimes(file, sec, sec)
    }
    await writeFile(join(p.designDir, 'a.html'), '<p>not a png</p>')
    await writeFile(join(p.orch, 'stray.png'), Buffer.from([0x89])) // outside both folders
    await symlink(join(p.designDir, 'a-desktop.png'), join(p.screenshotsDir, 'link.png'))

    const r = await inject({ url: `/api/projects/${id}/screenshots` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual(['design/a-desktop.png', 'screenshots/t2-a1/home/mobile.png', 'screenshots/t1-a1/home/desktop.png'])
  })

  it('is [] when nothing was captured yet, 404 for an unknown project', async () => {
    const { id } = await project('Empty')
    expect((await inject({ url: `/api/projects/${id}/screenshots` })).json()).toEqual([])
    expect((await inject({ url: '/api/projects/nope/screenshots' })).statusCode).toBe(404)
  })
})

describe('logs', () => {
  it('returns the step log entries, [] when absent, 400 for a bad step id', async () => {
    const { id, dir } = await project('Logs')
    const lines = [
      JSON.stringify({ t: 1, kind: 'text', text: 'hello' }),
      'half-written {"t":',
      JSON.stringify({ t: 2, kind: 'result', text: 'done' }),
      JSON.stringify({ t: 3, kind: 'bogus', text: 'schema mismatch' }),
    ]
    await writeFile(join(projectPaths(dir).logsDir, 's1.jsonl'), lines.join('\n') + '\n')
    const r = await inject({ url: `/api/projects/${id}/logs/s1` })
    expect(r.json()).toEqual([
      { t: 1, kind: 'text', text: 'hello' },
      { t: 2, kind: 'result', text: 'done' },
    ])
    expect((await inject({ url: `/api/projects/${id}/logs/never-ran` })).json()).toEqual([])
    expect((await inject({ url: `/api/projects/${id}/logs/a.b` })).statusCode).toBe(400)
    expect((await inject({ url: `/api/projects/${id}/logs/..%2Fstate` })).statusCode).toBe(400)
  })
})

describe('POST input / pause / resume', () => {
  it('pause-on-limit sets the project flag; a non-boolean body → 400', async () => {
    const { id, dir } = await project('Toggle', atSpec)
    const on = await inject({ method: 'POST', url: `/api/projects/${id}/pause-on-limit`, payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    expect(on.json().state.pauseOnLimit).toBe(true)
    expect((await loadState(dir)).pauseOnLimit).toBe(true)
    const bad = await inject({ method: 'POST', url: `/api/projects/${id}/pause-on-limit`, payload: { enabled: 'yes' } })
    expect(bad.statusCode).toBe(400)
    expect((await loadState(dir)).pauseOnLimit).toBe(true)
  })

  it('input with the wrong checkpoint → 409; same approve twice → second is 409', async () => {
    const { id, dir } = await project('Gate', atSpec)
    const wrong = await inject({ method: 'POST', url: `/api/projects/${id}/input`, payload: { kind: 'demo', comments: '' } })
    expect(wrong.statusCode).toBe(409)
    expect((await loadState(dir)).phase).toBe('await_spec') // untouched

    const first = await inject({ method: 'POST', url: `/api/projects/${id}/input`, payload: { kind: 'approve' } })
    expect(first.statusCode).toBe(200)
    expect(first.json().state).toMatchObject({ phase: 'plan', checkpoint: null })
    const second = await inject({ method: 'POST', url: `/api/projects/${id}/input`, payload: { kind: 'approve' } })
    expect(second.statusCode).toBe(409)
  })

  it('plan approval needs a valid designId when design options exist → 400 otherwise, state untouched', async () => {
    const atPlan = { phase: 'await_plan', checkpoint: { kind: 'plan', message: 'm' } } as const
    const { id, dir } = await project('Designs', atPlan)
    await savePlan(dir, { ...PLAN, hasUI: true })
    const options = {
      options: [
        { id: 'a', title: 'A', description: 'd', file: 'a.html' },
        { id: 'b', title: 'B', description: 'd', file: 'b.html' },
      ],
    }
    await mkdir(projectPaths(dir).designDir, { recursive: true })
    await writeFile(projectPaths(dir).designOptions, JSON.stringify(options))
    const approve = (payload: object) => inject({ method: 'POST', url: `/api/projects/${id}/input`, payload })

    const missing = await approve({ kind: 'approve' })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toMatch(/design/i)
    const unknown = await approve({ kind: 'approve', designId: 'zzz' })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().error).toContain('zzz')
    expect((await loadState(dir)).phase).toBe('await_plan')

    const ok = await approve({ kind: 'approve', designId: 'b' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().state).toMatchObject({ phase: 'build', chosenDesign: 'b' })
  })

  it('plan approval without design options (none, or an invalid options.json) needs no designId', async () => {
    const atPlan = { phase: 'await_plan', checkpoint: { kind: 'plan', message: 'm' } } as const
    const { id, dir } = await project('NoDesigns', atPlan)
    await savePlan(dir, PLAN)
    await mkdir(projectPaths(dir).designDir, { recursive: true })
    await writeFile(projectPaths(dir).designOptions, '{"options": []}')
    const r = await inject({ method: 'POST', url: `/api/projects/${id}/input`, payload: { kind: 'approve' } })
    expect(r.statusCode).toBe(200)
  })

  it('zod errors → 400, including a bad secret name and malformed JSON', async () => {
    const { id } = await project('Bad', { phase: 'await_answers', checkpoint: { kind: 'answers', message: 'm' } })
    const post = (payload: unknown) => inject({ method: 'POST', url: `/api/projects/${id}/input`, payload: payload as object })
    expect((await post({ kind: 'nope' })).statusCode).toBe(400)
    expect((await post({ kind: 'revise' })).statusCode).toBe(400)
    expect((await post({ kind: 'answers', answers: {}, secrets: { 'bad name\nX=1': 'v' } })).statusCode).toBe(400)
    const malformed = await inject({
      method: 'POST', url: `/api/projects/${id}/input`, payload: '{oops', headers: { 'content-type': 'application/json' },
    })
    expect(malformed.statusCode).toBe(400)
  })

  it('input enqueues the project', async () => {
    const slow = await project('slow-input', atSpec)
    const r = await inject({ method: 'POST', url: `/api/projects/${slow.id}/input`, payload: { kind: 'approve' } })
    expect(r.statusCode).toBe(200)
    await vi.waitFor(() => expect(scheduler.activeDir()).toBe(slow.dir))
  })

  it('pause and resume flip the flags and return the state', async () => {
    const { id, dir } = await project('Flags', { error: 'boom', limitUntil: '2099-01-01T00:00:00.000Z' })
    const paused = await inject({ method: 'POST', url: `/api/projects/${id}/pause` })
    expect(paused.statusCode).toBe(200)
    expect(paused.json().state.paused).toBe(true)
    expect((await loadState(dir)).paused).toBe(true)

    const resumed = await inject({ method: 'POST', url: `/api/projects/${id}/resume` })
    expect(resumed.json().state).toMatchObject({ paused: false, error: null, limitUntil: null })
    await scheduler.idle()
  })

  it('two parallel approves → [200, 409], and the phase advances exactly once', async () => {
    const { id, dir } = await project('Double', atSpec)
    const post = () => inject({ method: 'POST', url: `/api/projects/${id}/input`, payload: { kind: 'approve' } })
    const res = await Promise.all([post(), post()])
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(await loadState(dir)).toMatchObject({ phase: 'plan', checkpoint: null, attempt: 1 })
  })

  it('accepts POST with content-type json and no body', async () => {
    const { id } = await project('NoBody')
    const r = await inject({ method: 'POST', url: `/api/projects/${id}/pause`, headers: { 'content-type': 'application/json' } })
    expect(r.statusCode).toBe(200)
  })

  it('resume returns promptly while another project runs, and while its own step is still running', async () => {
    const slow = await project('slow-a')
    const other = await project('Other', { paused: true })
    scheduler.enqueue(slow.dir)
    await vi.waitFor(() => expect(scheduler.activeDir()).toBe(slow.dir))

    let t0 = Date.now()
    const r1 = await inject({ method: 'POST', url: `/api/projects/${other.id}/resume` })
    expect(r1.statusCode).toBe(200)
    expect(r1.json().state.paused).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2000)

    // scheduler.resume of the *active* project waits for the step to end; the route must not.
    t0 = Date.now()
    const r2 = await inject({ method: 'POST', url: `/api/projects/${slow.id}/resume` })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().state.id).toBe(slow.id)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('resume failures', () => {
  it('a rejection inside the wait window becomes a 500 with a generic message', async () => {
    const { id } = await project('ResumeFail')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(scheduler, 'resume').mockRejectedValueOnce(new Error('disk full: /secret/path'))
    const r = await inject({ method: 'POST', url: `/api/projects/${id}/resume` })
    expect(r.statusCode).toBe(500)
    expect(r.json()).toEqual({ error: 'Internal error' })
    expect(log).toHaveBeenCalled() // details are logged, not sent
  })

  it('a failure after the response was sent is only logged', async () => {
    const { id } = await project('ResumeLate')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(scheduler, 'resume').mockImplementationOnce(
      () => new Promise<void>((_, rej) => setTimeout(() => rej(new Error('late failure')), 700)),
    )
    const r = await inject({ method: 'POST', url: `/api/projects/${id}/resume` })
    expect(r.statusCode).toBe(200)
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('failed after the response'), expect.any(Error)))
  })
})

describe('request guards', () => {
  it('rejects a foreign or missing Host header (DNS rebinding) with 403', async () => {
    for (const authority of ['evil.example:4321', 'localhost:9999', '127.0.0.1', 'localhost.evil.com:4321']) {
      const r = await app.inject({ url: '/api/projects', authority })
      expect(r.statusCode, authority).toBe(403)
    }
    for (const authority of ['localhost:4321', '127.0.0.1:4321', '[::1]:4321', 'LOCALHOST:4321']) {
      expect((await app.inject({ url: '/api/projects', authority })).statusCode, authority).toBe(200)
    }
  })

  it('rejects POSTs from a foreign Origin with 403 but allows the same origin and no Origin', async () => {
    const { id } = await project('Origin', atSpec)
    const post = (origin?: string) =>
      inject({
        method: 'POST', url: `/api/projects/${id}/input`, payload: { kind: 'approve' },
        ...(origin !== undefined ? { headers: { origin } } : {}),
      })
    expect((await post('http://evil.example')).statusCode).toBe(403)
    expect((await post('null')).statusCode).toBe(403)
    expect((await post('http://localhost:9999')).statusCode).toBe(403)
    expect((await post('http://localhost:4321')).statusCode).toBe(200)
    // no Origin (curl, tests) is fine; this one is now a 409 because the approve already applied
    expect((await post()).statusCode).toBe(409)
  })

  it('5xx responses are generic; 4xx keep their message', async () => {
    const { id } = await project('Generic')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(scheduler, 'pause').mockRejectedValueOnce(new Error('ENOENT: /Users/me/secret'))
    const r = await inject({ method: 'POST', url: `/api/projects/${id}/pause` })
    expect(r.statusCode).toBe(500)
    expect(r.body).not.toContain('secret')
    const bad = await inject({ method: 'POST', url: `/api/projects/${id}/input`, payload: '{oops', headers: { 'content-type': 'application/json' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/JSON/i)
  })
})

describe('demo app routes', () => {
  it('app/start without a plan → 409', async () => {
    const { id } = await project('NoPlan')
    expect((await inject({ method: 'POST', url: `/api/projects/${id}/app/start` })).statusCode).toBe(409)
  })

  it('app/start runs plan.runCommand, app/stop stops it, GET shows the status', async () => {
    const { id, dir } = await project('Runner')
    await savePlan(dir, PLAN)
    const started = await inject({ method: 'POST', url: `/api/projects/${id}/app/start` })
    expect(started.json()).toEqual({ running: true, url: 'http://localhost:5555' })
    expect((await inject({ url: `/api/projects/${id}` })).json().app).toEqual({ running: true, url: 'http://localhost:5555' })
    const stopped = await inject({ method: 'POST', url: `/api/projects/${id}/app/stop` })
    expect(stopped.json()).toEqual({ running: false, url: null })
    expect(appRunner.status(dir).running).toBe(false)
  })
})

describe('SSE events', () => {
  type Sse = { res: IncomingMessage; chunks: string[]; text: () => string; close: () => void }

  async function connect(id: string): Promise<Sse> {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo
    return new Promise((resolveConn, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `/api/projects/${id}/events` }, (res) => {
        const chunks: string[] = []
        res.setEncoding('utf8')
        res.on('data', (c: string) => chunks.push(c))
        resolveConn({ res, chunks, text: () => chunks.join(''), close: () => req.destroy() })
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('sends the initial state, then this project\'s state and log events only', async () => {
    const a = await project('Sse A')
    const b = await project('Sse B')
    const sse = await connect(a.id)
    expect(sse.res.headers['content-type']).toBe('text/event-stream')
    expect(sse.res.headers['cache-control']).toBe('no-cache')
    expect(sse.res.headers['connection']).toBe('keep-alive')
    await vi.waitFor(() => expect(sse.text()).toContain('event: state'))
    expect(sse.text()).toContain(`"id":"${a.id}"`)

    const stateA = await loadState(a.dir)
    const stateB = await loadState(b.dir)
    bus.emitState(b.id, { ...stateB, name: 'for-b-only' })
    bus.emitLog(b.id, 's9', { t: 1, kind: 'text', text: 'for-b-only' })
    bus.emitState(a.id, { ...stateA, name: 'renamed-a' })
    bus.emitLog(a.id, 's1', { t: 5, kind: 'text', text: 'hi' })
    await vi.waitFor(() => expect(sse.text()).toContain('event: log'))

    const text = sse.text()
    expect(text).toContain('"name":"renamed-a"')
    expect(text).toContain('event: log\ndata: {"stepId":"s1","entry":{"t":5,"kind":"text","text":"hi"}}\n\n')
    expect(text).not.toContain('for-b-only')
    sse.close()
  })

  it('removes its listeners when the client disconnects, and never throws into the bus', async () => {
    const a = await project('Sse Close')
    const sse = await connect(a.id)
    await vi.waitFor(() => expect(sse.text()).toContain('event: state'))
    expect(bus.listenerCount('state')).toBe(1)
    expect(bus.listenerCount('log')).toBe(1)
    sse.close()
    await vi.waitFor(() => expect(bus.listenerCount('state')).toBe(0))
    expect(bus.listenerCount('log')).toBe(0)
    expect(() => bus.emitLog(a.id, 's1', { t: 1, kind: 'text', text: 'late' })).not.toThrow()
  })

  it('a failing write does not throw out of an emit', async () => {
    const a = await project('Sse Throw')
    const sse = await connect(a.id)
    await vi.waitFor(() => expect(sse.text()).toContain('event: state'))
    const state = await loadState(a.dir)
    // The circular value makes JSON.stringify throw inside the listener's string building.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => bus.emitState(a.id, circular as unknown as ProjectState)).not.toThrow()
    bus.emitState(a.id, { ...state, name: 'still-alive' })
    await vi.waitFor(() => expect(sse.text()).toContain('still-alive'))
    sse.close()
  })

  it('sends a heartbeat comment every 15 s and stops it on close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const a = await project('Sse Beat')
    const sse = await connect(a.id)
    await vi.waitFor(() => expect(sse.text()).toContain('event: state'))
    expect(sse.text()).not.toContain(': ping')
    vi.advanceTimersByTime(HEARTBEAT_MS)
    await vi.waitFor(() => expect(sse.text()).toContain(': ping\n\n'))
    sse.close()
    await vi.waitFor(() => expect(bus.listenerCount('state')).toBe(0))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closing the server ends open streams', async () => {
    const a = await project('Sse Shutdown')
    const sse = await connect(a.id)
    await vi.waitFor(() => expect(sse.text()).toContain('event: state'))
    const ended = new Promise<void>((res) => sse.res.on('close', () => res()))
    await app.close()
    await ended
    expect(bus.listenerCount('state')).toBe(0)
  })
})
