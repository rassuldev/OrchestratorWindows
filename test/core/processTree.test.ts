import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ProcessTree, descendantsOf, parseProcessList, type ProcInfo } from '../../src/core/processTree.js'

const p = (pid: number, ppid: number, startedMs = 0): ProcInfo => ({ pid, ppid, startedMs })

describe('parseProcessList', () => {
  it('reads pid, ppid and a FILETIME creation date; skips junk', () => {
    // 2026-01-01T00:00:00Z as FILETIME
    const ft = (BigInt(Date.UTC(2026, 0, 1)) * 10_000n + 116444736000000000n).toString()
    expect(parseProcessList(`10 4 ${ft}\r\n\r\nwarning\r\n  11   10\n`)).toEqual([
      p(10, 4, Date.UTC(2026, 0, 1)),
      p(11, 10, 0),
    ])
  })
})

describe('descendantsOf', () => {
  it('walks children of children, includes a listed root', () => {
    expect(descendantsOf([p(1, 0), p(2, 1), p(3, 2), p(9, 8)], [p(1, 0)]).sort()).toEqual([1, 2, 3])
  })

  it('finds orphans of a dead root: Windows keeps the dead parent pid', () => {
    expect(descendantsOf([p(3, 2), p(4, 3)], [p(2, 1)]).sort()).toEqual([3, 4])
  })

  it('skips a process older than its supposed parent (a reused pid)', () => {
    expect(descendantsOf([p(3, 2, 1_000), p(4, 3, 100_000)], [p(2, 1, 50_000)])).toEqual([])
  })

  it('never includes this process and survives self-parent loops', () => {
    expect(descendantsOf([p(process.pid, 5), p(7, 7)], [p(5, 0), p(7, 0)])).toEqual([7])
  })
})

describe('ProcessTree', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('kills a running process and the child it started', async () => {
    const parent = spawn(
      process.execPath,
      ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
    const tree = new ProcessTree(parent.pid)
    const childPid = await new Promise<number>((res) => parent.stdout!.once('data', (d) => res(Number(String(d).trim()))))
    try {
      expect(alive(childPid)).toBe(true)
      await tree.kill()
      await vi.waitFor(() => expect(alive(childPid) || alive(parent.pid!)).toBe(false), { timeout: 5000 })
    } finally {
      if (alive(childPid)) process.kill(childPid, 'SIGKILL')
    }
  })

  it('without a pid it does nothing', async () => {
    const tree = new ProcessTree(undefined)
    expect(await tree.snapshot()).toEqual([])
    await expect(tree.kill()).resolves.toBeUndefined()
  })
})
