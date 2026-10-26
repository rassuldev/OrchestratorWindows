import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ProcInfo = {
  pid: number
  ppid: number
  /** Creation time, ms since epoch; 0 when unknown. */
  startedMs: number
}

/** Windows FILETIME (100 ns ticks since 1601) of the Unix epoch. */
const EPOCH_FILETIME = 116444736000000000n
/** Process creation times and Date.now() are read at different moments: allow this much skew. */
const CLOCK_SLACK_MS = 2_000

const PS_LIST =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }'

/** Parses `pid ppid [filetime]` lines (the PowerShell listing above, or `ps`); other lines are skipped. */
export function parseProcessList(text: string): ProcInfo[] {
  const procs: ProcInfo[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line)
    if (!m) continue
    const startedMs = m[3] ? Number((BigInt(m[3]) - EPOCH_FILETIME) / 10_000n) : 0
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), startedMs })
  }
  return procs
}

/** Every process on the machine. Windows: via CIM; elsewhere `ps`, only so the test suite runs on a dev Mac. */
export async function listProcesses(): Promise<ProcInfo[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return parseProcessList(stdout)
  }
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='])
  return parseProcessList(stdout)
}

/**
 * The pids descending from `roots`, plus the roots that are still listed. Windows keeps a dead
 * parent's pid in its children's ParentProcessId, so a dev server whose agent already exited is
 * still found. A process created before its supposed parent is a pid reuse, not a child: skipped.
 */
export function descendantsOf(procs: ProcInfo[], roots: ProcInfo[]): number[] {
  const children = new Map<number, ProcInfo[]>()
  for (const p of procs) {
    if (p.pid === p.ppid) continue
    const list = children.get(p.ppid) ?? []
    list.push(p)
    children.set(p.ppid, list)
  }
  const found = new Set<number>()
  const queue = [...roots]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const c of children.get(parent.pid) ?? []) {
      if (found.has(c.pid)) continue
      if (parent.startedMs && c.startedMs && c.startedMs + CLOCK_SLACK_MS < parent.startedMs) continue
      found.add(c.pid)
      queue.push(c)
    }
  }
  const listed = new Set(procs.map((p) => p.pid))
  for (const r of roots) if (listed.has(r.pid)) found.add(r.pid)
  found.delete(process.pid)
  return [...found]
}

function killPid(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
    return Promise.resolve()
  }
  // /F: console programs ignore the polite close request. A pid that is already gone fails: fine.
  return execFileAsync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }).then(
    () => {},
    () => {},
  )
}

/**
 * The process tree of one spawned child, so all of it can be killed later (Windows has no process
 * groups to signal), orphans included: e.g. a dev server whose launching shell has already exited.
 * While the child runs the tree is snapshotted every `pollMs`; `kill` kills every remembered or
 * currently descending process.
 */
export class ProcessTree {
  private readonly known = new Map<number, ProcInfo>()
  private readonly root: ProcInfo
  private timer: NodeJS.Timeout | undefined

  /** Call right after spawning `pid`. */
  constructor(pid: number | undefined, pollMs = 15_000) {
    this.root = { pid: pid ?? -1, ppid: 0, startedMs: Date.now() - CLOCK_SLACK_MS }
    if (pid === undefined) return
    this.timer = setInterval(() => void this.snapshot().catch(() => {}), pollMs)
    this.timer.unref()
  }

  /** Remembers and returns every process now descending from the root or a remembered process. */
  async snapshot(): Promise<number[]> {
    if (this.root.pid === -1) return []
    const procs = await listProcesses()
    const byPid = new Map(procs.map((p) => [p.pid, p]))
    // A remembered pid that is gone, or now held by a different process, is forgotten.
    for (const [pid, info] of this.known) {
      const now = byPid.get(pid)
      if (!now || now.startedMs !== info.startedMs) this.known.delete(pid)
    }
    const pids = descendantsOf(procs, [this.root, ...this.known.values()])
    for (const pid of pids) {
      const info = byPid.get(pid)
      if (info && pid !== this.root.pid) this.known.set(pid, info)
    }
    return pids
  }

  /** Stops tracking and kills the whole tree. Never throws. */
  async kill(): Promise<void> {
    this.stopTracking()
    let pids: number[]
    try {
      pids = await this.snapshot()
    } catch (e) {
      console.warn(`cannot list processes: ${(e as Error).message}`)
      pids = [this.root.pid, ...this.known.keys()].filter((p) => p > 0)
    }
    this.known.clear()
    await Promise.all(pids.map(killPid))
  }

  /** Stops the periodic snapshots (the remembered processes stay remembered). */
  stopTracking(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
