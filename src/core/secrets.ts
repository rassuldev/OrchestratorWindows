import { chmod, readFile, writeFile } from 'node:fs/promises'
import { projectPaths } from './paths.js'

const MIN_MASK_LENGTH = 4
const NEEDS_QUOTES = /[\s"'#\\=$`]/

function envValue(value: string): string {
  if (value !== '' && !NEEDS_QUOTES.test(value)) return value
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
  return `"${escaped}"`
}

function parseEnvValue(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c))
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  return v
}

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/

/** Throws unless every key is ENV_STYLE, so a key can never inject extra `.env` lines. */
export function assertEnvKeys(secrets: Record<string, string>): void {
  const bad = Object.keys(secrets).filter((k) => !ENV_KEY.test(k))
  if (bad.length > 0) {
    throw new Error(`invalid secret name(s): ${bad.map((k) => JSON.stringify(k)).join(', ')} (expected ${ENV_KEY.source})`)
  }
}

/** Overwrites `<dir>/.env` with exactly these `KEY=value` lines, mode 0600. Keys must be ENV_STYLE. */
export async function writeEnv(dir: string, secrets: Record<string, string>): Promise<void> {
  assertEnvKeys(secrets)
  const file = projectPaths(dir).env
  const body = Object.entries(secrets)
    .map(([k, v]) => `${k}=${envValue(v)}\n`)
    .join('')
  await writeFile(file, body, { mode: 0o600 })
  await chmod(file, 0o600) // `mode` only applies when the file is created
}

/** The values in `<dir>/.env`; [] when there is none. */
export async function readSecretValues(dir: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(projectPaths(dir).env, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const values: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    values.push(parseEnvValue(trimmed.slice(eq + 1)))
  }
  return values
}

/** Replaces every occurrence of each value (4+ chars, longest first) with `***`. */
export function maskSecrets(text: string, values: string[]): string {
  const maskable = values.filter((v) => v.length >= MIN_MASK_LENGTH).sort((a, b) => b.length - a.length)
  return maskable.reduce((out, v) => out.split(v).join('***'), text)
}
