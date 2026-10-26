import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateOutputs } from '../../src/core/outputs.js'
import { projectPaths } from '../../src/core/paths.js'
import type { Plan } from '../../src/core/schemas.js'

let dir: string
let p: ReturnType<typeof projectPaths>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orch-outputs-'))
  p = projectPaths(dir)
  for (const d of [p.orch, p.designDir, p.verdictsDir]) await mkdir(d, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const plan: Plan = {
  platform: 'cli',
  hasUI: false,
  runCommand: 'echo run',
  testCommand: 'echo ok',
  milestones: [
    { id: 'm1', title: 'Core', mvp: true, tasks: [{ id: 't1', title: 'T', description: 'D', acceptance: ['a'], verify: [] }] },
  ],
}

const expectError = async (promise: ReturnType<typeof validateOutputs>, ...parts: string[]) => {
  const r = await promise
  expect(r.ok).toBe(false)
  if (r.ok) return
  for (const part of parts) expect(r.error).toContain(part)
}

describe('validateOutputs', () => {
  it('questions: valid file passes, a bad secret name fails naming the file and the issue', async () => {
    await expectError(validateOutputs('analyst_questions', dir), 'questions.json')
    await writeFile(p.questions, JSON.stringify({ questions: [{ id: 'q1', text: 'Q?' }], secrets: [] }))
    expect(await validateOutputs('analyst_questions', dir)).toEqual({ ok: true })
    await writeFile(p.questions, JSON.stringify({ questions: [], secrets: [{ name: 'bad-name', description: 'x' }] }))
    await expectError(validateOutputs('analyst_questions', dir), 'questions.json', 'secrets.0.name', 'ENV_STYLE')
  })

  it('questions: invalid JSON fails naming the file', async () => {
    await writeFile(p.questions, '{not json')
    await expectError(validateOutputs('analyst_questions', dir), 'questions.json', 'JSON')
  })

  it('spec: missing or blank spec.md fails', async () => {
    await expectError(validateOutputs('analyst_spec', dir), 'spec.md')
    await writeFile(p.spec, '  \n')
    await expectError(validateOutputs('analyst_spec', dir), 'spec.md', 'empty')
    await writeFile(p.spec, '# Spec\n')
    expect(await validateOutputs('analyst_spec', dir)).toEqual({ ok: true })
  })

  it('architect output without plan.json fails naming plan.json', async () => {
    await writeFile(p.architecture, '# Architecture\n')
    await expectError(validateOutputs('architect', dir), 'plan.json')
    await writeFile(p.plan, JSON.stringify(plan))
    expect(await validateOutputs('architect', dir)).toEqual({ ok: true })
  })

  it('architect: plan.json violating the schema fails with the zod issue; missing architecture.md fails', async () => {
    await writeFile(p.plan, JSON.stringify({ ...plan, milestones: [{ ...plan.milestones[0], mvp: false }] }))
    await writeFile(p.architecture, '# Architecture\n')
    await expectError(validateOutputs('architect', dir), 'plan.json', 'exactly one milestone')
    await writeFile(p.plan, JSON.stringify(plan))
    await rm(p.architecture)
    await expectError(validateOutputs('architect', dir), 'architecture.md')
  })

  it('designer option pointing at a missing file fails', async () => {
    const options = {
      options: [
        { id: 'a', title: 'A', description: 'a', file: 'a.html' },
        { id: 'b', title: 'B', description: 'b', file: 'b.html' },
      ],
    }
    await writeFile(p.designOptions, JSON.stringify(options))
    await writeFile(join(p.designDir, 'a.html'), '<p>A</p>')
    await expectError(validateOutputs('designer', dir), 'b.html')
    await writeFile(join(p.designDir, 'b.html'), '<p>B</p>')
    expect(await validateOutputs('designer', dir)).toEqual({ ok: true })
  })

  it('designer: fewer than two options fails naming options.json', async () => {
    await writeFile(p.designOptions, JSON.stringify({ options: [{ id: 'a', title: 'A', description: 'a', file: 'a.html' }] }))
    await expectError(validateOutputs('designer', dir), 'options.json', 'options')
  })

  it('verifier/reviewer: returns the verdict from verdictFile; missing or invalid fails', async () => {
    const vf = join(p.verdictsDir, 't1-a1-verify.json')
    await expectError(validateOutputs('verifier', dir, vf), 't1-a1-verify.json')
    await expectError(validateOutputs('reviewer', dir), 'verdict file')
    await writeFile(vf, JSON.stringify({ pass: 'yes', issues: [] }))
    await expectError(validateOutputs('verifier', dir, vf), 't1-a1-verify.json', 'pass')
    await writeFile(vf, JSON.stringify({ pass: false, issues: ['broken'] }))
    expect(await validateOutputs('reviewer', dir, vf)).toEqual({ ok: true, verdict: { pass: false, issues: ['broken'] } })
  })

  it('finalizer: needs README.md and REPORT.md', async () => {
    await writeFile(p.readme, '# R\n')
    await expectError(validateOutputs('finalizer', dir), 'REPORT.md')
    await writeFile(p.report, '# Report\n')
    expect(await validateOutputs('finalizer', dir)).toEqual({ ok: true })
  })

  it('implementer: always ok', async () => {
    expect(await validateOutputs('implementer', dir)).toEqual({ ok: true })
  })
})
