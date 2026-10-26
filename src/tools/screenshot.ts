import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser, type BrowserContextOptions } from 'playwright'
import { isMainModule } from './isMain.js'

const NAV_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 15_000

const SHOTS: { file: string; options: BrowserContextOptions }[] = [
  { file: 'desktop.png', options: { viewport: { width: 1440, height: 900 } } },
  {
    file: 'mobile.png',
    options: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  },
]

/**
 * Screenshots `url` (http(s):// or file://) into `outDir` as desktop.png (1440x900 viewport, full page)
 * and mobile.png (390x844 @2x, mobile emulation, full page). Returns the absolute file paths.
 * Rejects if the page cannot be navigated to.
 */
export async function screenshot(url: string, outDir: string): Promise<string[]> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL scheme ${parsed.protocol} (only http, https and file are allowed)`)
  }

  const dir = resolve(outDir)
  await mkdir(dir, { recursive: true })

  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: true })
    const files: string[] = []
    for (const { file, options } of SHOTS) {
      const context = await browser.newContext(options)
      try {
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
        // Pages with long-polling or websockets never go idle: shoot anyway after the timeout.
        await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {})
        const path = resolve(dir, file)
        await page.screenshot({ path, fullPage: true })
        files.push(path)
      } finally {
        await context.close()
      }
    }
    return files
  } finally {
    await browser?.close()
  }
}

async function main(): Promise<void> {
  const [url, outDir] = process.argv.slice(2)
  if (!url || !outDir) {
    process.stderr.write('usage: orch-shot <url> <outDir>\n')
    process.exit(2)
  }
  try {
    for (const file of await screenshot(url, outDir)) process.stdout.write(`${file}\n`)
  } catch (err) {
    // Keep only the first line: Playwright appends a multi-line call log.
    const msg = (err instanceof Error ? err.message : String(err)).split('\n')[0]
    process.stderr.write(`orch-shot: failed to screenshot ${url}: ${msg}\n`)
    process.exit(1)
  }
}

if (isMainModule(import.meta.url)) void main()
