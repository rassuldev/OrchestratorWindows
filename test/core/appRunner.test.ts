import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appRunner, stopAll } from '../../src/core/appRunner.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'orch-app-'))
})

afterEach(async () => {
  await stopAll()
  await rm(tmp, { recursive: true, force: true })
})

const keepAlive = 'setInterval(()=>{},1000)'
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await sleep(20)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('appRunner', () => {
  it('detects the URL printed by the command', async () => {
    const r = await appRunner.start(tmp, `node -e "console.log('Listening on http://localhost:5179'); ${keepAlive}"`)
    expect(r.url).toBe('http://localhost:5179')
    expect(appRunner.status(tmp)).toEqual({ running: true, url: 'http://localhost:5179' })
    appRunner.stop(tmp)
    expect(appRunner.status(tmp)).toEqual({ running: false, url: null })
  })

  it('strips ANSI codes and reads stderr too', async () => {
    const script = `process.stderr.write('  Local:   http://localhost:\\u001b[1m5173\\u001b[22m/\\n'); ${keepAlive}`
    const r = await appRunner.start(tmp, `node -e "${script}"`)
    expect(r.url).toBe('http://localhost:5173/')
  })

  it('matches 127.0.0.1 and ignores non-local URLs', async () => {
    const script = `console.log('docs at https://example.com/x'); console.log('on http://127.0.0.1:3000/app.'); ${keepAlive}`
    const r = await appRunner.start(tmp, `node -e "${script}"`)
    expect(r.url).toBe('http://127.0.0.1:3000/app')
  })

  it('a second start returns the same running app', async () => {
    const cmd = `node -e "console.log('http://localhost:5001'); ${keepAlive}"`
    const a = await appRunner.start(tmp, cmd)
    const b = await appRunner.start(tmp, cmd)
    expect(b).toEqual(a)
  })

  it('stop kills the whole process tree, including children', async () => {
    const pidFile = join(tmp, 'child.pid').replaceAll('\\', '/')
    const script =
      `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
      `require('fs').writeFileSync('${pidFile}',String(c.pid));console.log('http://localhost:5002');${keepAlive}`
    await appRunner.start(tmp, `node -e "${script}"`)
    const childPid = Number(await readFile(pidFile, 'utf8'))
    expect(alive(childPid)).toBe(true)
    await appRunner.stop(tmp)
    await until(() => !alive(childPid))
  })

  it('reports not running after the process exits on its own', async () => {
    const r = await appRunner.start(tmp, `node -e "console.log('no url here')"`)
    expect(r.url).toBeNull()
    await until(() => !appRunner.status(tmp).running)
  })

  it('stop on an unknown dir is a no-op, and stopAll stops everything', async () => {
    await appRunner.stop(join(tmp, 'nothing'))
    await appRunner.start(tmp, `node -e "console.log('http://localhost:5003'); ${keepAlive}"`)
    await stopAll()
    expect(appRunner.status(tmp).running).toBe(false)
  })
})
