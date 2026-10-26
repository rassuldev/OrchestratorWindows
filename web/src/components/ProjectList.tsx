import type { DisplayStatus, ProjectSummary } from '../api.js'
import { Icon } from '../icons.js'
import { formatWhen, PHASE_LABELS } from '../labels.js'
import { StatusBadge } from './StatusBadge.js'

const ORDER: Record<DisplayStatus, number> = { waiting: 0, error: 1, running: 2, rate_limited: 3, queued: 4, paused: 5, done: 6 }

/** Waiting first (they need the user), then by most recent activity. */
export function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort(
    (a, b) => ORDER[a.displayStatus] - ORDER[b.displayStatus] || b.updatedAt.localeCompare(a.updatedAt),
  )
}

type Props = { projects: ProjectSummary[] | null; error: string | null }

export function ProjectList({ projects, error }: Props) {
  const waiting = projects?.filter((p) => p.displayStatus === 'waiting').length ?? 0
  return (
    <div className="page list-page">
      <header className="page-head">
        <div>
          <h1>Проекты</h1>
          {projects && projects.length > 0 && (
            <p className="muted">
              {waiting > 0 ? (
                <span className="accent-text">
                  {waiting === 1 ? 'Один проект ждёт вашего решения' : `Ждут вашего решения: ${waiting}`}
                </span>
              ) : (
                'Никто не ждёт вашего решения'
              )}
              {' · обновляется каждые 5 секунд'}
            </p>
          )}
        </div>
        <a className="btn primary" href="#/new">
          <Icon name="plus" /> Новый проект
        </a>
      </header>
      {error && (
        <p className="banner banner-error" role="alert">
          <Icon name="alert" /> Не удалось загрузить список: {error}
        </p>
      )}
      {projects === null ? (
        !error && <p className="muted">Загрузка…</p>
      ) : projects.length === 0 ? (
        <div className="empty-state">
          <h2>Проектов пока нет</h2>
          <p>
            Опишите задачу — аналитик задаст вопросы, затем появятся спецификация и план на ваше одобрение, а дальше агенты
            построят проект задача за задачей. Вас позовут, когда понадобится решение.
          </p>
          <a className="btn primary" href="#/new">
            <Icon name="plus" /> Описать задачу
          </a>
        </div>
      ) : (
        <table className="project-table">
          <thead>
            <tr>
              <th scope="col">Статус</th>
              <th scope="col">Проект</th>
              <th scope="col">Этап</th>
              <th scope="col" className="col-when">
                Активность
              </th>
            </tr>
          </thead>
          <tbody>
            {sortProjects(projects).map((p) => (
              <tr key={p.id} className={p.displayStatus === 'waiting' ? 'row-waiting' : undefined}>
                <td>
                  <StatusBadge status={p.displayStatus} />
                </td>
                <td className="col-name">
                  <a href={`#/p/${encodeURIComponent(p.id)}`}>{p.name}</a>
                </td>
                <td className="col-phase">{PHASE_LABELS[p.phase]}</td>
                <td className="col-when tabular muted">{formatWhen(p.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
