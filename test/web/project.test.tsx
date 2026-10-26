// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { ProjectDetails, ProjectEvents, ProjectState } from '../../web/src/api.js'

vi.mock('../../web/src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/src/api.js')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getProject: vi.fn(),
      getLogs: vi.fn(async () => []),
      getDoc: vi.fn(async () => null),
      listScreenshots: vi.fn(async () => []),
      setPauseOnLimit: vi.fn(),
    },
    subscribe: vi.fn(),
  }
})

const { api, subscribe } = await import('../../web/src/api.js')
const { ProjectPage } = await import('../../web/src/components/ProjectPage.js')
const { Docs } = await import('../../web/src/components/Docs.js')

const state = (patch: Partial<ProjectState> = {}): ProjectState => ({
  id: 'p1', slug: 'p1', name: 'Проект', createdAt: '2026-10-18T08:00:00.000Z', phase: 'design', subStep: 'implement',
  taskIndex: 0, attempt: 1, feedback: null, resumeNote: false, help: null, checkpoint: null, demoDone: false,
  chosenDesign: null, taskBase: null, feedbackRounds: 0, paused: false, limitUntil: null, limitHits: 0, pauseOnLimit: false, error: null,
  currentStepId: null,
  steps: [{ id: 's1', role: 'designer', label: 'Дизайн', attempt: 1, status: 'ok', startedAt: '2026-10-18T08:00:00.000Z', endedAt: '2026-10-18T08:01:00.000Z' }],
  ...patch,
})
const details = (s: ProjectState, patch: Partial<ProjectDetails> = {}): ProjectDetails => ({
  state: s, plan: null, questions: null, designOptions: null, app: { running: false, url: null }, ...patch,
})
const atPlan = state({ phase: 'await_plan', checkpoint: { kind: 'plan', message: 'Approve the plan and choose a design' } })
const designOptions = {
  options: [
    { id: 'a', title: 'Строгий', description: 'd', file: 'a.html' },
    { id: 'b', title: 'Мягкий', description: 'd', file: 'b.html' },
  ],
}

let events: ProjectEvents
beforeEach(() => {
  vi.mocked(subscribe).mockImplementation((_id, handlers) => {
    events = handlers
    return () => {}
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProjectPage', () => {
  it('does not offer «Одобрить» until the details for the new checkpoint (design options) have arrived', async () => {
    let resolveSecond!: (d: ProjectDetails) => void
    vi.mocked(api.getProject)
      .mockResolvedValueOnce(details(state()))
      .mockImplementationOnce(() => new Promise((res) => (resolveSecond = res)))
    render(<ProjectPage id="p1" />)
    expect(await screen.findByRole('heading', { name: /Проект/ })).toBeTruthy()

    act(() => events.onState(atPlan))
    expect(screen.queryByRole('button', { name: 'Одобрить' })).toBeNull()
    expect(screen.getByText('Загрузка данных для решения…')).toBeTruthy()

    const plan = {
      platform: 'web' as const, hasUI: true, runCommand: 'npm start', testCommand: 'npm test',
      milestones: [{ id: 'm1', title: 'MVP', mvp: true, tasks: [{ id: 't1', title: 'T', description: 'd', acceptance: ['a'], verify: [] }] }],
    }
    await act(async () => resolveSecond(details(atPlan, { designOptions, plan })))
    expect(screen.getByRole('button', { name: 'Одобрить' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('radio', { name: /Мягкий/ })).toBeTruthy()
  })

  it('shows a banner when a refetch fails instead of silently keeping stale data', async () => {
    vi.mocked(api.getProject).mockResolvedValueOnce(details(state())).mockRejectedValueOnce(new Error('Нет связи с сервером'))
    render(<ProjectPage id="p1" />)
    await screen.findByRole('heading', { name: /Проект/ })
    await act(async () => events.onState(atPlan))
    expect(screen.getByRole('alert').textContent).toContain('Не удалось обновить данные проекта: Нет связи с сервером')
  })

  it('shows a pause after a rate limit as a notice, not an error', async () => {
    const limited = state({
      paused: true,
      steps: [{ id: 's1', role: 'designer', label: 'Дизайн', attempt: 1, status: 'limited', startedAt: '2026-10-18T08:00:00.000Z', endedAt: '2026-10-18T08:01:00.000Z' }],
    })
    vi.mocked(api.getProject).mockResolvedValue(details(limited))
    render(<ProjectPage id="p1" />)
    await screen.findByRole('heading', { name: /Проект/ })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Достигнут лимит Claude — проект на паузе')
    expect(screen.getByRole('button', { name: /Продолжить/ })).toBeTruthy()
  })

  it('«Пауза при лимите» toggles the project flag', async () => {
    vi.mocked(api.getProject).mockResolvedValue(details(state()))
    vi.mocked(api.setPauseOnLimit).mockResolvedValue(state({ pauseOnLimit: true }))
    render(<ProjectPage id="p1" />)
    const toggle = await screen.findByRole('switch', { name: /Пауза при лимите/ })
    expect((toggle as HTMLInputElement).checked).toBe(false)
    await act(async () => toggle.click())
    expect(api.setPauseOnLimit).toHaveBeenCalledWith('p1', true)
    expect((toggle as HTMLInputElement).checked).toBe(true)
  })

  it('shows a log loading error, not «Лог пуст.», and retries on request', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getProject).mockResolvedValue(details(state()))
    vi.mocked(api.getLogs).mockRejectedValueOnce(new Error('Ошибка сервера (500)')).mockResolvedValueOnce([{ t: 1, kind: 'text', text: 'привет' }])
    render(<ProjectPage id="p1" />)
    expect(await screen.findByText(/Не удалось загрузить лог: Ошибка сервера \(500\)/)).toBeTruthy()
    expect(screen.queryByText('Лог пуст.')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByText('привет')).toBeTruthy()
  })
})

describe('Docs', () => {
  it('shows an error when the screenshot listing fails instead of the empty state', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listScreenshots).mockRejectedValueOnce(new Error('Нет связи с сервером'))
    render(<Docs projectId="p1" state={state()} plan={null} />)
    await user.click(screen.getByRole('tab', { name: 'Скриншоты' }))
    expect(await screen.findByText(/Не удалось загрузить список скриншотов: Нет связи с сервером/)).toBeTruthy()
    expect(screen.queryByText(/Скриншоты появятся/)).toBeNull()
  })

  it('never shows the previous tab\'s text under a new tab while it loads', async () => {
    const user = userEvent.setup()
    let resolveSpec!: (t: string) => void
    vi.mocked(api.getDoc).mockImplementation((_id, name) =>
      name === 'task' ? Promise.resolve('Текст задачи') : new Promise((res) => (resolveSpec = res)),
    )
    render(<Docs projectId="p1" state={state()} plan={null} />)
    expect(await screen.findByText('Текст задачи')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: 'Спецификация' }))
    expect(screen.queryByText('Текст задачи')).toBeNull()
    await act(async () => resolveSpec('Текст спецификации'))
    expect(screen.getByText('Текст спецификации')).toBeTruthy()
  })
})
