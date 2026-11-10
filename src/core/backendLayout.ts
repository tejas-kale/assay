// The app's backend folders under its data folder (docs/slice-11.md, 11b): backend/<version>/ holds the shipped
// plugin, server, hooks and Python project; venvs/<version>/ the venv uv builds from it, with its status file beside.

/** Folder names that start a copy in progress; a crash can leave one behind. */
export const TEMP_PREFIX = '.tmp-'
const STATUS_SUFFIX = '.status.json'
const SEMVER = /^\d+\.\d+\.\d+$/

/** A version as one number that sorts like it: 0.10.1 above 0.9.0. Only called on names SEMVER matches. */
const rank = (version: string) => version.split('.').reduce((total, part) => total * 1_000_000 + Number(part), 0)
const compare = (a: string, b: string) => rank(a) - rank(b)

/**
 * The entries of backend/ or venvs/ to delete: every version but `current` and the highest one below it (so a
 * session the previous version started keeps its files until it ends), and leftover temporary copies. Names that
 * are not a version, such as dev/, are never touched.
 */
export function staleEntries(names: readonly string[], current: string): string[] {
  const versionOf = (name: string) => (name.endsWith(STATUS_SUFFIX) ? name.slice(0, -STATUS_SUFFIX.length) : name)
  const versions = names.map(versionOf).filter(version => SEMVER.test(version))
  const previous = versions.filter(version => compare(version, current) < 0).sort(compare).at(-1)
  return names.filter(name => {
    if (name.startsWith(TEMP_PREFIX)) return true
    const version = versionOf(name)
    return SEMVER.test(version) && version !== current && version !== previous
  })
}

export type PreparePhase = 'backend' | 'venv'

/** The line the app shows while it prepares this version's backend or venv. */
export const preparingLine = (version: string, phase: PreparePhase) =>
  `Preparing Assay ${version}: ${phase === 'backend' ? 'copying the backend' : 'Python environment'}...`
