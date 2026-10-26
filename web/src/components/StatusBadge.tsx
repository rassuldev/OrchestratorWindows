import type { DisplayStatus } from '../api.js'
import { Icon, type IconName } from '../icons.js'
import { STATUS_LABELS } from '../labels.js'

const ICONS: Record<DisplayStatus, IconName | 'spinner' | null> = {
  waiting: null,
  running: 'spinner',
  queued: 'queue',
  paused: 'pause',
  rate_limited: 'clock',
  error: 'alert',
  done: 'check',
}

export function StatusBadge({ status }: { status: DisplayStatus }) {
  const icon = ICONS[status]
  return (
    <span className={`badge badge-${status}`}>
      {icon ? <Icon name={icon} /> : <span className="pulse" aria-hidden="true" />}
      {STATUS_LABELS[status]}
    </span>
  )
}
