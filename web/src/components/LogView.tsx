import { useLayoutEffect, useRef } from 'react'
import type { LogEntry } from '../api.js'
import { Icon } from '../icons.js'
import { formatTime } from '../labels.js'

const KIND_LABELS: Record<LogEntry['kind'], string> = {
  text: 'агент',
  tool: 'действие',
  tool_result: 'результат',
  system: 'система',
  result: 'итог',
  error: 'ошибка',
}

const LONG_CHARS = 600
const LONG_LINES = 8

function EntryText({ text }: { text: string }) {
  const lines = text.split('\n')
  if (text.length <= LONG_CHARS && lines.length <= LONG_LINES) return <span className="log-text">{text}</span>
  return (
    <details className="log-text">
      <summary>
        {lines[0]!.slice(0, 160)}
        <span className="muted"> … ещё {lines.length > 1 ? `${lines.length - 1} строк` : `${text.length} символов`}</span>
      </summary>
      {text}
    </details>
  )
}

type Props = {
  title: string
  entries: LogEntry[] | null
  /** Following the running step (new entries keep the view pinned to the bottom). */
  live: boolean
  /** Shown when a past step is selected: returns to the running (or latest) step. */
  onFollow?: () => void
  followLabel?: string
  /** The step's log could not be loaded. */
  error?: string
  onRetry?: () => void
}

export function LogView({ title, entries, live, onFollow, followLabel = 'К текущему шагу', error, onRetry }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries])

  return (
    <section className="log" aria-label="Лог шага">
      <header className="log-head">
        <h2>
          {live && <span className="live-dot" aria-hidden="true" />}
          {title}
        </h2>
        {onFollow && (
          <button className="btn ghost small" onClick={onFollow}>
            <Icon name="follow" /> {followLabel}
          </button>
        )}
      </header>
      <div
        className="log-body"
        ref={box}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {error && (
          <p className="muted load-error">
            Не удалось загрузить лог: {error}{' '}
            {onRetry && (
              <button className="btn small" onClick={onRetry}>
                Повторить
              </button>
            )}
          </p>
        )}
        {entries === null ? (
          <p className="muted">Загрузка лога…</p>
        ) : entries.length === 0 ? (
          error ? null : (
            <p className="muted">{live ? 'Ждём первых сообщений агента…' : 'Лог пуст.'}</p>
          )
        ) : (
          entries.map((e, i) => (
            <div key={i} className={`log-entry log-${e.kind}`}>
              <time className="log-time">{formatTime(e.t)}</time>
              <span className="log-kind">{KIND_LABELS[e.kind]}</span>
              <EntryText text={e.text} />
            </div>
          ))
        )}
      </div>
    </section>
  )
}
