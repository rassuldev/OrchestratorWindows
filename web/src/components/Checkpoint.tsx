import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  latestVerifierShots,
  type AppStatus,
  type Checkpoint as CheckpointData,
  type DesignOptions,
  type DocName,
  type Phase,
  type Plan,
  type Questions,
  type UserInput,
} from '../api.js'
import { Icon } from '../icons.js'
import { Markdown, PlanView, useDoc } from './Docs.js'

export type CheckpointDeps = {
  getDoc: (name: DocName) => Promise<string | null>
  startApp: () => Promise<AppStatus>
  stopApp: () => Promise<AppStatus>
  listScreenshots: () => Promise<string[]>
  /** URL of a file relative to `.orchestrator/`. */
  assetUrl: (path: string) => string
}

const NO_DEPS: CheckpointDeps = {
  getDoc: async () => null,
  startApp: async () => ({ running: false, url: null }),
  stopApp: async () => ({ running: false, url: null }),
  listScreenshots: async () => [],
  assetUrl: (path) => path,
}

export type CheckpointProps = {
  kind: CheckpointData['kind']
  /** The pipeline's own message (shown for help, where it explains what failed). */
  message?: string
  /** Extra detail for help: the last failed step's error. */
  detail?: string | null
  questions?: Questions | null
  designOptions?: DesignOptions | null
  plan?: Plan | null
  /** Where the pipeline returns after help; «Пропустить задачу» exists only for build. */
  helpPhase?: Phase | null
  app?: AppStatus | null
  deps?: Partial<CheckpointDeps>
  /** Resolves when the server accepted the input; a rejection's message is shown. */
  onSubmit: (input: UserInput) => Promise<unknown> | void
}

const HEADINGS: Record<CheckpointData['kind'], { title: string; lead: string }> = {
  answers: {
    title: 'Ответьте на вопросы аналитика',
    lead: 'Ответы лягут в спецификацию. Секреты сохраняются только в .env проекта и после отправки нигде не показываются.',
  },
  spec: {
    title: 'Одобрите спецификацию',
    lead: 'Это описание того, что будет построено. После одобрения архитектор составит план.',
  },
  plan: {
    title: 'Одобрите план',
    lead: 'После одобрения начнётся разработка: задача за задачей, каждая проходит реализацию, проверку и ревью.',
  },
  demo: {
    title: 'Проверьте MVP',
    lead: 'Минимальная версия готова. Запустите её и посмотрите сами; замечания станут отдельной вехой плана.',
  },
  help: {
    title: 'Нужна ваша помощь',
    lead: 'Агент не справился сам и остановился. Выберите, как продолжить.',
  },
}

export function Checkpoint(props: CheckpointProps) {
  const deps: CheckpointDeps = { ...NO_DEPS, ...props.deps }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const headingId = useId()

  const submit = async (input: UserInput) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit(input)
    } catch (e) {
      setError((e as Error).message || 'Не удалось отправить')
    } finally {
      setBusy(false)
    }
  }

  const heading = HEADINGS[props.kind]
  const hasDesigns = props.kind === 'plan' && props.plan?.hasUI === true && (props.designOptions?.options.length ?? 0) > 0
  const ctx: PanelContext = { ...props, deps, busy, submit }

  return (
    <section className="checkpoint" aria-labelledby={headingId}>
      <header className="checkpoint-head">
        <span className="waiting-badge">
          <span className="pulse" aria-hidden="true" />
          Ждёт вас
        </span>
        <h2 id={headingId}>{hasDesigns ? 'Одобрите план и выберите дизайн' : heading.title}</h2>
        <p className="lead">{heading.lead}</p>
      </header>
      {props.kind === 'answers' && <AnswersForm {...ctx} />}
      {(props.kind === 'spec' || props.kind === 'plan') && <ApprovePanel {...ctx} />}
      {props.kind === 'demo' && <DemoPanel {...ctx} />}
      {props.kind === 'help' && <HelpPanel {...ctx} />}
      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
    </section>
  )
}

type PanelContext = CheckpointProps & { deps: CheckpointDeps; busy: boolean; submit: (input: UserInput) => Promise<void> }

const CUSTOM = '__custom__'

