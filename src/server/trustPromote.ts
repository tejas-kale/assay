// Approving a proposal: the files as checked are copied into the shared folder and committed there alone; the draft
// files that still hold what was approved are then removed.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import type { CheckAnswer } from '../core/calculations.ts'
import type { Assay } from './assay.ts'
import { draftOf } from './trustReview.ts'
import type { Review } from './trustReview.ts'

type Written = { file: string; text: string }
export type Promoted = { failed: string } | { isUnchanged: boolean; written: Written[] }
type Git = (args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** git in the root, whose failure to start is an exit code 1 like any other. */
function gitIn(assay: Assay): Git {
  const home = assay.config.root
  return args => assay.config.proc.run(['git', '-C', home, ...args], { cwd: assay.config.analysis }).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: messageOf(error) }))
}

/** The only file names a proposal of this review's kind may have. */
function allowedNames(review: Review): string[] {
  const { name } = review
  return review.kind === 'calculation' ? [`${name}.sql`, `${name}.py`, `test_${name}.py`, `${name}.test.yaml`, `${name}.rebuild.sql`] : [`${name}.yaml`, `${name}.test.yaml`]
}

/** The first file name that approving must not write: not one of the proposal's own names, or not inside the target folder. */
function refusedName(review: Review, answer: CheckAnswer): string | undefined {
  const allowed = allowedNames(review)
  const dest = resolve(review.dest)
  const isInside = (file: string) => resolve(dest, file).startsWith(`${dest}${sep}`)
  return [...(answer.files ?? []), ...Object.keys(answer.texts ?? {})].find(file => !allowed.includes(file) || !isInside(file))
}

const isLink = (path: string) => lstat(path).then(
  stat => stat.isSymbolicLink(),
  () => false,
)

/** What approving must not write through: the target folder or one of the files in it being a link that leads elsewhere. */
async function linkedName(review: Review, answer: CheckAnswer): Promise<string | undefined> {
  if (await isLink(review.dest)) return `${review.dest} is a link: approving will not write through it.`
  for (const file of answer.files ?? []) if (await isLink(`${review.dest}/${file}`)) return `${JSON.stringify(file)} is a link: approving will not write through it.`
  return undefined
}

/** Copies the proposal's files into the shared folder exactly as the check read them, whatever happened to the draft since. */
async function copyFiles(review: Review, answer: CheckAnswer): Promise<{ failed: string } | { written: Written[] }> {
  const refused = refusedName(review, answer)
  if (refused !== undefined) return { failed: `${JSON.stringify(refused)} is not a file this proposal may have.` }
  const linked = await linkedName(review, answer)
  if (linked !== undefined) return { failed: linked }
  const written: Written[] = []
  for (const file of answer.files ?? []) {
    const text = answer.texts?.[file]
    if (text === undefined) return { failed: `No checked copy of ${file}.` }
    await writeFile(`${review.dest}/${file}`, text, 'utf8')
    written.push({ file, text })
  }
  return { written }
}

/** Commits the copied files alone. Says why it could not, or whether they equalled the trusted version (nothing to commit). */
async function commitFiles(git: Git, review: Review, paths: string[]): Promise<{ failed: string } | { isUnchanged: boolean }> {
  const added = await git(['add', '--', ...paths])
  if (added.exitCode !== 0) return { failed: `git add failed: ${added.stderr.trim()}` }
  // Nothing staged for these paths: they equal the trusted version.
  const staged = await git(['diff', '--cached', '--quiet', '--', ...paths])
  if (staged.exitCode === 0) return { isUnchanged: true }
  const committed = await git(['commit', '-q', '-m', `trusted: approve ${review.name}`, '-m', "Approved by the user in Assay's Trust tab.", '--', ...paths])
  if (committed.exitCode !== 0) return { failed: `git commit failed: ${String((committed.stderr.trim() || committed.stdout.trim()).split('\n').at(-1))}` }
  return { isUnchanged: false }
}

/**
 * Approving: the files as checked go into the shared folder's trusted/ or dictionaries/, committed there alone.
 * Says why it could not, or whether the files equalled the trusted version (nothing to commit).
 */
export async function promote(assay: Assay, review: Review, answer: CheckAnswer): Promise<Promoted> {
  const git = gitIn(assay)
  const top = await git(['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { failed: `${assay.config.root} is not in a git repository: approving commits there.` }
  const made = await mkdir(review.dest, { recursive: true }).then(
    () => true,
    () => false,
  )
  if (!made) return { failed: `Cannot make ${review.dest}.` }
  const copied = await copyFiles(review, answer)
  if ('failed' in copied) return copied
  const committed = await commitFiles(git, review, copied.written.map(({ file }) => `${review.dest}/${file}`))
  return 'failed' in committed ? committed : { isUnchanged: committed.isUnchanged, written: copied.written }
}

/**
 * After approving: each draft file that still holds what was approved is removed, so the only copy is the trusted
 * one. One changed since the check is kept, so no edit is lost; its path (from the analysis) comes back.
 */
export async function removeDraft(assay: Assay, review: Review, written: readonly Written[]): Promise<string[]> {
  if (review.folder === review.dest) return []
  const kept: string[] = []
  for (const { file, text } of written) {
    const path = `${review.folder}/${file}`
    const now = await readFile(path, 'utf8').catch(() => undefined)
    if (now === undefined) continue
    if (now === text) await assay.remove(path)
    else kept.push(`${draftOf(review.kind)}/${file}`)
  }
  return kept
}
