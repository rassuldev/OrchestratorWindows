import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  flattenTasks,
  STALE_STATE,
  subscribe,
  type LogEntry,
  type ProjectDetails,
  type ProjectState,
  type UserInput,
} from '../api.js'
import { Icon } from '../icons.js'
import { formatTime, PHASE_LABELS, stateStatus } from '../labels.js'
import { Checkpoint, type CheckpointDeps } from './Checkpoint.js'
import { Docs } from './Docs.js'
import { LogView } from './LogView.js'
import { StatusBadge } from './StatusBadge.js'
import { Timeline } from './Timeline.js'

const SUBSTEP_LABELS = { implement: 'реализация', verify: 'проверка', review: 'ревью' } as const
const MAX_ATTEMPTS = 3

/** History from /logs plus live entries that arrived before or during the fetch, without duplicates. */
function mergeLogs(history: LogEntry[], live: LogEntry[]): LogEntry[] {
  const key = (e: LogEntry) => `${e.t}|${e.kind}|${e.text}`
  const seen = new Set(history.map(key))
  return [...history, ...live.filter((e) => !seen.has(key(e)))]
}

/** Changes in these mean plan, questions or design options may have changed too. */
const shapeKey = (s: ProjectState) => `${s.phase}|${s.checkpoint?.kind ?? ''}|${s.feedbackRounds}`

function Activity({ details }: { details: ProjectDetails }) {
  const { state, plan } = details
  const running = state.steps.find((s) => s.status === 'running')
  const tasks = plan ? flattenTasks(plan) : []
  const task = tasks[state.taskIndex]
  const building = state.phase === 'build' || (state.phase === 'needs_help' && state.help?.phase === 'build')
  return (
    <div className="activity">
      <span>
        <span className="muted">Этап:</span> {PHASE_LABELS[state.phase]}
      </span>
      {building && task && (
        <span>
          <span className="muted">Задача {state.taskIndex + 1} из {tasks.length}:</span> {task.title}
          {state.phase === 'build' && (
            <span className="muted">
              {' '}
              · {SUBSTEP_LABELS[state.subStep]}, попытка {Math.min(state.attempt, MAX_ATTEMPTS)} из {MAX_ATTEMPTS}
            </span>
          )}
        </span>
      )}
      {running && (
        <span>
          <span className="muted">Сейчас:</span> {running.label}
        </span>
      )}
    </div>
  )
}

