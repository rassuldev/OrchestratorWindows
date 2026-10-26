import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maskSecrets, readSecretValues, writeEnv } from '../../src/core/secrets.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orch-secrets-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('writeEnv quotes values with spaces; file mode 0600', async () => {
  await writeEnv(dir, { API_KEY: 'abc123', PHRASE: 'two words', QUOTED: 'say "hi" \\ back' })
  const env = await readFile(join(dir, '.env'), 'utf8')
  expect(env).toBe('API_KEY=abc123\nPHRASE="two words"\nQUOTED="say \\"hi\\" \\\\ back"\n')
  expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600)
})

it('writeEnv overwrites an existing .env with exactly the given keys and keeps mode 0600', async () => {
  await writeFile(join(dir, '.env'), 'OLD=value\n', { mode: 0o644 })
  await writeEnv(dir, { NEW: 'fresh-value' })
  expect(await readFile(join(dir, '.env'), 'utf8')).toBe('NEW=fresh-value\n')
  expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600)
})

it('writeEnv rejects keys that are not ENV_STYLE and writes nothing', async () => {
  for (const key of ['lower', '1ABC', 'A-B', 'A=B', 'OK\nEVIL', '']) {
    await expect(writeEnv(dir, { GOOD: 'value-1', [key]: 'value-2' })).rejects.toThrow(/invalid secret name/)
  }
  await expect(stat(join(dir, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('readSecretValues round-trips quoted values and returns [] without a .env', async () => {
  expect(await readSecretValues(dir)).toEqual([])
  const secrets = { A: 'plain-value', B: 'two words', C: 'say "hi" \\ back', D: 'line1\nline2' }
  await writeEnv(dir, secrets)
  expect(await readSecretValues(dir)).toEqual(Object.values(secrets))
})

it('readSecretValues skips comments and blank lines', async () => {
  await writeFile(join(dir, '.env'), '# comment\n\nKEY=value-1\nOTHER=\'single quoted\'\n')
  expect(await readSecretValues(dir)).toEqual(['value-1', 'single quoted'])
})

it('maskSecrets replaces every occurrence, ignores short values', () =>
  expect(maskSecrets('token=abcd1234 and abcd1234', ['abcd1234', 'ab'])).toBe('token=*** and ***'))

it('maskSecrets masks the longer of overlapping values first', () =>
  expect(maskSecrets('key=secret-long', ['secret', 'secret-long'])).toBe('key=***'))
