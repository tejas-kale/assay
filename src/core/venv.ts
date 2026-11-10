// The state of Assay's venv, which the app builds at launch while Claude may already be running. The app writes it
// beside the venv (`<venv>.status.json`); the server and the Doctor read it. A launcher that brings its own venv
// writes none, and the venv then counts as built when its python exists.

export type VenvBuild = { state: 'building' } | { state: 'ready' } | { state: 'failed'; error: string }

export const venvStatusPath = (venv: string) => `${venv}.status.json`

export const VENV_MISSING = "Assay's Python environment is not built: open Settings (⌘,) and see the Doctor."
export const VENV_BUILDING = 'Assay is still building its Python environment. Try again in a minute.'
export const venvFailed = (error: string) => `Assay could not build its Python environment: ${error}`

/** The status file's text as a build state; undefined when there is none or it cannot be read. */
export function parseVenvBuild(text: string | undefined): VenvBuild | undefined {
  try {
    const parsed = JSON.parse(text ?? '') as { state?: unknown; error?: unknown } | null
    if (parsed?.state === 'building' || parsed?.state === 'ready') return { state: parsed.state }
    if (parsed?.state === 'failed') return { state: 'failed', error: typeof parsed.error === 'string' ? parsed.error : 'unknown error' }
  } catch {
    // No file, or a half-written one: say nothing about the build.
  }
  return undefined
}

/** Why the tools cannot run while the venv's python is missing. */
export function venvHint(build: VenvBuild | undefined): string {
  if (build?.state === 'building') return VENV_BUILDING
  if (build?.state === 'failed') return venvFailed(build.error)
  return VENV_MISSING
}
