import { execFile, spawn, type ChildProcess } from 'node:child_process'

/** PowerShell's own AppUserModelID: toasts need a registered app id, and this one always exists. */
const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Title and message come in through env vars, so nothing has to be quoted into the script. */
export const TOAST_SCRIPT = [
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  '$text = $xml.GetElementsByTagName("text")',
  '[void]$text.Item(0).AppendChild($xml.CreateTextNode($env:ORCH_TOAST_TITLE))',
  '[void]$text.Item(1).AppendChild($xml.CreateTextNode($env:ORCH_TOAST_MESSAGE))',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show($toast)`,
].join('; ')

const powershellArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]

/**
 * Shows a Windows toast notification. Never throws: it runs inside the project runner, where an
 * exception would corrupt step accounting. Disabled by env `ORCH_NO_NOTIFY=1` (tests).
 */
export function notify(title: string, message: string): void {
  if (process.env.ORCH_NO_NOTIFY === '1') return
  try {
    execFile(
      'powershell.exe',
      powershellArgs(TOAST_SCRIPT),
      { windowsHide: true, env: { ...process.env, ORCH_TOAST_TITLE: title, ORCH_TOAST_MESSAGE: message } },
      () => {
        // errors (no PowerShell, notifications turned off) are ignored
      },
    )
  } catch {
    // a synchronous spawn failure is ignored too
  }
}

/**
 * Holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED for as long as this PowerShell process lives (the state
 * belongs to its thread), and exits on its own when the orchestrator process `pid` is gone.
 */
export function keepAwakeScript(pid: number): string {
  return [
    `Add-Type -Name Power -Namespace Orch -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
    '[void][Orch.Power]::SetThreadExecutionState([uint32]"0x80000001")',
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
  ].join('; ')
}

let holders = 0
let awake: ChildProcess | null = null

const keepAwakeDisabled = () => process.platform !== 'win32' || process.env.ORCH_NO_KEEP_AWAKE === '1'

/**
 * Refcounted sleep prevention: the first `acquire` starts a PowerShell process that keeps the PC
 * awake, the last `release` kills it. No-op off Windows or with env `ORCH_NO_KEEP_AWAKE=1`.
 */
export const keepAwake = {
  acquire(): void {
    holders++
    if (holders !== 1 || keepAwakeDisabled()) return
    try {
      const child = spawn('powershell.exe', powershellArgs(keepAwakeScript(process.pid)), { stdio: 'ignore', windowsHide: true })
      child.on('error', () => {
        if (awake === child) awake = null
      })
      awake = child
    } catch {
      awake = null
    }
  },

  release(): void {
    if (holders === 0) return
    holders--
    if (holders === 0 && awake) {
      awake.kill()
      awake = null
    }
  },
}
