import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** True when the module at `metaUrl` (pass `import.meta.url`) is the process entry point, symlink-safe. */
export function isMainModule(metaUrl: string): boolean {
  if (!process.argv[1]) return false
  try {
    return metaUrl === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}
