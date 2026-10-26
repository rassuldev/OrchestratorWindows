import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cp = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}))
vi.mock('node:child_process', () => cp)

const { TOAST_SCRIPT, keepAwake, keepAwakeScript, notify } = await import('../../src/core/notify.js')

beforeEach(() => {
  cp.execFile.mockReset()
  cp.spawn.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function asWindows<T>(fn: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

describe('notify', () => {
  beforeEach(() => vi.stubEnv('ORCH_NO_NOTIFY', ''))

  it('shows a toast through PowerShell, passing the text in env vars rather than the script', () => {
    notify('Orch "1"', "demo: нужно ваше решение; $(rm) 'x'")
    expect(cp.execFile).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = cp.execFile.mock.calls[0]
    expect(bin).toBe('powershell.exe')
    expect(args.at(-1)).toBe(TOAST_SCRIPT)
    expect(TOAST_SCRIPT).not.toContain('нужно')
    expect(opts.env.ORCH_TOAST_TITLE).toBe('Orch "1"')
    expect(opts.env.ORCH_TOAST_MESSAGE).toBe("demo: нужно ваше решение; $(rm) 'x'")
    expect(opts.windowsHide).toBe(true)
  })

  it('swallows a synchronous execFile error', () => {
    cp.execFile.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    expect(() => notify('t', 'm')).not.toThrow()
  })

  it('swallows an asynchronous PowerShell error', () => {
    cp.execFile.mockImplementation((_bin: string, _args: string[], _opts: object, cb: (e: Error | null) => void) => {
      cb(new Error('powershell exited 1'))
      return { on: () => {} }
    })
    expect(() => notify('t', 'm')).not.toThrow()
  })

  it('does nothing when ORCH_NO_NOTIFY=1', () => {
    vi.stubEnv('ORCH_NO_NOTIFY', '1')
    notify('t', 'm')
    expect(cp.execFile).not.toHaveBeenCalled()
  })
})

describe('keepAwake', () => {
  const kill = vi.fn()
  beforeEach(() => {
    vi.stubEnv('ORCH_NO_KEEP_AWAKE', '')
    kill.mockReset()
    cp.spawn.mockImplementation(() => ({ kill, on: () => {}, unref: () => {} }))
  })

  it('the script holds the execution state and waits for this process', () => {
    const script = keepAwakeScript(4242)
    expect(script).toContain('SetThreadExecutionState')
    expect(script).toContain('0x80000001') // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    expect(script).toContain('Wait-Process -Id 4242')
  })

  it('first acquire starts PowerShell, last release kills it', () =>
    asWindows(() => {
      keepAwake.acquire()
      keepAwake.acquire()
      expect(cp.spawn).toHaveBeenCalledTimes(1)
      const [bin, args] = cp.spawn.mock.calls[0]
      expect(bin).toBe('powershell.exe')
      expect(args.at(-1)).toBe(keepAwakeScript(process.pid))

      keepAwake.release()
      expect(kill).not.toHaveBeenCalled()
      keepAwake.release()
      expect(kill).toHaveBeenCalledTimes(1)

      keepAwake.release() // extra release is harmless
      keepAwake.acquire()
      expect(cp.spawn).toHaveBeenCalledTimes(2)
      keepAwake.release()
      expect(kill).toHaveBeenCalledTimes(2)
    }))

  it('is a no-op when ORCH_NO_KEEP_AWAKE=1', () =>
    asWindows(() => {
      vi.stubEnv('ORCH_NO_KEEP_AWAKE', '1')
      keepAwake.acquire()
      keepAwake.release()
      expect(cp.spawn).not.toHaveBeenCalled()
    }))

  it('is a no-op off Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      keepAwake.acquire()
      keepAwake.release()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    expect(cp.spawn).not.toHaveBeenCalled()
  })

  it('survives a spawn that throws', () =>
    asWindows(() => {
      cp.spawn.mockImplementation(() => {
        throw new Error('no powershell')
      })
      expect(() => keepAwake.acquire()).not.toThrow()
      expect(() => keepAwake.release()).not.toThrow()
    }))
})
