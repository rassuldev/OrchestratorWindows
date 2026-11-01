import type {
  Checkpoint,
  DesignOptions,
  LogEntry,
  Phase,
  Plan,
  ProjectState,
  Questions,
  StepRecord,
  Task,
  UserInput,
} from '../../src/core/schemas.js'
import type { DisplayStatus } from '../../src/server/routes.js'

export type { Checkpoint, DesignOptions, DisplayStatus, LogEntry, Phase, Plan, ProjectState, Questions, StepRecord, Task, UserInput }

export type DocName = 'task' | 'spec' | 'architecture' | 'decisions' | 'followups' | 'report' | 'readme'
export type AppStatus = { running: boolean; url: string | null }
export type ProjectSummary = { id: string; name: string; phase: Phase; displayStatus: DisplayStatus; updatedAt: string }
export type ProjectDetails = {
  state: ProjectState
  plan: Plan | null
  questions: Questions | null
  designOptions: DesignOptions | null
  app: AppStatus
}

export const STALE_STATE = 'Состояние уже изменилось'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** `conflict` replaces the server's message on a 409 (used for checkpoint input). */
async function request<T>(path: string, init?: RequestInit, conflict?: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError(0, 'Нет связи с сервером')
  }
  if (!res.ok) {
    if (res.status === 409 && conflict !== undefined) throw new ApiError(409, conflict)
    let message = `Ошибка сервера (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message)
  }
  const type = res.headers.get('content-type') ?? ''
  return (type.includes('json') ? await res.json() : await res.text()) as T
}

const post = <T>(path: string, body?: unknown, conflict?: string) =>
  request<T>(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? '' : JSON.stringify(body),
    },
    conflict,
  )

const base = (id: string) => `/api/projects/${encodeURIComponent(id)}`

export const api = {
  listProjects: () => request<ProjectSummary[]>('/api/projects'),
  /** `sourceRepo`: absolute path of a local git repo to continue; omitted starts from scratch. */
  createProject: (name: string, task: string, sourceRepo?: string) =>
    post<{ id: string }>('/api/projects', { name, task, sourceRepo }),
  getProject: (id: string) => request<ProjectDetails>(base(id)),
  /** null when the document does not exist yet. */
  getDoc: async (id: string, name: DocName): Promise<string | null> => {
    try {
      return await request<string>(`${base(id)}/doc/${name}`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },
  getLogs: (id: string, stepId: string) => request<LogEntry[]>(`${base(id)}/logs/${encodeURIComponent(stepId)}`),
  listScreenshots: (id: string) => request<string[]>(`${base(id)}/screenshots`),
  postInput: async (id: string, input: UserInput) =>
    (await post<{ state: ProjectState }>(`${base(id)}/input`, input, STALE_STATE)).state,
  pause: async (id: string) => (await post<{ state: ProjectState }>(`${base(id)}/pause`)).state,
  resume: async (id: string) => (await post<{ state: ProjectState }>(`${base(id)}/resume`)).state,
  setPauseOnLimit: async (id: string, enabled: boolean) =>
    (await post<{ state: ProjectState }>(`${base(id)}/pause-on-limit`, { enabled })).state,
  startApp: (id: string) => post<AppStatus>(`${base(id)}/app/start`),
  stopApp: (id: string) => post<AppStatus>(`${base(id)}/app/stop`),
  /** `path` is relative to `.orchestrator/` (or prefixed with it). */
  assetUrl: (id: string, path: string) => `${base(id)}/asset/${path.split('/').map(encodeURIComponent).join('/')}`,
}

export type ProjectEvents = {
  onState: (state: ProjectState) => void
  onLog: (stepId: string, entry: LogEntry) => void
  onConnection: (connected: boolean) => void
}

/** Subscribes to the project's SSE stream; returns the unsubscribe function. */
export function subscribe(id: string, handlers: ProjectEvents): () => void {
  const source = new EventSource(`${base(id)}/events`)
  source.addEventListener('state', (e) => handlers.onState(JSON.parse((e as MessageEvent<string>).data) as ProjectState))
  source.addEventListener('log', (e) => {
    const { stepId, entry } = JSON.parse((e as MessageEvent<string>).data) as { stepId: string; entry: LogEntry }
    handlers.onLog(stepId, entry)
  })
  source.addEventListener('open', () => handlers.onConnection(true))
  source.addEventListener('error', () => handlers.onConnection(false))
  return () => source.close()
}

export function flattenTasks(plan: Plan): Task[] {
  return plan.milestones.flatMap((m) => m.tasks)
}

/** The screenshots of the newest verifier run (`screenshots/<task>-a<n>/…`), in listing order. */
export function latestVerifierShots(paths: string[]): string[] {
  const runOf = (p: string) => /^screenshots\/([^/]+-a\d+)\//.exec(p)?.[1] ?? null
  const latest = paths.map(runOf).find((r) => r !== null)
  return latest ? paths.filter((p) => runOf(p) === latest) : []
}
