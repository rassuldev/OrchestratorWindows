import { spawn, type ChildProcess } from 'node:child_process'
import { ProcessTree } from './processTree.js'

export type AppStatus = { running: boolean; url: string | null }

const URL_WAIT_MS = 20_000
const URL_SETTLE_MS = 50
const MAX_BUFFER = 8_192
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\S*/
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/

type Entry = {
  child: ChildProcess
  tree: ProcessTree
  url: string | null
  exited: boolean
  /** Resolves with the first URL printed, or null after 20 s / when the process exits first. */
  ready: Promise<{ url: string | null }>
}

const apps = new Map<string, Entry>()

function findUrl(text: string): string | null {
  const m = LOCAL_URL.exec(text.replace(ANSI, ''))
  return m ? m[0].replace(TRAILING_PUNCTUATION, '') : null
}

function start(dir: string, command: string): Promise<{ url: string | null }> {
  const existing = apps.get(dir)
  if (existing) return existing.ready

  // shell: `cmd.exe /d /s /c <command>` on Windows, so the command uses cmd syntax (`npm start`).
  const child = spawn(command, { cwd: dir, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let resolveReady!: (r: { url: string | null }) => void
  const ready = new Promise<{ url: string | null }>((res) => (resolveReady = res))
  const entry: Entry = { child, tree: new ProcessTree(child.pid), url: null, exited: false, ready }
  apps.set(dir, entry)

  let buffer = ''
  let settle: NodeJS.Timeout | null = null
  const timeout = setTimeout(() => resolveReady({ url: null }), URL_WAIT_MS)
  const settleUrl = () => {
    settle = null
    const url = findUrl(buffer)
    if (url === null) return
    entry.url = url
    clearTimeout(timeout)
    resolveReady({ url })
  }
  const onData = (chunk: Buffer) => {
    if (entry.url !== null) return // later output is not interesting
    buffer = (buffer + chunk.toString('utf8')).slice(-MAX_BUFFER)
    // Wait briefly so a URL split across chunks is read whole.
    if (settle === null && findUrl(buffer) !== null) settle = setTimeout(settleUrl, URL_SETTLE_MS)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  const onGone = () => {
    if (entry.exited) return
    entry.exited = true
    entry.tree.stopTracking()
    clearTimeout(timeout)
    if (settle) clearTimeout(settle)
    if (apps.get(dir) === entry) apps.delete(dir)
    resolveReady({ url: entry.url })
  }
  child.once('exit', onGone)
  child.once('error', onGone) // e.g. the shell or cwd does not exist
  return ready
}

/** Kills the shell and everything it started; resolves once they are killed. */
function stop(dir: string): Promise<void> {
  const entry = apps.get(dir)
  if (!entry) return Promise.resolve()
  apps.delete(dir)
  return entry.tree.kill()
}

function status(dir: string): AppStatus {
  const entry = apps.get(dir)
  return entry && !entry.exited ? { running: true, url: entry.url } : { running: false, url: null }
}

/** Starts and stops each generated project's demo app (`<runCommand>` in a shell, killed with its whole process tree). */
export const appRunner = { start, stop, status }

/** Stops every running app; called when the server shuts down. */
export function stopAll(): Promise<void> {
  return Promise.all([...apps.keys()].map(stop)).then(() => {})
}
