import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export type Config = {
  orchestratorRoot: string
  workspace: string
  port: number
  claudeBin: string
  model?: string
  stepTimeoutMin: number
}

const ConfigFileSchema = z.object({
  workspace: z.string().optional(),
  port: z.number().int().positive().optional(),
  claudeBin: z.string().optional(),
  model: z.string().optional(),
  stepTimeoutMin: z.number().positive().optional(),
})

function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

/**
 * Reads optional `<orchestratorRoot>/config.json`; ORCH_WORKSPACE / ORCH_CLAUDE_BIN env vars override it.
 * Home is USERPROFILE: under Git Bash HOME may be a POSIX path (`/c/Users/me`) that Node cannot use.
 */
export function loadConfig(orchestratorRoot: string, env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  const file = join(orchestratorRoot, 'config.json')
  const fromFile = existsSync(file) ? ConfigFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : {}

  const workspace = env.ORCH_WORKSPACE ?? fromFile.workspace ?? join(home, 'orchestrator-projects')
  const config: Config = {
    orchestratorRoot,
    workspace: expandHome(workspace, home),
    port: fromFile.port ?? 4321,
    claudeBin: env.ORCH_CLAUDE_BIN ?? fromFile.claudeBin ?? 'claude',
    stepTimeoutMin: fromFile.stepTimeoutMin ?? 45,
  }
  if (fromFile.model !== undefined) config.model = fromFile.model
  return config
}
