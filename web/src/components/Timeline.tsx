import { useEffect, useState } from 'react'
import type { StepRecord } from '../api.js'
import { Icon, type IconName } from '../icons.js'
import { formatCost, formatDuration, formatTime, STEP_STATUS_LABELS } from '../labels.js'

const STATUS_ICONS: Record<StepRecord['status'], IconName | 'spinner'> = {
  running: 'spinner',
  ok: 'check',
  failed: 'cross',
  interrupted: 'stop',
  limited: 'clock',
}

type Group = { taskId?: string; title?: string; steps: StepRecord[] }

/** Consecutive steps of the same build task share a header; other steps stand alone. */
function groupSteps(steps: StepRecord[]): Group[] {
  const groups: Group[] = []
  for (const step of steps) {
    const last = groups.at(-1)
    if (step.taskId !== undefined && last?.taskId === step.taskId) last.steps.push(step)
    else if (step.taskId !== undefined) {
      const title = /^Задача [^:]+:\s*(.*?)\s+—\s+/.exec(step.label)?.[1]
      groups.push({ taskId: step.taskId, title, steps: [step] })
    } else groups.push({ steps: [step] })
  }
  return groups
}

function rowLabel(step: StepRecord): string {
  const label = step.taskId !== undefined ? (step.label.split(' — ').at(-1) ?? step.label) : step.label
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

type Props = {
  steps: StepRecord[]
  /** The step whose log is shown. */
  selectedId: string | null
  onSelect: (stepId: string) => void
}

export function Timeline({ steps, selectedId, onSelect }: Props) {
  const running = steps.some((s) => s.status === 'running')
  const now = useNow(running)
  const total = steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)

  return (
    <nav className="timeline" aria-label="Шаги конвейера">
      <header className="timeline-head">
        <h2>Шаги</h2>
        <span className="muted tabular">
          {steps.length} · {formatCost(total)}
        </span>
      </header>
      {steps.length === 0 ? (
        <p className="empty">Шагов пока нет. Первый шаг начнётся, как только проект дойдёт до очереди.</p>
      ) : (
        <ol className="steps">
          {groupSteps(steps).map((g) => (
            <li key={g.steps[0]!.id} className={g.taskId ? 'step-group' : undefined}>
              {g.taskId && (
                <div className="step-group-title">
                  <span className="mono">{g.taskId}</span> {g.title}
                </div>
              )}
              <ol>
                {g.steps.map((s) => {
                  const end = s.endedAt ? Date.parse(s.endedAt) : now
                  return (
                    <li key={s.id}>
                      <button
                        className={`step step-${s.status}`}
                        aria-current={s.id === selectedId ? 'step' : undefined}
                        onClick={() => onSelect(s.id)}
                        title={`${s.label}\nНачат в ${formatTime(s.startedAt)} · ${STEP_STATUS_LABELS[s.status]}`}
                      >
                        <span className="step-icon">
                          <Icon name={STATUS_ICONS[s.status]} />
                          <span className="sr-only">{STEP_STATUS_LABELS[s.status]}</span>
                        </span>
                        <span className="step-label">{rowLabel(s)}</span>
                        <span className="step-meta tabular">
                          {formatDuration(end - Date.parse(s.startedAt))}
                          {s.costUsd !== undefined && ` · ${formatCost(s.costUsd)}`}
                        </span>
                        {s.error && s.status !== 'ok' && <span className="step-error">{s.error.split('\n')[0]}</span>}
                      </button>
                    </li>
                  )
                })}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </nav>
  )
}
