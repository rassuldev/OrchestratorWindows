import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitAll, diffSince, execGit, headCommit, revertUncommitted } from '../../src/core/git.js'
import { createProject } from '../../src/core/store.js'
import type { Config } from '../../src/config.js'

let workspace: string
let dir: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'orch-git-'))
  const cfg: Config = { orchestratorRoot: '/unused', workspace, port: 4321, claudeBin: 'claude', stepTimeoutMin: 45 }
  dir = (await createProject(cfg, { name: 'App', task: 't' })).dir
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

it('headCommit returns the current full sha', async () => {
  const sha = await headCommit(dir)
  expect(sha).toMatch(/^[0-9a-f]{40}$/)
  expect(sha).toBe((await execGit(dir, 'rev-parse', 'HEAD')).trim())
})

it('commitAll returns false on a clean tree, true after a change; diffSince shows the change', async () => {
  const base = await headCommit(dir)
  expect(await commitAll(dir, 'noop')).toBe(false)
  expect(await headCommit(dir)).toBe(base)

  await writeFile(join(dir, 'a.txt'), 'hello\n')
  expect(await commitAll(dir, 'feat: add a')).toBe(true)
  expect(await headCommit(dir)).not.toBe(base)
  expect((await execGit(dir, 'log', '-1', '--format=%s')).trim()).toBe('feat: add a')

  const diff = await diffSince(dir, base)
  expect(diff).toContain('a.txt')
  expect(diff).toContain('+hello')
  expect(await commitAll(dir, 'again')).toBe(false)
})

it('commitAll does not stage ignored service files', async () => {
  await writeFile(join(dir, '.env'), 'SECRET=1\n')
  expect(await commitAll(dir, 'chore: env')).toBe(false)
})

it('diffSince truncates to 200 KB', async () => {
  const base = await headCommit(dir)
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(500 * 1024))
  await commitAll(dir, 'feat: big')
  const diff = await diffSince(dir, base)
  expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(200 * 1024)
  expect(diff.length).toBeGreaterThan(100 * 1024)
})

it('revertUncommitted drops tracked and untracked changes but never ignored files (.env, .orchestrator)', async () => {
  await writeFile(join(dir, 'app.txt'), 'v1\n')
  await commitAll(dir, 'app')
  expect(await revertUncommitted(dir)).toEqual([])

  await writeFile(join(dir, 'app.txt'), 'changed by verifier\n')
  await mkdir(join(dir, 'new'), { recursive: true })
  await writeFile(join(dir, 'new/file.txt'), 'x')
  await writeFile(join(dir, '.env'), 'API_KEY=keep-me\n')
  await writeFile(join(dir, '.orchestrator/verdicts-note.txt'), 'keep')
  const head = await headCommit(dir)

  expect((await revertUncommitted(dir)).sort()).toEqual(['app.txt', 'new/'])
  expect(await readFile(join(dir, 'app.txt'), 'utf8')).toBe('v1\n')
  expect(existsSync(join(dir, 'new'))).toBe(false)
  expect(await readFile(join(dir, '.env'), 'utf8')).toBe('API_KEY=keep-me\n')
  expect(existsSync(join(dir, '.orchestrator/verdicts-note.txt'))).toBe(true)
  expect(await headCommit(dir)).toBe(head)
  expect((await execGit(dir, 'stash', 'list')).trim()).toBe('')
})
