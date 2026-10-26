// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Checkpoint } from '../../web/src/components/Checkpoint.js'
import type { DesignOptions, Plan, Questions, UserInput } from '../../src/core/schemas.js'

afterEach(cleanup)

const questions: Questions = {
  questions: [
    { id: 'q1', text: 'Нужна авторизация?', options: ['Да', 'Нет'] },
    { id: 'q2', text: 'Какой язык интерфейса?', options: ['Русский', 'Английский'] },
    { id: 'q3', text: 'Что ещё важно?' },
  ],
  secrets: [{ name: 'BOT_TOKEN', description: 'Токен бота от @BotFather' }],
}

const designOptions: DesignOptions = {
  options: [
    { id: 'a', title: 'Строгий', description: 'Плотная таблица', file: 'a.html' },
    { id: 'b', title: 'Мягкий', description: 'Карточки', file: 'b.html' },
  ],
}

const uiPlan: Plan = {
  platform: 'web',
  hasUI: true,
  runCommand: 'npm start',
  testCommand: 'npm test',
  milestones: [{ id: 'm1', title: 'MVP', mvp: true, tasks: [{ id: 't1', title: 'T', description: 'd', acceptance: ['a'], verify: [] }] }],
}

/** An onSubmit spy that stays pending until `resolve()` is called. */
function pendingSpy() {
  let resolve!: () => void
  const spy = vi.fn((_input: UserInput) => new Promise<void>((res) => (resolve = res)))
  return { spy, resolve: () => resolve() }
}

describe('answers', () => {
  it('answers form submits answers and secrets', async () => {
    const user = userEvent.setup()
    const spy = vi.fn(async (_input: UserInput) => {})
    render(<Checkpoint kind="answers" questions={{ ...questions, questions: questions.questions.slice(0, 1) }} onSubmit={spy} />)

    await user.click(screen.getByLabelText('Да'))
    await user.type(screen.getByLabelText('BOT_TOKEN'), 'x1234')
    expect(screen.getByLabelText('BOT_TOKEN')).toHaveProperty('type', 'password')
    expect(screen.getByText('Токен бота от @BotFather')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Отправить' }))

    expect(spy).toHaveBeenCalledWith({ kind: 'answers', answers: { q1: 'Да' }, secrets: { BOT_TOKEN: 'x1234' } })
  })

  it('supports «свой вариант» for questions with options and free text for the rest', async () => {
    const user = userEvent.setup()
    const spy = vi.fn(async (_input: UserInput) => {})
    render(<Checkpoint kind="answers" questions={questions} onSubmit={spy} />)

    await user.click(screen.getByLabelText('Нет'))
    const q2 = screen.getByRole('group', { name: /Какой язык интерфейса/ })
    await user.click(screen.getAllByLabelText('Свой вариант')[1])
    await user.type(screen.getByRole('textbox', { name: 'Свой вариант: Какой язык интерфейса?' }), 'Казахский')
    expect(q2).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: /Что ещё важно/ }), 'Скорость')
    await user.type(screen.getByLabelText('BOT_TOKEN'), 't')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))

    expect(spy).toHaveBeenCalledWith({
      kind: 'answers',
      answers: { q1: 'Нет', q2: 'Казахский', q3: 'Скорость' },
      secrets: { BOT_TOKEN: 't' },
    })
  })
})

describe('answers: empty secrets', () => {
  it('warns about empty secret fields and sends without them only on a second click', async () => {
    const user = userEvent.setup()
    const spy = vi.fn(async (_input: UserInput) => {})
    render(<Checkpoint kind="answers" questions={{ ...questions, questions: questions.questions.slice(0, 1) }} onSubmit={spy} />)

    await user.click(screen.getByLabelText('Да'))
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('BOT_TOKEN')
    await user.click(screen.getByRole('button', { name: 'Отправить без них' }))

    expect(spy).toHaveBeenCalledWith({ kind: 'answers', answers: { q1: 'Да' }, secrets: {} })
  })
})

describe('spec / plan', () => {
  it('plan approve is disabled until a design is chosen when options exist', async () => {
    const user = userEvent.setup()
    const spy = vi.fn(async (_input: UserInput) => {})
    render(<Checkpoint kind="plan" plan={uiPlan} designOptions={designOptions} onSubmit={spy} />)

    const approve = screen.getByRole('button', { name: 'Одобрить' })
    expect(approve).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('radio', { name: /Мягкий/ }))
    expect(approve).toHaveProperty('disabled', false)
    await user.click(approve)

    expect(spy).toHaveBeenCalledWith({ kind: 'approve', designId: 'b' })
  })

  it('plan without design options approves right away; design links open the HTML in a new tab', async () => {
    const user = userEvent.setup()
    const spy = vi.fn(async (_input: UserInput) => {})
    const { rerender } = render(<Checkpoint kind="plan" onSubmit={spy} />)
    await user.click(screen.getByRole('button', { name: 'Одобрить' }))
    expect(spy).toHaveBeenCalledWith({ kind: 'approve' })

    rerender(
      <Checkpoint kind="plan" plan={uiPlan} designOptions={designOptions} onSubmit={spy} deps={{ assetUrl: (p) => `/asset/${p}` }} />,
    )
    const links = screen.getAllByRole('link', { name: /Открыть макет/ })
    expect(links[0].getAttribute('href')).toBe('/asset/design/a.html')
    expect(links[0].getAttribute('target')).toBe('_blank')
  })

  it('a plan revised to hasUI false ignores leftover design options', async () => {
    const user = userEvent.setup()
    const spy = vi.fn(async (_input: UserInput) => {})
    render(<Checkpoint kind="plan" plan={{ ...uiPlan, hasUI: false }} designOptions={designOptions} onSubmit={spy} />)
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Одобрите план' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Одобрить' }))
    expect(spy).toHaveBeenCalledWith({ kind: 'approve' })
  })

  it('spec renders the document and «Поправить» sends a revise comment', async () => {
    const user = userEvent.setup()
    const spy = vi.fn(async (_input: UserInput) => {})
    const getDoc = vi.fn(async (name: string) => (name === 'spec' ? '# Спецификация\n\n- **Вход** по email' : null))
    render(<Checkpoint kind="spec" onSubmit={spy} deps={{ getDoc }} />)

    expect(await screen.findByRole('heading', { name: 'Спецификация' })).toBeTruthy()
    expect(screen.getByText('Вход').tagName).toBe('STRONG')
    await user.click(screen.getByRole('button', { name: 'Поправить' }))
    const send = screen.getByRole('button', { name: 'Отправить правки' })
    expect(send).toHaveProperty('disabled', true)
    await user.type(screen.getByRole('textbox', { name: 'Что поправить' }), 'Добавить вход через Google')
    await user.click(send)

    expect(spy).toHaveBeenCalledWith({ kind: 'revise', comment: 'Добавить вход через Google' })
  })
})

