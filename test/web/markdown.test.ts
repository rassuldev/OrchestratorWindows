import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../web/src/markdown.js'

describe('renderMarkdown', () => {
  it('renders headings, paragraphs, bold, italic, inline code and links', () => {
    expect(renderMarkdown('# Title\n\nSome **bold**, *it*, `code` and [a link](https://x.dev).')).toBe(
      '<h1>Title</h1>\n<p>Some <strong>bold</strong>, <em>it</em>, <code>code</code> and ' +
        '<a href="https://x.dev" target="_blank" rel="noopener noreferrer">a link</a>.</p>',
    )
  })

  it('renders unordered and ordered lists, including nested items', () => {
    expect(renderMarkdown('- one\n- two\n  - two.a\n\n1. first\n2. second')).toBe(
      '<ul><li>one</li><li>two<ul><li>two.a</li></ul></li></ul>\n<ol><li>first</li><li>second</li></ol>',
    )
  })

  it('renders fenced code verbatim and escaped, plus quotes, rules and tables', () => {
    expect(renderMarkdown('```ts\nconst a = 1 < 2 && **x**\n```')).toBe(
      '<pre><code>const a = 1 &lt; 2 &amp;&amp; **x**</code></pre>',
    )
    expect(renderMarkdown('> note\n\n---')).toBe('<blockquote><p>note</p></blockquote>\n<hr>')
    expect(renderMarkdown('| A | B |\n|---|:-:|\n| 1 | **2** |')).toBe(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>',
    )
  })

  it('escapes HTML and drops unsafe link targets', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(renderMarkdown('[x](javascript:alert(1))')).toBe('<p>x</p>')
    expect(renderMarkdown('[x](" onmouseover="a)')).not.toContain('onmouseover="')
  })

  it('blocks control-character and scheme bypasses, allows plain relative links', () => {
    const href = (url: string) => /href="([^"]*)"/.exec(renderMarkdown(`[x](${url})`))?.[1] ?? null
    expect(renderMarkdown('[x](\u0001javascript:alert(1))')).toBe('<p>x</p>')
    for (const bad of ['\u0001javascript:alert(1)', 'java\tscript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', 'a:b/c', '\u007fjavascript:x']) {
      expect(href(bad), JSON.stringify(bad)).toBeNull()
    }
    for (const good of ['https://x.dev/a', 'mailto:a@b.c', '/abs', './rel', '../up', '#anchor', '?q=1', 'docs/a.md', 'a/b:c']) {
      expect(href(good), good).toBe(good)
    }
  })
  it('renders checklist items as boxes, done ones marked, without breaking plain items', () => {
    expect(renderMarkdown('- [ ] open <b>\n- [x] fixed\n- plain')).toBe(
      '<ul><li class="task"><span class="task-box" aria-label="не сделано">☐</span> open &lt;b&gt;</li>' +
        '<li class="task done"><span class="task-box" aria-label="сделано">☑</span> fixed</li><li>plain</li></ul>',
    )
  })
})
