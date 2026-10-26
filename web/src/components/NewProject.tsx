import { useId, useState } from 'react'
import { api } from '../api.js'
import { Icon } from '../icons.js'

const MIN_TASK = 10

export function NewProject({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  const taskId = useId()
  const repoId = useId()
  const valid = name.trim().length > 0 && task.trim().length >= MIN_TASK

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const { id } = await api.createProject(name.trim(), task.trim(), repo.trim() || undefined)
      onCreated(id)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="page new-page">
      <header className="page-head">
        <div>
          <a className="back" href="#/">
            <Icon name="back" /> Проекты
          </a>
          <h1>Новый проект</h1>
        </div>
      </header>
      <form className="new-form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={nameId}>Название</label>
          <input
            id={nameId}
            maxLength={80}
            autoFocus
            placeholder="Например: Бот учёта расходов"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={repoId}>Существующий проект (необязательно)</label>
          <p className="hint" id={`${repoId}-hint`}>
            Абсолютный путь к git-репозиторию, чтобы продолжить его, а не начинать с нуля. Оркестратор работает в
            клоне, оригинал не меняется; незакоммиченные изменения не допускаются.
          </p>
          <input
            id={repoId}
            aria-describedby={`${repoId}-hint`}
            placeholder="C:\Users\you\projects\my-app"
            spellCheck={false}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={taskId}>Задача</label>
          <p className="hint" id={`${taskId}-hint`}>
            Чем подробнее, тем меньше вопросов: что за продукт и для кого, платформа, ключевые сценарии, данные,
            интеграции, ограничения и что точно не нужно. Можно писать как угодно длинно.
          </p>
          <textarea
            id={taskId}
            className="task-input"
            rows={18}
            aria-describedby={`${taskId}-hint`}
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
        </div>
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" /> {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={!valid || busy}>
            {busy && <Icon name="spinner" />}
            Создать и запустить
          </button>
          <span className="muted">
            {task.trim().length < MIN_TASK
              ? `Опишите задачу хотя бы в ${MIN_TASK} символов`
              : 'Первым делом аналитик прочитает задачу и задаст вопросы.'}
          </span>
        </div>
      </form>
    </div>
  )
}
