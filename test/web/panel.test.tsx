// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { pageTitle, parseRoute } from '../../web/src/App.js'
import { ProjectList } from '../../web/src/components/ProjectList.js'
import type { ProjectSummary } from '../../web/src/api.js'

afterEach(cleanup)

const p = (id: string, displayStatus: ProjectSummary['displayStatus'], updatedAt: string): ProjectSummary => ({
  id,
  name: `Проект ${id}`,
  phase: displayStatus === 'waiting' ? 'await_spec' : 'build',
  displayStatus,
  updatedAt,
})

describe('routing and title', () => {
  it('parses the hash routes', () => {
    expect(parseRoute('')).toEqual({ page: 'list' })
    expect(parseRoute('#/')).toEqual({ page: 'list' })
    expect(parseRoute('#/new')).toEqual({ page: 'new' })
    expect(parseRoute('#/p/abc%20d')).toEqual({ page: 'project', id: 'abc d' })
  })

  it('shows (N) in the title when N projects wait', () => {
    expect(pageTitle(0)).toBe('Orchestrator')
    expect(pageTitle(2)).toBe('(2) Orchestrator')
  })
})

describe('ProjectList', () => {
  it('lists waiting projects first with the «ждёт вас» badge and the phase in Russian', () => {
    render(
      <ProjectList
        error={null}
        projects={[p('a', 'running', '2026-10-18T10:00:00Z'), p('b', 'waiting', '2026-10-18T09:00:00Z'), p('c', 'done', '2026-10-18T11:00:00Z')]}
      />,
    )
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual(['Проект b', 'Проект a', 'Проект c'])
    expect(within(rows[0]!).getByText('ждёт вас')).toBeTruthy()
    expect(within(rows[0]!).getByText('Одобрение спецификации')).toBeTruthy()
    expect(within(rows[0]!).getByRole('link').getAttribute('href')).toBe('#/p/b')
    expect(screen.getByText('Один проект ждёт вашего решения')).toBeTruthy()
  })

  it('explains what to do when there are no projects', () => {
    render(<ProjectList error={null} projects={[]} />)
    expect(screen.getByRole('heading', { name: 'Проектов пока нет' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Описать задачу/ }).getAttribute('href')).toBe('#/new')
  })
})
