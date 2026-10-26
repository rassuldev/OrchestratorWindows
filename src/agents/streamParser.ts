import type { LogEntry } from '../core/schemas.js'

export type ResultEvent = {
  subtype: string
  is_error: boolean
  result?: string
  session_id?: string
  total_cost_usd?: number
  api_error_status?: number | null
  terminal_reason?: string
}

type Json = Record<string, unknown>

const TOOL_RESULT_MAX = 300
const TOOL_INPUT_MAX = 200

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

function summarizeToolInput(name: string, input: unknown): string {
  let summary: string | undefined
  if (isObject(input)) {
    if (name === 'Bash' && typeof input.command === 'string') summary = input.command
    else if ((name === 'Edit' || name === 'Write' || name === 'Read') && typeof input.file_path === 'string') summary = input.file_path
  }
  return summary ?? JSON.stringify(input) ?? ''
}

// tool_result.content is either a string or an array of {type:'text',text} blocks.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObject(b) && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function toResultEvent(ev: Json): ResultEvent | null {
  const subtype = str(ev.subtype)
  if (subtype === undefined) return null
  const out: ResultEvent = { subtype, is_error: ev.is_error === true }
  const result = str(ev.result)
  if (result !== undefined) out.result = result
  const sessionId = str(ev.session_id)
  if (sessionId !== undefined) out.session_id = sessionId
  const cost = num(ev.total_cost_usd)
  if (cost !== undefined) out.total_cost_usd = cost
  if (ev.api_error_status === null || typeof ev.api_error_status === 'number') out.api_error_status = ev.api_error_status
  const reason = str(ev.terminal_reason)
  if (reason !== undefined) out.terminal_reason = reason
  return out
}

/** Turns `claude -p --output-format stream-json` stdout chunks into log entries and captures the final result event. */
export class StreamParser {
  result: ResultEvent | null = null
  private buffer = ''

  /**
   * `mask` (e.g. secret masking) runs on the full text before any truncation, so a secret that
   * straddles the cut cannot leak a prefix.
   */
  constructor(private readonly mask: (text: string) => string = (text) => text) {}

  push(chunk: string): LogEntry[] {
    const lastNl = chunk.lastIndexOf('\n')
    if (lastNl === -1) {
      this.buffer += chunk
      return []
    }
    const complete = this.buffer + chunk.slice(0, lastNl)
    this.buffer = chunk.slice(lastNl + 1)
    const out: LogEntry[] = []
    for (const line of complete.split('\n')) out.push(...this.parseLine(line))
    return out
  }

  end(): LogEntry[] {
    const line = this.buffer
    this.buffer = ''
    return this.parseLine(line)
  }

  private parseLine(line: string): LogEntry[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let ev: unknown
    try {
      ev = JSON.parse(trimmed)
    } catch {
      return []
    }
    if (!isObject(ev)) return []
    const t = Date.now()
    const entry = (kind: LogEntry['kind'], text: string, max = Infinity): LogEntry => ({
      t,
      kind,
      text: this.mask(text).slice(0, max),
    })

    switch (ev.type) {
      case 'assistant': {
        const content = isObject(ev.message) ? ev.message.content : undefined
        if (!Array.isArray(content)) return []
        const out: LogEntry[] = []
        for (const block of content) {
          if (!isObject(block)) continue
          if (block.type === 'text' && typeof block.text === 'string') out.push(entry('text', block.text))
          else if (block.type === 'tool_use' && typeof block.name === 'string')
            out.push(entry('tool', `${block.name} ${this.mask(summarizeToolInput(block.name, block.input)).slice(0, TOOL_INPUT_MAX)}`))
        }
        return out
      }
      case 'user': {
        const content = isObject(ev.message) ? ev.message.content : undefined
        if (!Array.isArray(content)) return []
        const out: LogEntry[] = []
        for (const block of content) {
          if (isObject(block) && block.type === 'tool_result')
            out.push(entry('tool_result', toolResultText(block.content), TOOL_RESULT_MAX))
        }
        return out
      }
      case 'system': {
        if (ev.subtype === 'init') return [entry('system', `session started (model ${str(ev.model) ?? 'unknown'})`)]
        if (ev.subtype === 'api_retry') {
          const err = typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error) ?? 'unknown'
          return [entry('system', `API retry: ${err}`)]
        }
        return []
      }
      case 'result': {
        const result = toResultEvent(ev)
        if (!result) return []
        this.result = result
        return [entry('result', result.result ?? result.subtype)]
      }
      default:
        return []
    }
  }
}
