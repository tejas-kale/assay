// The release filter (docs/developer/ci-release.md): a push to main that changes only docs, tests and CI config does
// not build a release, because macOS minutes cost ten times Linux ones. `node scripts/release-paths.ts <before> <sha>`
// prints `release=true` or `release=false`, for $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Markdown outside plugin/: the plugin's skills ship inside the app.
const SKIPPED = [/^docs\//, /^(?!plugin\/).*\.md$/, /\.test\.ts$/, /^python\/tests\//, /^tests\//, /^\.github\//]

/** Whether a push changing `paths` ships a release. No paths means the push could not be compared, so it does. */
export function shouldRelease(paths: string[]): boolean {
  return paths.length === 0 || paths.some((path) => !SKIPPED.some((skipped) => skipped.test(path)))
}

/** The files changed between two commits, or none when `before` is unknown here (a new branch, a force push). */
function changedPaths(before: string, sha: string): string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${before}..${sha}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [before = '', sha = 'HEAD'] = process.argv.slice(2)
  console.log(`release=${String(shouldRelease(changedPaths(before, sha)))}`)
}
