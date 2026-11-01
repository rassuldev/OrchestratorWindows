import { join } from 'node:path'

export interface ProjectPaths {
  root: string
  orch: string
  state: string
  task: string
  questions: string
  answers: string
  spec: string
  architecture: string
  plan: string
  decisions: string
  followups: string
  designDir: string
  designOptions: string
  logsDir: string
  screenshotsDir: string
  verdictsDir: string
  readme: string
  report: string
  env: string
}

/** Service files live in `<dir>/.orchestrator/`; README.md, REPORT.md and .env live in the project root. */
export function projectPaths(dir: string): ProjectPaths {
  const orch = join(dir, '.orchestrator')
  const designDir = join(orch, 'design')
  return {
    root: dir,
    orch,
    state: join(orch, 'state.json'),
    task: join(orch, 'task.md'),
    questions: join(orch, 'questions.json'),
    answers: join(orch, 'answers.json'),
    spec: join(orch, 'spec.md'),
    architecture: join(orch, 'architecture.md'),
    plan: join(orch, 'plan.json'),
    decisions: join(orch, 'decisions.md'),
    followups: join(orch, 'followups.md'),
    designDir,
    designOptions: join(designDir, 'options.json'),
    logsDir: join(orch, 'logs'),
    screenshotsDir: join(orch, 'screenshots'),
    verdictsDir: join(orch, 'verdicts'),
    readme: join(dir, 'README.md'),
    report: join(dir, 'REPORT.md'),
    env: join(dir, '.env'),
  }
}
