// The commit of a trusted calculation's file, shared by the app (main process) and the MCP server, so both call a
// citation stale by the same rule. Needs node (git, the file system): never import it from the renderer.
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { TRUSTED } from '../core/calculations.ts'

const COMMIT_KEPT_MS = 20_000

// The commit of a trusted calculation's file, kept briefly: git runs once per calculation, not once per citation.
const commits = new Map<string, { at: number; commit: Promise<string | undefined> }>()

const git = (folder: string, args: string[]) =>
  new Promise<string | undefined>(resolve => {
    execFile('git', ['-C', folder, ...args], { timeout: 20_000 }, (err, stdout) => resolve(err ? undefined : stdout.trim()))
  })

/**
 * The commit (12 hex digits, as a trusted run's header records it) that last changed trusted calculation `name`'s
 * file in `<root>/trusted`. Undefined when the file is not there, git fails or the name is a definition; the
 * citation is then not called stale.
 */
export function currentCommit(root: string, name: string): Promise<string | undefined> {
  const key = `${root}\0${name}`
  const kept = commits.get(key)
  if (kept && Date.now() - kept.at < COMMIT_KEPT_MS) return kept.commit
  const commit = (async () => {
    const folder = join(root, TRUSTED)
    const file = (await readdir(folder).catch(() => [])).find(each => each === `${name}.sql` || each === `${name}.py`)
    if (!file) return undefined
    const sha = await git(folder, ['log', '-1', '--format=%H', '--', file])
    return sha ? sha.slice(0, 12) : undefined
  })()
  commits.set(key, { at: Date.now(), commit })
  return commit
}
