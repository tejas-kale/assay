// The version CI releases (docs/process/ci-release.md): the latest `v*` tag bumped by patch, or by the largest
// `Release: minor|major` trailer among the commits since that tag. No tag yet means package.json's first version.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const FIRST_VERSION = '0.1.0'

type Bump = 'patch' | 'minor' | 'major'

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 }

const bumpOf = (trailer: string): Bump => {
  const value = trailer.trim().toLowerCase()
  return value === 'minor' || value === 'major' ? value : 'patch'
}

/** The version after `lastTag`, given the values of the `Release:` trailers of the commits since it. */
export function nextVersion(lastTag: string | null, releaseTrailers: string[]): string {
  if (lastTag === null) return FIRST_VERSION
  if (!/^v\d+\.\d+\.\d+$/.test(lastTag)) throw new Error(`The latest release tag ${lastTag} is not vMAJOR.MINOR.PATCH`)
  const [major = 0, minor = 0, patch = 0] = lastTag.slice(1).split('.').map(Number)
  const bump = releaseTrailers.map(bumpOf).reduce<Bump>((a, b) => (RANK[b] > RANK[a] ? b : a), 'patch')
  switch (bump) {
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

/** The next version for the repo at `cwd`: its latest `v*` tag and the `Release:` trailers since, as git parses them. */
export function versionFromGit(cwd: string): string {
  const tag = latestReleaseTag(cwd)
  const trailers = git(cwd, 'log', '--format=%(trailers:key=Release,valueonly)', sinceLastRelease(tag))
  return nextVersion(tag, trailers.split('\n').filter((line) => line.trim() !== ''))
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
