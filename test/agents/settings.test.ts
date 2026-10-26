import { describe, expect, it } from 'vitest'
import { DENY, buildAgentSettings, validateAgentSettings } from '../../src/agents/settings.js'

describe('buildAgentSettings', () => {
  it('turns the sandbox off: it does not exist on native Windows', () => {
    const s = buildAgentSettings('C:/orch') as any
    expect(s.sandbox).toEqual({ enabled: false })
  })

  it('allows shell commands and web access, edits only through acceptEdits', () => {
    const s = buildAgentSettings('C:/orch') as any
    expect(s.permissions.defaultMode).toBe('acceptEdits')
    expect(s.permissions.allow).toEqual(['Bash', 'WebFetch', 'WebSearch'])
  })

  it('denies destructive commands, global installs and ~/.ssh', () => {
    const s = buildAgentSettings('C:/orch') as any
    expect(s.permissions.deny).toEqual(DENY)
    for (const rule of ['Bash(rm -rf *)', 'Bash(git push *)', 'Bash(winget *)', 'Bash(npm install -g *)', 'Bash(rd /s *)', 'Read(~/.ssh/**)']) {
      expect(s.permissions.deny).toContain(rule)
    }
  })
})

describe('validateAgentSettings', () => {
  it('accepts the settings we build', () => {
    expect(validateAgentSettings(buildAgentSettings('C:/orch'))).toEqual([])
  })

  it('names every relied-on setting that is missing or wrong', () => {
    const s = buildAgentSettings('C:/orch') as any
    const broken = {
      ...s,
      permissions: { defaultMode: 'bypassPermissions', allow: ['Bash', 'Edit'], deny: ['Bash(sudo *)'] },
    }
    const problems = validateAgentSettings(broken).join('\n')
    expect(problems).toMatch(/defaultMode/)
    expect(problems).toMatch(/file edits everywhere/)
    expect(problems).toMatch(/Bash\(rm -rf \*\)/)
    expect(validateAgentSettings(null).length).toBeGreaterThan(0)
  })
})
