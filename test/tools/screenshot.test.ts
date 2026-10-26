import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { screenshot } from '../../src/tools/screenshot.js'

const run = promisify(execFile)
const orchShot = fileURLToPath(new URL('../../bin/orch-shot', import.meta.url))

let dir: string
let fixtureHtml: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orch-shot-'))
  fixtureHtml = join(dir, 'page.html')
  await writeFile(
    fixtureHtml,
    '<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif"><h1>Hello</h1><p>Orchestrator screenshot fixture</p><div style="height:2000px;background:linear-gradient(red,blue)"></div></body>',
  )
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('screenshot', () => {
  it('screenshots a local HTML file at two sizes (creating nested outDir)', async () => {
    const out = join(dir, 'a', 'b', 'shots')
    const files = await screenshot(pathToFileURL(fixtureHtml).href, out)
    expect(files.map((f) => basename(f))).toEqual(['desktop.png', 'mobile.png'])
    expect(files.every((f) => f.startsWith('/'))).toBe(true)
    expect((await stat(files[0])).size).toBeGreaterThan(1000)
    expect((await stat(files[1])).size).toBeGreaterThan(1000)
  }, 60_000)

  it('rejects when navigation fails', async () => {
    await expect(screenshot('http://127.0.0.1:59999/', join(dir, 'fail'))).rejects.toThrow(/ERR_CONNECTION_REFUSED/)
  }, 60_000)

  it('rejects unsupported URL schemes', async () => {
    await expect(screenshot('ftp://example.com/', join(dir, 'bad'))).rejects.toThrow(/http|file/i)
  })

  it('bin/orch-shot works from an unrelated cwd: prints 2 paths, exits 1 on a refused port', async () => {
    const ok = await run(orchShot, [pathToFileURL(fixtureHtml).href, join(dir, 'cli')], { cwd: tmpdir() })
    const lines = ok.stdout.trim().split('\n')
    expect(lines.map((l) => basename(l))).toEqual(['desktop.png', 'mobile.png'])
    expect((await stat(lines[0])).size).toBeGreaterThan(1000)

    const fail = await run(orchShot, ['http://127.0.0.1:59999/', join(dir, 'cli-fail')], { cwd: tmpdir() }).then(
      () => null,
      (e: { code: number; stderr: string }) => e,
    )
    expect(fail?.code).toBe(1)
    expect(fail?.stderr).toMatch(/ERR_CONNECTION_REFUSED/)
    expect(fail?.stderr.trim().split('\n')).toHaveLength(1)
  }, 90_000)
})
