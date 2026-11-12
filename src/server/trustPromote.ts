// After the user pressed Trust in the app: copies the approved draft into the shared folder, inside Claude's
// environment, and commits it there for history. The app (main) never writes into the root or runs git there, because
// Claude's side can plant links, hooks and git config in it (docs/developer/security.md). This is safe because trust
// comes only from the ledger: the server copies only files whose hashes the ledger holds for this proposal, and a
// wrong copy simply is not trusted. A `trust-done` that the ledger does not back does nothing.
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { allowedNames } from '../core/trustNames.ts'
import { entryKey, parseLedger } from '../core/trustLedger.ts'
import type { Assay } from './assay.ts'
import { sharedOf } from './trustReview.ts'
import type { Review } from './trustReview.ts'

const GIT_MS = 30_000
type Draft = { name: string; bytes: Buffer; sha256: string }
export type Promoted = { refused: string } | { gitProblem?: string; kept: string[]; copied: boolean }

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const isLink = (path: string) => lstat(path).then(stat => stat.isSymbolicLink(), () => false)

/** Reads one file without following a link, whatever happens to the name between a check and the read. */
async function readRegular(path: string): Promise<Buffer | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
  if (!handle) return undefined
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : undefined
  } finally {
    await handle.close()
  }
}

/** The review's own draft files as they are now, or why they cannot be read. A name other than the proposal's is never looked at. */
async function readDraft(review: Review): Promise<{ files: Draft[] } | { problem: string }> {
  if ((await isLink(dirname(review.folder))) || (await isLink(review.folder))) return { problem: `${review.folder} is a link.` }
  const files: Draft[] = []
  for (const name of allowedNames(review.kind, review.name)) {
    const path = join(review.folder, name)
    const exists = await lstat(path).then(() => true, () => false)
    if (!exists) continue
    const bytes = await readRegular(path)
    if (!bytes) return { problem: `${name} in the draft is not a regular file.` }
    files.push({ name, bytes, sha256: sha256(bytes) })
  }
  return { files }
}

/** Why the ledger does not approve exactly these files for this proposal, or undefined when it does. */
async function ledgerRefusal(assay: Assay, review: Review, files: readonly Draft[]): Promise<string | undefined> {
  const path = assay.config.ledger
  if (!path) return 'this session has no trust ledger.'
  const text = await readRegular(path).then(bytes => bytes?.toString('utf8'))
  if (text === undefined) return 'the trust ledger has no entry for it.'
  const { ledger, problem } = parseLedger(text)
  if (problem !== undefined) return problem
  const key = entryKey(review.kind, review.name)
  const entry = Object.hasOwn(ledger.entries, key) ? ledger.entries[key] : undefined
  if (!entry) return 'the trust ledger has no entry for it.'
  const folder = sharedOf(review.kind)
  const approved = Object.entries(entry.files)
  const same = approved.length === files.length && files.every(file => entry.files[`${folder}/${file.name}`] === file.sha256)
  return same && files.length > 0 ? undefined : 'the draft is not what the ledger approved.'
}

