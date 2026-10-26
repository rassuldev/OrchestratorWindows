import type { DisplayStatus, Phase, ProjectState, StepRecord } from './api.js'

export const PHASE_LABELS: Record<Phase, string> = {
  questions: 'Аналитик готовит вопросы',
  await_answers: 'Ответы на вопросы',
  spec: 'Аналитик пишет спецификацию',
  await_spec: 'Одобрение спецификации',
  plan: 'Архитектор составляет план',
  design: 'Дизайнер готовит макеты',
  await_plan: 'Одобрение плана',
  build: 'Разработка',
  await_demo: 'Проверка демо',
  finalize: 'Финальный отчёт',
  needs_help: 'Нужна помощь',
  done: 'Готово',
}

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  waiting: 'ждёт вас',
  running: 'работает',
  queued: 'в очереди',
  paused: 'пауза',
  rate_limited: 'лимит',
  error: 'ошибка',
  done: 'готово',
}

export const STEP_STATUS_LABELS: Record<StepRecord['status'], string> = {
  running: 'идёт',
  ok: 'успешно',
  failed: 'неудачно',
  interrupted: 'прервано',
  limited: 'упёрлось в лимит',
}

/** The project page's status: like the server's displayStatus, with "running" read from the steps. */
export function stateStatus(s: ProjectState): DisplayStatus {
  if (s.phase === 'done') return 'done'
  if (s.error !== null) return 'error'
  if (s.paused) return 'paused'
  if (s.limitUntil !== null) return 'rate_limited'
  if (s.phase.startsWith('await_') || s.phase === 'needs_help') return 'waiting'
  return s.steps.some((st) => st.status === 'running') ? 'running' : 'queued'
}

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} с`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} мин ${sec % 60} с`
  return `${Math.floor(min / 60)} ч ${min % 60} мин`
}

export function formatCost(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`
}

export function formatTime(iso: string | number): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatWhen(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