describe('demo', () => {
  it('«Всё хорошо, продолжай» sends empty comments; remarks are sent as written', async () => {
    const user = userEvent.setup()
    const spy = vi.fn(async (_input: UserInput) => {})
    render(<Checkpoint kind="demo" onSubmit={spy} />)

    await user.click(screen.getByRole('button', { name: 'Всё хорошо, продолжай' }))
    expect(spy).toHaveBeenLastCalledWith({ kind: 'demo', comments: '' })

    expect(screen.getByRole('button', { name: 'Отправить замечания' })).toHaveProperty('disabled', true)
    await user.type(screen.getByRole('textbox', { name: 'Замечания' }), 'Кнопка мелкая')
    await user.click(screen.getByRole('button', { name: 'Отправить замечания' }))
    expect(spy).toHaveBeenLastCalledWith({ kind: 'demo', comments: 'Кнопка мелкая' })
  })

  it('starts the app and shows its link and the latest verifier screenshots', async () => {
    const user = userEvent.setup()
    const startApp = vi.fn(async () => ({ running: true, url: 'http://localhost:5173' }))
    const listScreenshots = vi.fn(async () => [
      'design/a-desktop.png',
      'screenshots/t2-a1/home/desktop.png',
      'screenshots/t2-a1/home/mobile.png',
      'screenshots/t1-a1/home/desktop.png',
    ])
    render(<Checkpoint kind="demo" onSubmit={vi.fn()} deps={{ startApp, listScreenshots, assetUrl: (p) => `/asset/${p}` }} />)

    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual([
      '/asset/screenshots/t2-a1/home/desktop.png',
      '/asset/screenshots/t2-a1/home/mobile.png',
    ])
    await user.click(screen.getByRole('button', { name: 'Запустить приложение' }))
    const link = await screen.findByRole('link', { name: 'http://localhost:5173' })
    expect(link.getAttribute('target')).toBe('_blank')
  })
})

describe('demo: failures', () => {
  it('shows a muted error when the screenshot listing fails instead of silently showing nothing', async () => {
    const listScreenshots = vi.fn(async () => {
      throw new Error('Нет связи с сервером')
    })
    render(<Checkpoint kind="demo" onSubmit={vi.fn()} deps={{ listScreenshots }} />)
    expect(await screen.findByText(/Не удалось загрузить скриншоты: Нет связи с сервером/)).toBeTruthy()
  })
})

describe('help', () => {
  it('help panel hides «Пропустить задачу» outside build', () => {
    render(<Checkpoint kind="help" message="Spec failed twice" helpPhase="spec" onSubmit={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Пропустить задачу' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Повторить с подсказкой' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Исправил сам — продолжай' })).toBeTruthy()
    expect(screen.getByText('Spec failed twice')).toBeTruthy()
  })

  it('in build: retry sends the hint, skip and continue send their actions', async () => {
    const user = userEvent.setup()
    const spy = vi.fn(async (_input: UserInput) => {})
    render(<Checkpoint kind="help" message="t1 failed 3 times" helpPhase="build" onSubmit={spy} />)

    await user.type(screen.getByRole('textbox', { name: 'Подсказка' }), 'Используй порт 3001')
    await user.click(screen.getByRole('button', { name: 'Повторить с подсказкой' }))
    expect(spy).toHaveBeenLastCalledWith({ kind: 'help', action: 'retry', hint: 'Используй порт 3001' })
    await user.click(screen.getByRole('button', { name: 'Пропустить задачу' }))
    expect(spy).toHaveBeenLastCalledWith({ kind: 'help', action: 'skip' })
  })
})

describe('submitting', () => {
  it('buttons disable after click until the response, and an error is shown', async () => {
    const user = userEvent.setup()
    const { spy, resolve } = pendingSpy()
    render(<Checkpoint kind="spec" onSubmit={spy} />)

    await user.click(screen.getByRole('button', { name: 'Одобрить' }))
    expect(screen.getByRole('button', { name: 'Одобрить' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Поправить' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('button', { name: 'Одобрить' }))
    expect(spy).toHaveBeenCalledTimes(1)
    resolve()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Одобрить' })).toHaveProperty('disabled', false))

    spy.mockImplementationOnce(async () => {
      throw new Error('Состояние уже изменилось')
    })
    await user.click(screen.getByRole('button', { name: 'Одобрить' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Состояние уже изменилось')
  })
})
