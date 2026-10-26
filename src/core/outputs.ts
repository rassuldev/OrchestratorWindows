import { access, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { z } from 'zod'
import { projectPaths } from './paths.js'
import { DesignOptionsSchema, PlanSchema, QuestionsSchema, VerdictSchema, type Role, type Verdict } from './schemas.js'

export type OutputCheck = { ok: true; verdict?: Verdict } | { ok: false; error: string }

/** Thrown internally; its message is the user-facing error. */
class OutputError extends Error {}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'

async function readText(file: string, label: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (e) {
    if (isMissing(e)) throw new OutputError(`${label} was not written`)
    throw e
  }
}

async function requireNonEmpty(file: string, label: string): Promise<void> {
  if ((await readText(file, label)).trim() === '') throw new OutputError(`${label} is empty`)
}

async function requireExists(file: string, label: string): Promise<void> {
  try {
    await access(file)
  } catch {
    throw new OutputError(`${label} was not written`)
  }
}

async function parseJsonFile<T>(file: string, label: string, schema: z.ZodType<T>): Promise<T> {
  let data: unknown
  try {
    data = JSON.parse(await readText(file, label))
  } catch (e) {
    if (e instanceof OutputError) throw e
    throw new OutputError(`${label} is not valid JSON: ${(e as Error).message}`)
  }
  const r = schema.safeParse(data)
  if (r.success) return r.data
  const issues = r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
  throw new OutputError(`${label} is invalid: ${issues.join('; ')}`)
}

/** Checks that a step wrote what its role must produce. Error strings name the file and the problem. */
export async function validateOutputs(role: Role, dir: string, verdictFile?: string): Promise<OutputCheck> {
  const p = projectPaths(dir)
  const label = (file: string) => relative(dir, file)
  try {
    switch (role) {
      case 'analyst_questions':
        await parseJsonFile(p.questions, label(p.questions), QuestionsSchema)
        break
      case 'analyst_spec':
        await requireNonEmpty(p.spec, label(p.spec))
        break
      case 'architect':
        await requireNonEmpty(p.architecture, label(p.architecture))
        await parseJsonFile(p.plan, label(p.plan), PlanSchema)
        break
      case 'designer': {
        const { options } = await parseJsonFile(p.designOptions, label(p.designOptions), DesignOptionsSchema)
        for (const o of options) {
          const file = join(p.designDir, o.file)
          await requireExists(file, `${label(file)} (design option "${o.id}")`)
        }
        break
      }
      case 'verifier':
      case 'reviewer': {
        if (!verdictFile) throw new OutputError(`${role} has no verdict file to check`)
        return { ok: true, verdict: await parseJsonFile(verdictFile, label(verdictFile), VerdictSchema) }
      }
      case 'finalizer':
        await requireExists(p.readme, label(p.readme))
        await requireExists(p.report, label(p.report))
        break
      case 'implementer':
        break
    }
    return { ok: true }
  } catch (e) {
    if (e instanceof OutputError) return { ok: false, error: e.message }
    throw e
  }
}
