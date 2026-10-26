import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orch-cfg-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('defaults', () => {
    const c = loadConfig('/x', { HOME: '/h' })
    expect(c).toMatchObject({
      orchestratorRoot: '/x',
      workspace: '/h/orchestrator-projects',
      port: 4321,
      claudeBin: 'claude',
      stepTimeoutMin: 45,
    })
    expect(c.model).toBeUndefined()
  })

  it('reads config.json, expanding ~ in workspace', () => {
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ workspace: '~/work', port: 5000, claudeBin: '/bin/c', model: 'opus', stepTimeoutMin: 10 }),
    )
    expect(loadConfig(root, { HOME: '/h' })).toEqual({
      orchestratorRoot: root,
      workspace: '/h/work',
      port: 5000,
      claudeBin: '/bin/c',
      model: 'opus',
      stepTimeoutMin: 10,
    })
  })

  it('env overrides ORCH_WORKSPACE / ORCH_CLAUDE_BIN beat config.json', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ workspace: '/from-file', claudeBin: 'file-claude' }))
    const c = loadConfig(root, { HOME: '/h', ORCH_WORKSPACE: '~/envws', ORCH_CLAUDE_BIN: 'env-claude' })
    expect(c.workspace).toBe('/h/envws')
    expect(c.claudeBin).toBe('env-claude')
  })

  it('rejects an invalid config.json value', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ port: 'abc' }))
    expect(() => loadConfig(root, { HOME: '/h' })).toThrow()
  })
})
