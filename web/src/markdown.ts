// A deliberately small Markdown renderer for the documents agents write (spec, architecture,
// decisions, followups, report): headings, paragraphs, lists (nested), fenced code, quotes, rules, tables,
// bold, italic, inline code and links. Everything is HTML-escaped; only safe link targets survive.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

function safeHref(url: string): string | null {
  // URL parsers strip C0 controls and spaces, so "\u0001javascript:" would still run: refuse them outright.
  if (/[\x00-\x20\x7f]/.test(url)) return null
  if (/^(https?:|mailto:)/i.test(url)) return url
  if (/^[/.#?]/.test(url)) return url
  // a bare relative path: starts with a word character and has no ':' before the first '/'
  if (/^\w/.test(url) && !/^[^/]*:/.test(url)) return url
  return null
}

/** Bold and italic on already-escaped text. */
function emphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![_\w])/g, '$1<em>$2</em>')
}

const INLINE = /`([^`]+)`|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g

export function renderInline(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    out += emphasis(escapeHtml(text.slice(last, m.index)))
    if (m[1] !== undefined) {
      out += `<code>${escapeHtml(m[1])}</code>`
    } else {
      const label = renderInline(m[2]!)
      const href = safeHref(m[3]!)
      out += href === null ? label : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    }
    last = m.index + m[0].length
  }
  return out + emphasis(escapeHtml(text.slice(last)))
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

type ListItem = { indent: number; ordered: boolean; text: string }
/** GitHub-style checklist item: `[ ] text` / `[x] text`. */
const TASK_ITEM = /^\[([ xX])\]\s+(.*)$/

function renderList(items: ListItem[]): string {
  const tag = items[0]!.ordered ? 'ol' : 'ul'
  const base = items[0]!.indent
  let html = `<${tag}>`
  for (let i = 0; i < items.length; ) {
    const item = items[i]!
    let j = i + 1
    while (j < items.length && items[j]!.indent > base) j++
    const children = items.slice(i + 1, j)
    const task = TASK_ITEM.exec(item.text)
    const body = task
      ? `<span class="task-box" aria-label="${task[1] === ' ' ? 'не сделано' : 'сделано'}">${task[1] === ' ' ? '☐' : '☑'}</span> ${renderInline(task[2]!)}`
      : renderInline(item.text)
    html += `<li${task ? ` class="task${task[1] === ' ' ? '' : ' done'}"` : ''}>${body}${children.length ? renderList(children) : ''}</li>`
    i = j
  }
  return `${html}</${tag}>`
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    LIST_ITEM.test(line) ||
    /^\s*>/.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next))
  )
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!)
      i++
      blocks.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1]!.length
      blocks.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`)
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push('<hr>')
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      blocks.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) {
      const head = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') rows.push(splitRow(lines[i++]!))
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join('')
      const body = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')
      blocks.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`)
      continue
    }
    const first = LIST_ITEM.exec(line)
    if (first) {
      const ordered = /\d/.test(first[2]!)
      const items: ListItem[] = []
      while (i < lines.length) {
        const current = lines[i]!
        const m = LIST_ITEM.exec(current)
        if (m) {
          const isOrdered = /\d/.test(m[2]!)
          if (m[1]!.length === 0 && isOrdered !== ordered) break
          items.push({ indent: m[1]!.length, ordered: isOrdered, text: m[3]! })
          i++
        } else if (current.trim() !== '' && /^\s{2,}/.test(current) && items.length) {
          items[items.length - 1]!.text += ` ${current.trim()}`
          i++
        } else if (current.trim() === '') {
          const next = lines[i + 1]
          const nm = next === undefined ? null : LIST_ITEM.exec(next)
          if (nm && (nm[1]!.length > 0 || /\d/.test(nm[2]!) === ordered)) i++
          else break
        } else break
      }
      blocks.push(renderList(items))
      continue
    }
    const para: string[] = [line.trim()]
    i++
    while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines[i]!, lines[i + 1])) para.push(lines[i++]!.trim())
    blocks.push(`<p>${renderInline(para.join(' '))}</p>`)
  }
  return blocks.join('\n')
}
