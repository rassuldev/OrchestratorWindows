import { useEffect, useState } from 'react'
import { api, flattenTasks, type DocName, type Plan, type ProjectState } from '../api.js'
import { renderMarkdown } from '../markdown.js'
import { Icon } from '../icons.js'

export function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
}

type Marker = 'done' | 'current' | 'todo'

/** Which tasks are done and which one is being built, from the state's phase and task index. */
export function taskMarker(state: ProjectState, index: number): Marker {
  if (state.phase === 'finalize' || state.phase === 'done') return 'done'
  const building = state.phase === 'build' || (state.phase === 'needs_help' && state.help?.phase === 'build')
  if (!building && state.phase !== 'await_demo') return 'todo'
  if (index < state.taskIndex) return 'done'
  return building && index === state.taskIndex ? 'current' : 'todo'
}

const MARKER_LABELS: Record<Marker, string> = { done: 'готово', current: 'в работе', todo: '' }
const PLATFORM_LABELS: Record<Plan['platform'], string> = {
  web: 'веб-приложение',
  cli: 'консольная утилита',
  api: 'API-сервис',
  bot: 'бот',
  desktop: 'десктоп-приложение',
  other: 'другое',
}

export function PlanView({ plan, state, expanded = false }: { plan: Plan; state?: ProjectState; expanded?: boolean }) {
  const tasks = flattenTasks(plan)
  let index = 0
  return (
    <div className="plan">
      <dl className="plan-meta">
        <div>
          <dt>Платформа</dt>
          <dd>
            {PLATFORM_LABELS[plan.platform]}
            {plan.hasUI ? ', с интерфейсом' : ''}
          </dd>
        </div>
        <div>
          <dt>Запуск</dt>
          <dd>
            <code>{plan.runCommand || '—'}</code>
          </dd>
        </div>
        <div>
          <dt>Тесты</dt>
          <dd>
            <code>{plan.testCommand || '—'}</code>
          </dd>
        </div>
        <div>
          <dt>Задач</dt>
          <dd>{tasks.length}</dd>
        </div>
      </dl>
      {plan.milestones.map((m) => (
        <section key={m.id} className="milestone">
          <h3>
            {m.title}
            {m.mvp && <span className="tag">MVP</span>}
          </h3>
          <ol className="tasks">
            {m.tasks.map((t) => {
              const marker = state ? taskMarker(state, index) : 'todo'
              index++
              return (
                <li key={t.id} className={`task task-${marker}`}>
                  <details open={expanded || marker === 'current'}>
                    <summary>
                      <span className="task-mark" aria-hidden="true">
                        {marker === 'done' ? <Icon name="check" /> : marker === 'current' ? <Icon name="spinner" /> : null}
                      </span>
                      <span className="task-id">{t.id}</span>
                      <span className="task-title">{t.title}</span>
                      {MARKER_LABELS[marker] && <span className="task-state">{MARKER_LABELS[marker]}</span>}
                    </summary>
                    <div className="task-body">
                      <p>{t.description}</p>
                      <h4>Критерии приёмки</h4>
                      <ul>
                        {t.acceptance.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                      {t.verify.length > 0 && (
                        <>
                          <h4>Проверка</h4>
                          <ul className="mono-list">
                            {t.verify.map((v, i) => (
                              <li key={i}>
                                <code>{v}</code>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  </details>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}

/** A document fetched by name; `version` changes trigger a refetch. */
export function useDoc(load: () => Promise<string | null>, version: unknown): { text: string | null; loading: boolean; error: string | null } {
  const [result, setResult] = useState<{ text: string | null; loading: boolean; error: string | null }>({
    text: null,
    loading: true,
    error: null,
  })
  useEffect(() => {
    let live = true
    setResult((r) => ({ ...r, loading: true }))
    load().then(
      (text) => live && setResult({ text, loading: false, error: null }),
      (e: unknown) => live && setResult({ text: null, loading: false, error: (e as Error).message }),
    )
    return () => {
      live = false
    }
    // `load` is recreated each render; `version` says when to refetch
  }, [version])
  return result
}

type TabId = 'task' | 'spec' | 'architecture' | 'plan' | 'decisions' | 'screenshots' | 'report'

const TABS: { id: TabId; label: string; empty: string }[] = [
  { id: 'task', label: 'Задача', empty: 'Описание задачи не найдено.' },
  { id: 'spec', label: 'Спецификация', empty: 'Спецификацию напишет аналитик после ваших ответов на вопросы.' },
  { id: 'architecture', label: 'Архитектура', empty: 'Архитектуру опишет архитектор после одобрения спецификации.' },
  { id: 'plan', label: 'План', empty: 'План появится после одобрения спецификации.' },
  { id: 'decisions', label: 'Решения', empty: 'Сюда агенты записывают решения, принятые без вас. Пока их нет.' },
  {
    id: 'screenshots',
    label: 'Скриншоты',
    empty: 'Скриншоты появятся, когда дизайнер подготовит макеты или проверяющий откроет приложение.',
  },
  { id: 'report', label: 'Отчёт', empty: 'Отчёт пишется в самом конце, после всех задач.' },
]

function DocTab({ projectId, name, empty, version }: { projectId: string; name: DocName; empty: string; version: unknown }) {
  const { text, loading, error } = useDoc(() => api.getDoc(projectId, name), `${name}:${String(version)}`)
  if (error) return <p className="muted load-error">Не удалось загрузить документ: {error}</p>
  if (text === null) return loading ? <p className="muted">Загрузка…</p> : <p className="empty">{empty}</p>
  return <Markdown text={text} />
}

function ScreenshotsTab({ projectId, version, empty }: { projectId: string; version: unknown; empty: string }) {
  const [paths, setPaths] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.listScreenshots(projectId).then(
      (p) => {
        if (!live) return
        setPaths(p)
        setError(null)
      },
      (e: unknown) => live && setError((e as Error).message),
    )
    return () => {
      live = false
    }
  }, [projectId, version])
  if (error) return <p className="muted load-error">Не удалось загрузить список скриншотов: {error}</p>
  if (paths === null) return <p className="muted">Загрузка…</p>
  if (paths.length === 0) return <p className="empty">{empty}</p>
  const groups = new Map<string, string[]>()
  for (const p of paths) {
    const folder = p.slice(0, p.lastIndexOf('/'))
    groups.set(folder, [...(groups.get(folder) ?? []), p])
  }
  return (
    <div className="shot-groups">
      {[...groups].map(([folder, files]) => (
        <section key={folder}>
          <h3 className="mono">{folder}</h3>
          <div className="shots">
            {files.map((f) => (
              <a key={f} className="shot" href={api.assetUrl(projectId, f)} target="_blank" rel="noopener noreferrer">
                <img src={api.assetUrl(projectId, f)} alt={f} loading="lazy" />
                <span className="mono">{f.slice(folder.length + 1)}</span>
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function Docs({ projectId, state, plan }: { projectId: string; state: ProjectState; plan: Plan | null }) {
  const [tab, setTab] = useState<TabId>('task')
  // Refetch the open tab whenever the pipeline moves on.
  const version = `${state.phase}:${state.steps.length}:${state.taskIndex}`
  const current = TABS.find((t) => t.id === tab)!
  return (
    <section className="docs">
      <div className="tabs" role="tablist" aria-label="Документы проекта">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls="doc-panel"
            className="tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="doc-panel" id="doc-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'plan' ? (
          plan ? (
            <PlanView plan={plan} state={state} />
          ) : (
            <p className="empty">{current.empty}</p>
          )
        ) : tab === 'screenshots' ? (
          <ScreenshotsTab projectId={projectId} version={version} empty={current.empty} />
        ) : (
          <DocTab key={tab} projectId={projectId} name={tab} empty={current.empty} version={version} />
        )}
      </div>
    </section>
  )
}
