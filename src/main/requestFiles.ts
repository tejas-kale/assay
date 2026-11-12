// The files between the app and the server (`.assay/requests`, `.assay/replies`), and the one-at-a-time edits of
// threads.md and the notes.
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { StaleEdit } from '../core/errors.ts'
import { byCodeUnit, jsonFileNames } from '../core/nameOrder.ts'
import { newRequestId, parseReply, requestText } from '../core/requests.ts'
import type { Reply } from '../core/requests.ts'
import type { EditResult, RequestResult, RunRequest } from '../shared/ipc.ts'
import { messageOf, readText, writeAtomic } from './fsAccess.ts'

const ASSAY = '.assay'
const REQUESTS = 'requests'
const REPLIES = 'replies'
export const REPLIES_DIR = join(ASSAY, REPLIES)
const JUNK_REPLY_MS = 60_000

// Edits to one file run one at a time, so two quick edits cannot read the same text.
const queues = new Map<string, Promise<unknown>>()

/** Reads the file fresh, applies the core edit and writes it back atomically, giving the outcome as a value. */
async function applyEdit(path: string, edit: (text: string) => string): Promise<EditResult> {
  let next: string
  try {
    next = edit(await readText(path))
  } catch (err) {
    if (err instanceof StaleEdit) return { ok: false, reason: 'stale', message: 'Changed on disk, reloaded' }
    return { ok: false, reason: 'invalid', message: messageOf(err) }
  }
  try {
    await writeAtomic(path, next)
  } catch (err) {
    return { ok: false, reason: 'invalid', message: `Could not save: ${messageOf(err)}` }
  }
  return { ok: true }
}

/**
 * Reads the file fresh, applies the core edit and writes it back atomically. A `StaleEdit`
 * becomes `stale`; any other thrown Error from the edit (empty input, file note) becomes `invalid`.
 */
export function editFile(folder: string, name: string, edit: (text: string) => string): Promise<EditResult> {
  const path = join(folder, name)
  const run = () => applyEdit(path, edit)
  const previous = queues.get(path) ?? Promise.resolve()
  const result = previous.then(run, run)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  queues.set(path, tail)
  void tail.then(() => {
    if (queues.get(path) === tail) queues.delete(path)
  })
  return result
}

/** Makes sure `path` is a real folder, creating it when missing; a link or a file in its place is refused, never followed. */
async function realFolder(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined)
  if (!info) await mkdir(path).catch(() => undefined)
  const now = info ?? (await lstat(path))
  if (!now.isDirectory()) throw new Error(`${path} is not a real folder (a link or a file): it is refused.`)
}

/** Creates a new file without following a link at its name. */
async function createFile(path: string, text: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(text, 'utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Writes a request for the server to pick up. `.assay` and `.assay/requests` must be real folders (Claude's side can
 * plant a link there: docs/developer/security.md, L-9). The temp name starts with `.`, which the server ignores.
 */
export async function writeRequest(folder: string, request: RunRequest): Promise<RequestResult> {
  const id = newRequestId(Date.now(), Math.random)
  try {
    const assay = join(folder, ASSAY)
    const dir = join(assay, REQUESTS)
    await realFolder(assay)
    await realFolder(dir)
    // Written once, never over the user's own file, and never through a link.
    await createFile(join(assay, '.gitignore'), '*\n').catch(() => undefined)
    const temp = join(dir, `.${id}.json.tmp`)
    await createFile(temp, requestText(id, request))
    await rename(temp, join(dir, `${id}.json`))
    return { ok: true, id }
  } catch (err) {
    return { ok: false, message: `Could not send: ${messageOf(err)}` }
  }
}

/** What reading one reply file did: it was delivered, it is half written (wait), or it was unreadable for good. */
async function takeReply(path: string): Promise<{ reply?: Reply; waiting?: true }> {
  const reply = parseReply(await readFile(path, 'utf8'))
  if (reply) {
    await unlink(path)
    return { reply }
  }
  if (Date.now() - (await stat(path)).mtimeMs > JUNK_REPLY_MS) {
    // The mod writes replies in place, so an unreadable one may be half written: wait, then give up.
    await unlink(path)
    return {}
  }
  return { waiting: true }
}

/** Reads and deletes every reply file the mod has written. `waiting`: one is still half written, so read again soon. */
export async function takeReplies(folder: string): Promise<{ replies: Reply[]; waiting: boolean }> {
  const dir = join(folder, ASSAY, REPLIES)
  let names: string[]
  try {
    names = jsonFileNames(await readdir(dir)).toSorted(byCodeUnit)
  } catch {
    return { replies: [], waiting: false }
  }
  const replies: Reply[] = []
  let waiting = false
  for (const name of names) {
    try {
      const taken = await takeReply(join(dir, name))
      if (taken.reply) replies.push(taken.reply)
      if (taken.waiting) waiting = true
    } catch {
      // Gone already, or half written: the next poll tries again.
    }
  }
  return { replies, waiting }
}
