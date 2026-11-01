import { it, expect } from 'vitest'
import { projectPaths } from '../../src/core/paths.js'

it('lays out service files under .orchestrator and docs in the project root', () => {
  const p = projectPaths('/w/app')
  expect(p).toEqual({
    root: '/w/app',
    orch: '/w/app/.orchestrator',
    state: '/w/app/.orchestrator/state.json',
    task: '/w/app/.orchestrator/task.md',
    questions: '/w/app/.orchestrator/questions.json',
    answers: '/w/app/.orchestrator/answers.json',
    spec: '/w/app/.orchestrator/spec.md',
    architecture: '/w/app/.orchestrator/architecture.md',
    plan: '/w/app/.orchestrator/plan.json',
    decisions: '/w/app/.orchestrator/decisions.md',
    followups: '/w/app/.orchestrator/followups.md',
    designDir: '/w/app/.orchestrator/design',
    designOptions: '/w/app/.orchestrator/design/options.json',
    logsDir: '/w/app/.orchestrator/logs',
    screenshotsDir: '/w/app/.orchestrator/screenshots',
    verdictsDir: '/w/app/.orchestrator/verdicts',
    readme: '/w/app/README.md',
    report: '/w/app/REPORT.md',
    env: '/w/app/.env',
  })
})
