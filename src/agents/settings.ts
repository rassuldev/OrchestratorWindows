import { z } from 'zod'

/**
 * Commands no agent may run. Claude Code runs Bash commands in Git Bash on Windows, so the POSIX
 * forms come first; cmd/PowerShell spellings cover commands an agent wraps in `cmd /c` or `powershell`.
 */
export const DENY = [
  'Bash(rm -rf *)',
  'Bash(sudo *)',
  'Bash(git push *)',
  'Bash(docker *)',
  'Bash(winget *)',
  'Bash(choco *)',
  'Bash(scoop *)',
  'Bash(npm install -g *)',
  'Bash(npm i -g *)',
  'Bash(rd /s *)',
  'Bash(rmdir /s *)',
  'Bash(del /s *)',
  'Bash(format *)',
  'Bash(reg *)',
  'Bash(shutdown *)',
  'Bash(Remove-Item *)',
  'Bash(powershell *Remove-Item*)',
  'Bash(cmd /c rd *)',
  'Read(~/.ssh/**)',
  'Edit(~/.ssh/**)',
]

/**
 * Claude Code `--settings` JSON for every agent run. The CLI's OS sandbox does not exist on native
 * Windows, so it is off explicitly and agents are held by permission rules only: any shell command
 * except the deny list, file edits only inside the project (`acceptEdits` auto-approves nothing outside
 * the working directory, and in `-p` mode an unapproved action is refused), web access open.
 */
export function buildAgentSettings(_orchestratorRoot: string): object {
  return {
    sandbox: { enabled: false },
    permissions: {
      defaultMode: 'acceptEdits',
      allow: ['Bash', 'WebFetch', 'WebSearch'],
      deny: DENY,
    },
  }
}

/** The part of the settings shape (as documented for the Claude Code CLI) that the orchestrator relies on. */
const ReliedOnSettings = z.object({
  permissions: z.object({
    defaultMode: z.literal('acceptEdits'),
    allow: z
      .array(z.string())
      .refine((allow) => !allow.some((a) => /^(Edit|Write)$/.test(a)), 'must not allow file edits everywhere'),
    deny: z.array(z.string()).refine((deny) => DENY.every((d) => deny.includes(d)), {
      message: `must contain ${DENY.join(', ')}`,
    }),
  }),
})

/**
 * Checks agent settings against the shape we rely on. `claude -p` silently ignores invalid
 * `--settings` (the agent would then run without the deny list), so the server warns at startup.
 * Returns one human-readable problem per violation; [] when fine.
 */
export function validateAgentSettings(settings: unknown): string[] {
  const r = ReliedOnSettings.safeParse(settings)
  if (r.success) return []
  return r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
}
