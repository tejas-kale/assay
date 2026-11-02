// Ported from the analysis mod's hooks/model.ts (parseThreads, formatThreads) so both read threads.md alike.
import { StaleEdit } from './errors.ts'
import { oneLine } from './text.ts'

export type ClosedThread = { thread: string; outcome?: string }
export type Threads = { open: string[]; closed: ClosedThread[] }

const ARROW = ' → '

export function parseThreads(text: string): Threads {
  const threads: Threads = { open: [], closed: [] }
  let section: 'open' | 'closed' | undefined
  for (const line of text.split('\n')) {
    if (/^##\s+open\b/i.test(line)) section = 'open'
    else if (/^##\s+closed\b/i.test(line)) section = 'closed'
    else if (section === 'open') {
      const item = /^\s*\d+\.\s+(.*)$/.exec(line)
      if (item?.[1]) threads.open.push(item[1].trim())
    } else if (section === 'closed') {
      const item = /^\s*-\s+(.*)$/.exec(line)
      if (!item?.[1]) continue
      const at = item[1].indexOf(ARROW)
      threads.closed.push(
        at < 0
          ? { thread: item[1].trim() }
          : { thread: item[1].slice(0, at).trim(), outcome: item[1].slice(at + ARROW.length).trim() },
      )
    }
  }
  return threads
}

export function formatThreads({ open, closed }: Threads): string {
  const openLines = open.map((thread, i) => `${i + 1}. ${thread}\n`).join('')
  const closedLines = closed
    .map(({ thread, outcome }) => `- ${thread}${outcome ? ARROW + outcome : ''}\n`)
    .join('')
  return `## Open\n${openLines}\n## Closed\n${closedLines}`
}

function required(text: string, what: string) {
  const line = oneLine(text)
  if (line === '') throw new Error(`${what} is empty`)
  return line
}

function openAt(threads: Threads, index: number, expected: string) {
  if (threads.open[index] !== expected) throw new StaleEdit(`Open thread ${index + 1} changed on disk`)
}

export function addThread(text: string, thread: string): string {
  const threads = parseThreads(text)
  return formatThreads({ ...threads, open: [...threads.open, required(thread, 'Thread')] })
}

export function editOpen(text: string, index: number, expected: string, next: string): string {
  const threads = parseThreads(text)
  openAt(threads, index, expected)
  const line = required(next, 'Thread')
  return formatThreads({ ...threads, open: threads.open.map((each, i) => (i === index ? line : each)) })
}

export function deleteOpen(text: string, index: number, expected: string): string {
  const threads = parseThreads(text)
  openAt(threads, index, expected)
  return formatThreads({ ...threads, open: threads.open.filter((_, i) => i !== index) })
}

export function closeOpen(text: string, index: number, expected: string, outcome: string): string {
  const threads = parseThreads(text)
  openAt(threads, index, expected)
  const said = oneLine(outcome)
  return formatThreads({
    open: threads.open.filter((_, i) => i !== index),
    closed: [...threads.closed, said ? { thread: expected, outcome: said } : { thread: expected }],
  })
}

export function deleteClosed(text: string, index: number, expected: ClosedThread): string {
  const threads = parseThreads(text)
  const found = threads.closed[index]
  if (!found || found.thread !== expected.thread || found.outcome !== expected.outcome) {
    throw new StaleEdit(`Closed thread ${index + 1} changed on disk`)
  }
  return formatThreads({ ...threads, closed: threads.closed.filter((_, i) => i !== index) })
}

/** Moves an open thread by `delta` places, stopping at the ends. */
export function moveOpen(text: string, index: number, expected: string, delta: number): string {
  const threads = parseThreads(text)
  openAt(threads, index, expected)
  const to = Math.min(threads.open.length - 1, Math.max(0, index + delta))
  const rest = threads.open.filter((_, i) => i !== index)
  return formatThreads({ ...threads, open: [...rest.slice(0, to), expected, ...rest.slice(to)] })
}

// The tools' thread operations, ported from the analysis mod's hooks/model.ts. They name an open thread by its
// number, its exact text (any case) or a part of its text that no other open thread shares.

export const parkThread = (threads: Threads, thread: string): Threads => ({
  ...threads,
  open: [...threads.open, oneLine(thread)],
})

/** The index of the open thread that `ref` names, or why there is none. */
function findOpen(threads: Threads, ref: string): { index: number } | { error: string } {
  const wanted = oneLine(ref).toLowerCase()
  let index = /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1
  if (index < 0 || index >= threads.open.length) {
    index = threads.open.findIndex(open => open.toLowerCase() === wanted)
  }
  if (index < 0 && !/^\d+$/.test(wanted)) {
    const matches = threads.open.flatMap((open, i) => (open.toLowerCase().includes(wanted) ? [i] : []))
    if (matches.length > 1) return { error: `${matches.length} open threads match "${ref}"; give its number.` }
    index = matches[0] ?? -1
  }
  return threads.open[index] === undefined ? { error: `No open thread matches "${ref}".` } : { index }
}

/** Closes the open thread that `ref` names. */
export function closeThread(
  threads: Threads,
  ref: string,
  outcome?: string,
): { threads: Threads; closed?: ClosedThread; error?: string } {
  const found = findOpen(threads, ref)
  if ('error' in found) return { threads, error: found.error }
  const thread = threads.open[found.index] ?? ''
  const closed: ClosedThread = outcome && oneLine(outcome) ? { thread, outcome: oneLine(outcome) } : { thread }
  return {
    threads: { open: threads.open.filter((_, i) => i !== found.index), closed: [...threads.closed, closed] },
    closed,
  }
}

/** Moves the open thread that `ref` names to the top: the one under discussion. */
export function focusThread(threads: Threads, ref: string): { threads: Threads; focused?: string; error?: string } {
  const found = findOpen(threads, ref)
  if ('error' in found) return { threads, error: found.error }
  const thread = threads.open[found.index] ?? ''
  if (found.index === 0) return { threads, focused: thread }
  return { threads: { ...threads, open: [thread, ...threads.open.filter((_, i) => i !== found.index)] }, focused: thread }
}

/** Moves the open threads that `refs` name (each against the list as it was) to the top in that order. */
export function orderThreads(threads: Threads, refs: readonly string[]): { threads: Threads; error?: string } {
  const picked: number[] = []
  for (const ref of refs) {
    const found = findOpen(threads, ref)
    if ('error' in found) return { threads, error: found.error }
    if (picked.includes(found.index)) return { threads, error: `"${ref}" names a thread already listed.` }
    picked.push(found.index)
  }
  const rest = threads.open.flatMap((thread, i) => (picked.includes(i) ? [] : [thread]))
  return { threads: { ...threads, open: [...picked.map(i => threads.open[i] ?? ''), ...rest] } }
}