function AnswersForm({ questions, busy, submit }: PanelContext) {
  const list = questions?.questions ?? []
  const secrets = questions?.secrets ?? []
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [text, setText] = useState<Record<string, string>>({})
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const formId = useId()

  const answerOf = (id: string, hasOptions: boolean) =>
    hasOptions && choice[id] !== CUSTOM ? (choice[id] ?? '') : (text[id] ?? '').trim()
  const answered = list.filter((q) => answerOf(q.id, !!q.options?.length) !== '').length

  const emptySecrets = secrets.map((s) => s.name).filter((name) => (secretValues[name] ?? '').trim() === '')
  // Empty secrets need a second, explicit click; editing a secret asks again.
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (emptySecrets.length > 0 && !confirmEmpty) {
      setConfirmEmpty(true)
      return
    }
    const answers = Object.fromEntries(list.map((q) => [q.id, answerOf(q.id, !!q.options?.length)]))
    const values = Object.fromEntries(
      secrets.map((s) => [s.name, (secretValues[s.name] ?? '').trim()] as const).filter(([, v]) => v !== ''),
    )
    void submit({ kind: 'answers', answers, secrets: values })
  }

  return (
    <form className="answers" onSubmit={onSubmit}>
      {list.length === 0 && secrets.length === 0 && <p className="empty">Вопросов нет — просто отправьте.</p>}
      {list.map((q, n) => {
        const name = `${formId}-${q.id}`
        if (!q.options?.length) {
          return (
            <div key={q.id} className="question">
              <label htmlFor={name} className="question-text">
                <span className="q-num" aria-hidden="true">
                  {n + 1}
                </span>
                {q.text}
              </label>
              <textarea
                id={name}
                rows={2}
                value={text[q.id] ?? ''}
                onChange={(e) => setText({ ...text, [q.id]: e.target.value })}
              />
            </div>
          )
        }
        return (
          <fieldset key={q.id} className="question">
            <legend className="question-text">
              <span className="q-num" aria-hidden="true">
                {n + 1}
              </span>
              {q.text}
            </legend>
            <div className="options">
              {[...q.options, CUSTOM].map((opt) => (
                <label key={opt} className="option">
                  <input
                    type="radio"
                    name={name}
                    value={opt}
                    checked={choice[q.id] === opt}
                    onChange={() => setChoice({ ...choice, [q.id]: opt })}
                  />
                  <span>{opt === CUSTOM ? 'Свой вариант' : opt}</span>
                </label>
              ))}
            </div>
            {choice[q.id] === CUSTOM && (
              <input
                type="text"
                className="custom-answer"
                aria-label={`Свой вариант: ${q.text}`}
                autoFocus
                value={text[q.id] ?? ''}
                onChange={(e) => setText({ ...text, [q.id]: e.target.value })}
              />
            )}
          </fieldset>
        )
      })}
      {secrets.length > 0 && (
        <div className="secrets">
          <h3>Секреты</h3>
          {secrets.map((s) => {
            const id = `${formId}-secret-${s.name}`
            return (
              <div key={s.name} className="secret">
                <label htmlFor={id} className="mono">
                  {s.name}
                </label>
                <input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  aria-describedby={`${id}-desc`}
                  value={secretValues[s.name] ?? ''}
                  onChange={(e) => {
                    setSecretValues({ ...secretValues, [s.name]: e.target.value })
                    setConfirmEmpty(false)
                  }}
                />
                <p id={`${id}-desc`} className="hint">
                  {s.description}
                </p>
              </div>
            )
          })}
        </div>
      )}
      {confirmEmpty && emptySecrets.length > 0 && (
        <p className="form-warning" role="alert">
          <Icon name="alert" /> Не заполнены секреты: {emptySecrets.join(', ')}. Без них часть функций может не
          заработать. Отправить ответы без этих секретов?
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy && <Icon name="spinner" />}
          {confirmEmpty && emptySecrets.length > 0 ? 'Отправить без них' : 'Отправить'}
        </button>
        {list.length > 0 && (
          <span className="muted">
            Отвечено {answered} из {list.length}
          </span>
        )}
      </div>
    </form>
  )
}

