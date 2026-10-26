import { spawn } from 'node:child_process'
import type { Config } from '../config.js'
import { ProcessTree } from '../core/processTree.js'
import type { LogEntry } from '../core/schemas.js'
import { classifyResult, type Classified } from './classify.js'
import { buildAgentSettings } from './settings.js'
import { StreamParser, type ResultEvent } from './streamParser.js'

export type RunResult = {
  classified: Classified
  result: ResultEvent | null
  exitCode: number | null
  durationMs: number
}

export type RunClaudeOpts = {
  cfg: Config
  cwd: string
  systemPrompt: string
  prompt: string
  onEntry: (e: LogEntry) => void
  signal?: AbortSignal
  timeoutMs?: number
  /** Merged over process.env. */
  env?: NodeJS.ProcessEnv
  /** Applied to every log entry's full text before truncation (secret masking). */
  mask?: (text: string) => string
}

const STDERR_TAIL_BYTES = 4096

/**
 * The command and leading args that start the CLI. A `.js`/`.mjs` path (an npm install's `cli.js`,
 * or the test fake) runs under this Node: Windows cannot execute scripts directly, and `.cmd` shims
 * cannot be spawned without a shell, which would mangle the multi-line prompt.
 */
export function claudeCommand(claudeBin: string): [string, string[]] {
  if (/\.(?:c|m)?js$/i.test(claudeBin)) return [process.execPath, [claudeBin]]
  if (/\.(?:cmd|bat)$/i.test(claudeBin)) {
    throw new Error(`claudeBin ${claudeBin}: a .cmd shim cannot be run directly; point claudeBin at claude.exe or at the package's cli.js`)
  }
  return [claudeBin, []]
}

/** Spawns one headless `claude -p` run, streams its log entries, and classifies the outcome. */
export function runClaude(opts: RunClaudeOpts): Promise<RunResult> {
  const { cfg, cwd, systemPrompt, prompt, onEntry, signal, timeoutMs } = opts
  const startedAt = Date.now()
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--append-system-prompt', systemPrompt,
    '--permission-mode', 'acceptEdits',
    '--settings', JSON.stringify(buildAgentSettings(cfg.orchestratorRoot)),
    ...(cfg.model ? ['--model', cfg.model] : []),
  ]

  return new Promise<RunResult>((resolve) => {
    const parser = new StreamParser(opts.mask)
    let stderrTail = ''
    let stopReason: 'timeout' | 'aborted' | null = null
    let spawnError: Error | null = null
    let settled = false
    let timeoutTimer: NodeJS.Timeout | undefined

    let child: ReturnType<typeof spawn>
    try {
      const [command, prefix] = claudeCommand(cfg.claudeBin)
      child = spawn(command, [...prefix, ...args], {
        cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      resolve({ classified: { kind: 'error', message: (e as Error).message }, result: null, exitCode: null, durationMs: 0 })
      return
    }
    // Dev servers and other processes the agent starts are killed with it.
    const tree = new ProcessTree(child.pid)

    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      signal?.removeEventListener('abort', onAbort)
      for (const e of parser.end()) onEntry(e)
      let classified: Classified
      if (stopReason) classified = { kind: 'error', message: stopReason }
      else if (spawnError) classified = { kind: 'error', message: spawnError.message }
      else classified = classifyResult(parser.result, exitCode, stderrTail)
      resolve({ classified, result: parser.result, exitCode, durationMs: Date.now() - startedAt })
    }

    const stop = (reason: 'timeout' | 'aborted') => {
      if (settled || stopReason) return
      stopReason = reason
      void tree.kill()
    }
    const onAbort = () => stop('aborted')

    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      for (const e of parser.push(chunk)) onEntry(e)
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    })
    child.on('error', (err) => {
      spawnError = err
      tree.stopTracking()
      finish(null)
    })
    // Whatever the agent left running (a dev server holding a port) goes with it. The step finishes
    // only after that, so the next step never meets a port still held by this one.
    let cleanup: Promise<void> = Promise.resolve()
    child.on('exit', () => {
      cleanup = tree.kill()
    })
    child.on('close', (code) => void cleanup.finally(() => finish(code)))

    if (timeoutMs !== undefined) timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}
