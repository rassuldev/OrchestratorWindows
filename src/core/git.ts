import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MAX_DIFF_BYTES = 200 * 1024

/** Runs `git <args>` in `dir` and returns stdout. Commits work without a global git identity. */
export async function execGit(dir: string, ...args: string[]): Promise<string> {
  const author = process.env.GIT_AUTHOR_NAME ?? 'Orchestrator'
  const email = process.env.GIT_AUTHOR_EMAIL ?? 'orchestrator@localhost'
  const { stdout } = await execFileAsync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? email,
    },
  })
  return stdout
}

export async function headCommit(dir: string): Promise<string> {
  return (await execGit(dir, 'rev-parse', 'HEAD')).trim()
}

/** Stages everything and commits. Returns false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await execGit(dir, 'add', '-A')
  if ((await execGit(dir, 'status', '--porcelain')).trim() === '') return false
  await execGit(dir, 'commit', '-m', message)
  return true
}

/**
 * Throws away uncommitted changes to tracked and untracked files (ignored files such as `.env` and
 * `.orchestrator/` are never touched) and returns the changed paths as `git status` lists them.
 */
export async function revertUncommitted(dir: string): Promise<string[]> {
  const status = await execGit(dir, 'status', '--porcelain')
  const paths = status
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.slice(3))
  if (paths.length === 0) return []
  await execGit(dir, 'stash', 'push', '--include-untracked', '-m', 'orchestrator: revert changes made by a checking step')
  await execGit(dir, 'stash', 'drop')
  return paths
}

/** `git diff base..HEAD`, truncated to 200 KB. */
export async function diffSince(dir: string, base: string): Promise<string> {
  const diff = await execGit(dir, 'diff', `${base}..HEAD`)
  if (Buffer.byteLength(diff) <= MAX_DIFF_BYTES) return diff
  return Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString('utf8')
}