function RevisableActions({
  busy,
  submit,
  canApprove,
  approve,
  blockedHint,
}: {
  busy: boolean
  submit: (input: UserInput) => Promise<void>
  canApprove: boolean
  approve: UserInput
  blockedHint?: string
}) {
  const [revising, setRevising] = useState(false)
  const [comment, setComment] = useState('')
  const id = useId()
  return (
    <>
      {revising && (
        <div className="revise">
          <label htmlFor={id}>Что поправить</label>
          <textarea id={id} rows={4} autoFocus value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
      )}
      <div className="actions">
        <button className="btn primary" disabled={busy || !canApprove} onClick={() => void submit(approve)}>
          {busy && <Icon name="spinner" />}
          Одобрить
        </button>
        {revising ? (
          <>
            <button
              className="btn"
              disabled={busy || comment.trim() === ''}
              onClick={() => void submit({ kind: 'revise', comment: comment.trim() })}
            >
              Отправить правки
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setRevising(false)}>
              Отмена
            </button>
          </>
        ) : (
          <button className="btn" disabled={busy} onClick={() => setRevising(true)}>
            Поправить
          </button>
        )}
        {!canApprove && blockedHint && <span className="muted">{blockedHint}</span>}
      </div>
    </>
  )
}

function DesignPicker({
  options,
  value,
  onChange,
  assetUrl,
}: {
  options: DesignOptions['options']
  value: string | null
  onChange: (id: string) => void
  assetUrl: (path: string) => string
}) {
  const name = useId()
  return (
    <fieldset className="designs">
      <legend>Варианты дизайна</legend>
      <div className="design-grid">
        {options.map((o) => (
          <div key={o.id} className={`design-option${value === o.id ? ' selected' : ''}`}>
            <label className="design-pick">
              <Thumb src={assetUrl(`design/${o.id}-desktop.png`)} className="thumb-desktop" />
              <span className="design-text">
                <input type="radio" name={name} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} />
                <strong>{o.title}</strong>
                <span className="hint">{o.description}</span>
              </span>
            </label>
            <a className="link" href={assetUrl(`design/${o.file}`)} target="_blank" rel="noopener noreferrer">
              Открыть макет «{o.title}» <Icon name="external" />
            </a>
          </div>
        ))}
      </div>
    </fieldset>
  )
}

/** A screenshot thumbnail that turns into a quiet placeholder when the file is missing. */
function Thumb({ src, className }: { src: string; className?: string }) {
  const [missing, setMissing] = useState(false)
  if (missing) return <span className={`thumb thumb-missing ${className ?? ''}`}>нет скриншота</span>
  return <img className={`thumb ${className ?? ''}`} src={src} alt="" onError={() => setMissing(true)} />
}

function ApprovePanel({ kind, plan, designOptions, deps, busy, submit }: PanelContext) {
  // Options left over from before a revision that dropped the UI are not offered.
  const options = kind === 'plan' && plan?.hasUI === true ? (designOptions?.options ?? []) : []
  const [design, setDesign] = useState<string | null>(null)
  const doc = useDoc(() => deps.getDoc(kind === 'spec' ? 'spec' : 'architecture'), kind)
  const approve: UserInput = options.length > 0 && design ? { kind: 'approve', designId: design } : { kind: 'approve' }

  let body: ReactNode
  if (kind === 'spec') {
    body = doc.text !== null ? <Markdown text={doc.text} /> : <p className="muted">{doc.loading ? 'Загрузка…' : 'Спецификация не найдена.'}</p>
  } else {
    body = (
      <>
        {plan ? <PlanView plan={plan} expanded /> : null}
        {doc.text !== null && (
          <section className="architecture">
            <h2 className="doc-section-title">Архитектура</h2>
            <Markdown text={doc.text} />
          </section>
        )}
      </>
    )
  }

  return (
    <>
      {options.length > 0 && <DesignPicker options={options} value={design} onChange={setDesign} assetUrl={deps.assetUrl} />}
      <div className="doc-scroll">{body}</div>
      <RevisableActions
        busy={busy}
        submit={submit}
        canApprove={options.length === 0 || design !== null}
        approve={approve}
        blockedHint="Сначала выберите вариант дизайна"
      />
    </>
  )
}