/** Writes through a temp file and a rename, so a half-written file is never there to be trusted. */
async function writeFileAtomic(path: string, bytes: Buffer): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, bytes, { flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

/** Copies the files into the shared folder; why not, if a link is in the way. Returns whether any file changed. */
async function copyFiles(review: Review, files: readonly Draft[]): Promise<{ failed: string } | { changed: boolean }> {
  if (await isLink(review.dest)) return { failed: `${review.dest} is a link: it is not written through.` }
  await mkdir(review.dest, { recursive: true })
  if (await isLink(review.dest)) return { failed: `${review.dest} is a link: it is not written through.` }
  let changed = false
  for (const file of files) {
    const path = join(review.dest, file.name)
    if (await isLink(path)) return { failed: `${JSON.stringify(file.name)} in ${review.dest} is a link: it is not written through.` }
    if ((await readRegular(path))?.equals(file.bytes) === true) continue
    await writeFileAtomic(path, file.bytes)
    changed = true
  }
  return { changed }
}

/** Commits the copied files alone, for history. Why not, when it could not; nothing when they equal the committed version. */
async function commitFiles(assay: Assay, review: Review, paths: readonly string[]): Promise<string | undefined> {
  const git = (args: readonly string[]) =>
    assay.config.proc.run(['git', '-C', assay.config.root, ...args], { cwd: assay.config.analysis, timeoutMs: GIT_MS }).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: messageOf(error) }))
  if ((await git(['rev-parse', '--show-toplevel'])).exitCode !== 0) return `${assay.config.root} is not in a git repository.`
  const added = await git(['add', '--', ...paths])
  if (added.exitCode !== 0) return `git add failed: ${added.stderr.trim()}`
  if ((await git(['diff', '--cached', '--quiet', '--', ...paths])).exitCode === 0) return undefined
  const committed = await git(['commit', '-q', '-m', `trusted: approve ${review.name}`, '-m', "Approved by the user in Assay's Trust tab.", '--', ...paths])
  return committed.exitCode === 0 ? undefined : `git commit failed: ${String((committed.stderr.trim() || committed.stdout.trim()).split('\n').at(-1))}`
}

/** Removes each draft file that still holds what was copied; one that changed since is kept, so no edit is lost. */
async function removeDraft(review: Review, copied: readonly Draft[]): Promise<string[]> {
  const kept: string[] = []
  const now = await readDraft(review)
  for (const file of copied) {
    const there = 'files' in now ? now.files.find(each => each.name === file.name) : undefined
    if (!there) continue
    if (there.sha256 === file.sha256) await unlink(join(review.folder, file.name)).catch(() => undefined)
    else kept.push(file.name)
  }
  return kept
}

/**
 * The app says it approved this review. Only when the ledger holds this proposal with exactly the draft's current
 * hashes: the draft goes into the shared folder, is committed, and is removed. Otherwise `refused` says why and
 * nothing is copied, so a forged `trust-done` changes nothing.
 */
export async function promote(assay: Assay, review: Review): Promise<Promoted> {
  const draft = await readDraft(review)
  if ('problem' in draft) return { refused: `Not approved in the app: ${draft.problem}` }
  const why = await ledgerRefusal(assay, review, draft.files)
  if (why !== undefined) return { refused: `Not approved in the app: ${why}` }
  let copied: Awaited<ReturnType<typeof copyFiles>>
  try {
    copied = await copyFiles(review, draft.files)
  } catch (error) {
    return { refused: `Could not copy ${review.name} into ${sharedOf(review.kind)}/: ${messageOf(error)}` }
  }
  if ('failed' in copied) return { refused: copied.failed }
  const gitProblem = await commitFiles(assay, review, draft.files.map(file => `${sharedOf(review.kind)}/${file.name}`))
  const kept = await removeDraft(review, draft.files)
  return { copied: copied.changed, kept, ...(gitProblem === undefined ? {} : { gitProblem }) }
}

/** The line the Trust tab shows once the files are copied. `kept` are the draft files that changed after the approval. */
export function promotedMessage(review: Review, outcome: 'approved' | 'unchanged', promoted: { gitProblem?: string; kept: readonly string[] }): string {
  const folder = sharedOf(review.kind)
  const kept = promoted.kept.length === 0 ? '' : ` Kept the draft ${promoted.kept.join(', ')}: it changed after the approval.`
  if (outcome === 'unchanged') {
    const problem = promoted.gitProblem?.replace(/\.?$/, '.')
    const history = problem === undefined ? '' : `Git history not written: ${problem} `
    return `${history}Already trusted: no changes.${kept}`
  }
  if (promoted.gitProblem !== undefined) return `Trusted ${review.name}: recorded in the app, copied to ${folder}/. Git history not written: ${promoted.gitProblem}${kept}`
  return `Trusted ${review.name}: approved in the app and copied to ${folder}/.${kept}`
}
