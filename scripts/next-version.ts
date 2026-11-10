// The version CI releases (docs/process/ci-release.md): the latest `v*` tag bumped by patch, or by the largest
// `Release: minor|major` trailer among the commits since that tag. No tag yet means package.json's first version.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const FIRST_VERSION = '0.1.0'

type Bump = 'patch' | 'minor' | 'major'

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 }

/** The commit's `Release:` trailer: a whole line of its body, never the subject. */
function bumpOf(message: string): Bump {
  const body = message.split('\n').slice(1).join('\n')
  const trailer = /^Release:[ \t]*(minor|major)[ \t]*$/im.exec(body)?.[1]?.toLowerCase()
  return trailer === 'minor' || trailer === 'major' ? trailer : 'patch'
}

function largestBump(messages: string[]): Bump {
  return messages.map(bumpOf).reduce<Bump>((a, b) => (RANK[b] > RANK[a] ? b : a), 'patch')
}

export function nextVersion(lastTag: string | null, messages: string[]): string {
  if (lastTag === null) return FIRST_VERSION
  const [major = 0, minor = 0, patch = 0] = lastTag.replace(/^v/, '').split('.').map(Number)
  switch (largestBump(messages)) {
    case 'major':
      return `${String(major + 1)}.0.0`
    case 'minor':
      return `${String(major)}.${String(minor + 1)}.0`
    case 'patch':
      return `${String(major)}.${String(minor)}.${String(patch + 1)}`
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function latestReleaseTag(cwd: string): string | null {
  try {
    return git(cwd, 'describe', '--tags', '--abbrev=0', '--match', 'v*').trim()
  } catch {
    return null
  }
}

function sinceLastRelease(tag: string | null): string {
  return tag === null ? 'HEAD' : `${tag}..HEAD`
}

/** The next version for the repo at `cwd`: its latest `v*` tag and the commit messages since. */
export function versionFromGit(cwd: string): string {
  const tag = latestReleaseTag(cwd)
  const log = git(cwd, 'log', '--format=%B%x00', sinceLastRelease(tag))
  return nextVersion(tag, log.split('\0').map((m) => m.trim()).filter(Boolean))
}

/** The release notes: one line per commit subject since the last `v*` tag, newest first. */
export function notesFromGit(cwd: string): string {
  return git(cwd, 'log', '--format=- %s', sinceLastRelease(latestReleaseTag(cwd)))
}

// `node scripts/next-version.ts` prints the version; `--notes` prints the release notes.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cwd = process.cwd()
  process.stdout.write(process.argv.includes('--notes') ? notesFromGit(cwd) : `${versionFromGit(cwd)}\n`)
}