export function ProjectPage({ id }: { id: string }) {
  const [details, setDetails] = useState<ProjectDetails | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connected, setConnected] = useState(true)
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({})
  const [loadedSteps, setLoadedSteps] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [controlBusy, setControlBusy] = useState(false)
  const [logErrors, setLogErrors] = useState<Record<string, string>>({})
  /** shapeKey of the state the details (plan, questions, design options) were fetched with. */
  const [fetchedShape, setFetchedShape] = useState<string | null>(null)
  const shape = useRef<string | null>(null)
  const wasDisconnected = useRef(false)

  const refetch = useCallback(async () => {
    try {
      const d = await api.getProject(id)
      shape.current = shapeKey(d.state)
      setFetchedShape(shape.current)
      setDetails(d)
      setLoadError(null)
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [id])

  useEffect(() => {
    setDetails(null)
    setLogs({})
    setLogErrors({})
    setLoadedSteps(new Set())
    setSelected(null)
    void refetch()
    return subscribe(id, {
      onState: (state) => {
        setDetails((d) => (d ? { ...d, state } : d))
        if (shape.current !== null && shape.current !== shapeKey(state)) void refetch()
      },
      onLog: (stepId, entry) => setLogs((l) => ({ ...l, [stepId]: [...(l[stepId] ?? []), entry] })),
      onConnection: (ok) => {
        setConnected(ok)
        if (!ok) wasDisconnected.current = true
        else if (wasDisconnected.current) {
          // Entries sent while we were away are only in the log files now.
          wasDisconnected.current = false
          setLoadedSteps(new Set())
          void refetch()
        }
      },
    })
  }, [id, refetch])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  const state = details?.state
  const liveStepId = state ? (state.currentStepId ?? state.steps.at(-1)?.id ?? null) : null
  const shownStepId = selected ?? liveStepId

  useEffect(() => {
    if (!shownStepId || loadedSteps.has(shownStepId)) return
    setLoadedSteps((s) => new Set(s).add(shownStepId))
    api.getLogs(id, shownStepId).then(
      (history) => {
        setLogs((l) => ({ ...l, [shownStepId]: mergeLogs(history, l[shownStepId] ?? []) }))
        setLogErrors(({ [shownStepId]: _, ...rest }) => rest)
      },
      (e: unknown) => {
        setLogs((l) => ({ ...l, [shownStepId]: l[shownStepId] ?? [] }))
        setLogErrors((errs) => ({ ...errs, [shownStepId]: (e as Error).message }))
      },
    )
  }, [id, shownStepId, loadedSteps])

  const submit = async (input: UserInput) => {
    try {
      const next = await api.postInput(id, input)
      setDetails((d) => (d ? { ...d, state: next } : d))
      await refetch()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setNotice(STALE_STATE)
        void refetch()
      }
      throw e
    }
  }

  const control = async (action: 'pause' | 'resume' | 'limit-on' | 'limit-off') => {
    setControlBusy(true)
    try {
      const next =
        action === 'pause'
          ? await api.pause(id)
          : action === 'resume'
            ? await api.resume(id)
            : await api.setPauseOnLimit(id, action === 'limit-on')
      setDetails((d) => (d ? { ...d, state: next } : d))
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setControlBusy(false)
    }
  }

  if (!details || !state) {
    return (
      <div className="page">
        <a className="back" href="#/">
          <Icon name="back" /> Проекты
        </a>
        {loadError ? (
          <p className="banner banner-error" role="alert">
            <Icon name="alert" /> Не удалось открыть проект: {loadError}
          </p>
        ) : (
          <p className="muted">Загрузка…</p>
        )}
      </div>
    )
  }

  const status = stateStatus(state)
  // A pause right after a rate-limited step (pauseOnLimit, or «Пауза» pressed while waiting the limit out).
  const limitPaused = state.paused && state.limitUntil === null && state.steps.at(-1)?.status === 'limited'
  // The checkpoint needs plan / questions / design options fetched for this very state, not an earlier one.
  const detailsCurrent = fetchedShape === shapeKey(state)
  const checkpoint = state.checkpoint
  const shownStep = state.steps.find((s) => s.id === shownStepId)
  const isLive = shownStep?.status === 'running'
  const lastFailure = [...state.steps].reverse().find((s) => s.status === 'failed' && s.error)?.error ?? null
  const deps: CheckpointDeps = {
    getDoc: (name) => api.getDoc(id, name),
    startApp: () => api.startApp(id),
    stopApp: () => api.stopApp(id),
    listScreenshots: () => api.listScreenshots(id),
    assetUrl: (path) => api.assetUrl(id, path),
  }

  return (
    <div className="page project-page">
      <header className="project-head">
        <div className="project-title">
          <a className="back" href="#/">
            <Icon name="back" /> Проекты
          </a>
          <h1>
            {state.name}
            <StatusBadge status={status} />
          </h1>
          <Activity details={details} />
        </div>
        <div className="project-controls">
          {status !== 'done' && (
            <label className="switch" title="При лимите Claude поставить проект на паузу и прислать уведомление, а не продолжать автоматически">
              <input
                type="checkbox"
                role="switch"
                checked={state.pauseOnLimit}
                disabled={controlBusy}
                onChange={(e) => void control(e.target.checked ? 'limit-on' : 'limit-off')}
              />
              <span className="switch-track" aria-hidden="true" />
              Пауза при лимите
            </label>
          )}
          {status !== 'done' &&
            (state.paused || state.error !== null ? (
              <button className="btn primary" disabled={controlBusy} onClick={() => void control('resume')}>
                <Icon name="play" /> Продолжить
              </button>
            ) : (
              <>
                {state.limitUntil !== null && (
                  <button className="btn" disabled={controlBusy} onClick={() => void control('resume')}>
                    Попробовать сейчас
                  </button>
                )}
                <button className="btn" disabled={controlBusy} onClick={() => void control('pause')}>
                  <Icon name="pause" /> Пауза
                </button>
              </>
            ))}
        </div>
      </header>

      {!connected && (
        <p className="banner banner-warn" role="status">
          <Icon name="alert" /> Нет связи с сервером — переподключаюсь. Данные на экране могут устареть.
        </p>
      )}
      {loadError && (
        <div className="banner banner-error" role="alert">
          <Icon name="alert" />
          <div>
            Не удалось обновить данные проекта: {loadError}. На экране может быть устаревшее состояние.{' '}
            <button className="btn small" onClick={() => void refetch()}>
              Повторить
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p className="banner banner-warn" role="status">
          <Icon name="alert" /> {notice}
        </p>
      )}
      {state.error !== null && (
        <div className="banner banner-error" role="alert">
          <Icon name="alert" />
          <div>
            <strong>Конвейер остановлен из-за ошибки.</strong> {state.error}
            <div className="muted">Устраните причину и нажмите «Продолжить».</div>
          </div>
        </div>
      )}
      {state.limitUntil !== null && state.error === null && (
        <p className="banner banner-info" role="status">
          <Icon name="clock" /> Достигнут лимит Claude. Продолжу автоматически в {formatTime(state.limitUntil)}.
        </p>
      )}
      {state.paused && (
        <p className="banner banner-info" role="status">
          <Icon name="pause" />{' '}
          {limitPaused
            ? 'Достигнут лимит Claude — проект на паузе. Нажмите «Продолжить», когда лимит сбросится.'
            : 'На паузе — агенты не запускаются, пока вы не нажмёте «Продолжить».'}
        </p>
      )}

      <div className="project-body">
        <aside className="area-timeline">
          <Timeline steps={state.steps} selectedId={shownStepId} onSelect={(stepId) => setSelected(stepId === liveStepId ? null : stepId)} />
        </aside>
        {checkpoint && !detailsCurrent && (
          <div className="area-checkpoint">
            <section className="checkpoint checkpoint-pending" aria-busy="true">
              <p className="muted">
                <Icon name="spinner" /> Загрузка данных для решения…
              </p>
            </section>
          </div>
        )}
        {checkpoint && detailsCurrent && (
          <div className="area-checkpoint">
            <Checkpoint
              key={`${checkpoint.kind}:${state.steps.length}:${state.feedbackRounds}`}
              kind={checkpoint.kind}
              message={checkpoint.message}
              detail={checkpoint.kind === 'help' ? (lastFailure ?? state.feedback) : null}
              questions={details.questions}
              designOptions={details.designOptions}
              plan={details.plan}
              helpPhase={state.help?.phase ?? null}
              app={details.app}
              deps={deps}
              onSubmit={submit}
            />
          </div>
        )}
        <div className="area-log">
          <LogView
            key={shownStepId ?? 'none'}
            title={shownStep ? shownStep.label : 'Лог'}
            entries={shownStepId ? (loadedSteps.has(shownStepId) ? (logs[shownStepId] ?? null) : null) : []}
            live={isLive}
            onFollow={selected !== null && selected !== liveStepId ? () => setSelected(null) : undefined}
            followLabel={state.steps.some((s) => s.status === 'running') ? 'К текущему шагу' : 'К последнему шагу'}
            error={shownStepId ? logErrors[shownStepId] : undefined}
            onRetry={() =>
              setLoadedSteps((steps) => {
                const next = new Set(steps)
                if (shownStepId) next.delete(shownStepId)
                return next
              })
            }
          />
        </div>
        <div className="area-docs">
          <Docs projectId={id} state={state} plan={details.plan} />
        </div>
      </div>
    </div>
  )
}
