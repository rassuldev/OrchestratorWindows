#!/usr/bin/env node
// Fake `claude -p` CLI for tests. Behavior is driven by env vars (FAKE_CLAUDE_SCRIPT, FAKE_PLAN, FAKE_ARGV_FILE, FAKE_ECHO_ENV,
// FAKE_CHILD_PID_FILE for the 'hang_child'/'ok_child' behaviors).
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
if (process.env.FAKE_ARGV_FILE) appendFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv) + '\n')

const prompt = flag('-p') ?? ''
const systemPrompt = flag('--append-system-prompt') ?? ''
const role = /^ROLE:\s*(\S+)/.exec(systemPrompt.split('\n')[0])?.[1] ?? 'unknown'

function nextBehavior() {
  const file = process.env.FAKE_CLAUDE_SCRIPT
  if (!file) return 'ok'
  const script = JSON.parse(readFileSync(file, 'utf8'))
  const counterFile = `${file}.count.json`
  const counts = existsSync(counterFile) ? JSON.parse(readFileSync(counterFile, 'utf8')) : {}
  const n = counts[role] ?? 0
  counts[role] = n + 1
  writeFileSync(counterFile, JSON.stringify(counts))
  return script[role]?.[n] ?? 'ok'
}

const behavior = nextBehavior()

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const sessionId = 'fake-session'
const write = (rel, content) => {
  mkdirSync(dirname(rel), { recursive: true })
  writeFileSync(rel, content)
}
const line = (name) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(prompt)?.[1].trim()

const builtinPlan = {
  platform: 'cli',
  hasUI: false,
  runCommand: 'echo run',
  testCommand: 'echo ok',
  milestones: [
    { id: 'm1', title: 'Core', mvp: true, tasks: [{ id: 't1', title: 'First task', description: 'Create t1', acceptance: ['t1 exists'], verify: ['echo ok'] }] },
    { id: 'm2', title: 'More', mvp: false, tasks: [{ id: 't2', title: 'Second task', description: 'Create t2', acceptance: ['t2 exists'], verify: ['echo ok'] }] },
  ],
}

function writeOutputs(pass) {
  switch (role) {
    case 'analyst_questions':
      write('.orchestrator/questions.json', JSON.stringify({ questions: [{ id: 'q1', text: 'Question?' }], secrets: [] }))
      break
    case 'analyst_spec':
      write('.orchestrator/spec.md', '# Spec\n\nFake spec.\n')
      break
    case 'architect':
      write('.orchestrator/architecture.md', '# Architecture\n\nFake architecture.\n')
      write('.orchestrator/plan.json', process.env.FAKE_PLAN ?? JSON.stringify(builtinPlan))
      break
    case 'designer':
      write('.orchestrator/design/a.html', '<!doctype html><title>A</title><p>Option A</p>')
      write('.orchestrator/design/b.html', '<!doctype html><title>B</title><p>Option B</p>')
      write(
        '.orchestrator/design/options.json',
        JSON.stringify({
          options: [
            { id: 'a', title: 'Option A', description: 'First design', file: 'a.html' },
            { id: 'b', title: 'Option B', description: 'Second design', file: 'b.html' },
          ],
        }),
      )
      break
    case 'implementer': {
      mkdirSync('src', { recursive: true })
      appendFileSync(join('src', `${line('TASK_ID') ?? 'task'}.txt`), `attempt ${Date.now()}-${Math.random()}\n`)
      break
    }
    case 'verifier':
    case 'reviewer': {
      const verdictFile = line('VERDICT_FILE')
      if (verdictFile) write(verdictFile, JSON.stringify({ pass, issues: pass ? [] : ['fake issue'] }))
      break
    }
    case 'finalizer':
      write('README.md', '# Fake project\n')
      write('REPORT.md', '# Report\n\nDone.\n')
      break
  }
}

emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model' })

if (behavior === 'crash') {
  process.stderr.write('boom')
  process.exit(1)
}
if (behavior === 'hang_child' || behavior === 'ok_child') {
  // Like an agent that started a dev server: a grandchild that outlives a kill of this process alone.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  child.unref()
  writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid))
}
if (behavior === 'hang' || behavior === 'hang_child') {
  setInterval(() => {}, 1000)
} else {
  let text = `fake ${role} done`
  if (behavior === 'ok' || behavior === 'ok_child' || behavior === 'fail') writeOutputs(behavior !== 'fail')
  if (process.env.FAKE_ECHO_ENV === '1' && existsSync('.env')) text += `\n${readFileSync('.env', 'utf8')}`
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: sessionId })

  const base = { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.01 }
  if (behavior === 'rate_limit') emit({ ...base, is_error: true, result: "You've hit your session limit · resets 3:45pm" })
  else if (behavior === 'auth') emit({ ...base, is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })
  else emit(base)
}
