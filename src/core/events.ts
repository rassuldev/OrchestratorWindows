import { EventEmitter } from 'node:events'
import type { LogEntry, ProjectState } from './schemas.js'

/**
 * Process-wide project events. `'state'` listeners get `(projectId, state)`,
 * `'log'` listeners get `(projectId, stepId, entry)`.
 */
export class EventBus extends EventEmitter {
  emitState(id: string, s: ProjectState): void {
    this.emit('state', id, s)
  }

  emitLog(id: string, stepId: string, e: LogEntry): void {
    this.emit('log', id, stepId, e)
  }
}