function DemoPanel({ app, deps, busy, submit }: PanelContext) {
  const [status, setStatus] = useState<AppStatus>(app ?? { running: false, url: null })
  const [starting, setStarting] = useState(false)
  const [appError, setAppError] = useState<string | null>(null)
  const [shots, setShots] = useState<string[]>([])
  const [shotsError, setShotsError] = useState<string | null>(null)
  const [comments, setComments] = useState('')
  const id = useId()

  useEffect(() => {
    let live = true
    deps.listScreenshots().then(
      (paths) => live && setShots(latestVerifierShots(paths)),
      (e: unknown) => live && setShotsError((e as Error).message),
    )
    return () => {
      live = false
    }
    // load once per checkpoint
  }, [])

  const toggleApp = async () => {
    setStarting(true)
    setAppError(null)
    try {
      setStatus(status.running ? await deps.stopApp() : await deps.startApp())
    } catch (e) {
      setAppError((e as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <>
      <div className="demo-app">
        <button className="btn" disabled={starting} onClick={() => void toggleApp()}>
          {starting ? <Icon name="spinner" /> : <Icon name={status.running ? 'stop' : 'play'} />}
          {status.running ? 'Остановить приложение' : 'Запустить приложение'}
        </button>
        {status.running &&
          (status.url ? (
            <a className="link mono" href={status.url} target="_blank" rel="noopener noreferrer">
              {status.url}
            </a>
          ) : (
            <span className="muted">Запущено, но адрес не определён — посмотрите вывод в логе.</span>
          ))}
        {appError && <span className="form-error">{appError}</span>}
      </div>
      {shotsError && <p className="muted load-error">Не удалось загрузить скриншоты: {shotsError}</p>}
      {shots.length > 0 && (
        <div className="demo-shots">
          <h3>Последние скриншоты проверки</h3>
          <div className="shots">
            {shots.map((s) => (
              <a key={s} className="shot" href={deps.assetUrl(s)} target="_blank" rel="noopener noreferrer">
                <img src={deps.assetUrl(s)} alt={s} loading="lazy" />
                <span className="mono">{s.replace(/^screenshots\//, '')}</span>
              </a>
            ))}
          </div>
        </div>
      )}
      <div className="revise">
        <label htmlFor={id}>Замечания</label>
        <textarea
          id={id}
          rows={4}
          placeholder="Что исправить или добавить. Пусто — если всё устраивает."
          value={comments}
          onChange={(e) => setComments(e.target.value)}
        />
      </div>
      <div className="actions">
        <button className="btn primary" disabled={busy} onClick={() => void submit({ kind: 'demo', comments: '' })}>
          {busy && <Icon name="spinner" />}
          Всё хорошо, продолжай
        </button>
        <button
          className="btn"
          disabled={busy || comments.trim() === ''}
          onClick={() => void submit({ kind: 'demo', comments: comments.trim() })}
        >
          Отправить замечания
        </button>
      </div>
    </>
  )
}

function HelpPanel({ message, detail, helpPhase, busy, submit }: PanelContext) {
  const [hint, setHint] = useState('')
  const id = useId()
  const trimmed = hint.trim()
  return (
    <>
      {message && <p className="help-message">{message}</p>}
      {detail && <pre className="help-detail">{detail}</pre>}
      <div className="revise">
        <label htmlFor={id}>Подсказка</label>
        <textarea
          id={id}
          rows={3}
          placeholder="Что агенту стоит знать или сделать иначе"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
        />
      </div>
      <div className="actions">
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => void submit(trimmed ? { kind: 'help', action: 'retry', hint: trimmed } : { kind: 'help', action: 'retry' })}
        >
          {busy && <Icon name="spinner" />}
          Повторить с подсказкой
        </button>
        {helpPhase === 'build' && (
          <button className="btn" disabled={busy} onClick={() => void submit({ kind: 'help', action: 'skip' })}>
            Пропустить задачу
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => void submit({ kind: 'help', action: 'continue' })}>
          Исправил сам — продолжай
        </button>
      </div>
      <dl className="help-legend">
        <dt>Повторить</dt>
        <dd>агент попробует снова, с вашей подсказкой, если она есть.</dd>
        {helpPhase === 'build' && (
          <>
            <dt>Пропустить</dt>
            <dd>задача останется недоделанной, разработка пойдёт дальше.</dd>
          </>
        )}
        <dt>Исправил сам</dt>
        <dd>вы поправили код или окружение руками — конвейер продолжит с этого места.</dd>
      </dl>
    </>
  )
}
