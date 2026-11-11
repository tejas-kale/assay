import { ThreadsTab } from '../components/ThreadsTab.tsx'
import type { NotesTabProps } from './types.ts'

export function Threads({ state, reveal, onRevealed }: Readonly<NotesTabProps>) {
  return <ThreadsTab key="threads" threads={state.threads} reveal={reveal} onRevealed={onRevealed} />
}

/** The tab's label: its open threads counted. */
export const threadsLabel = ({ threads }: NotesTabProps['state']) => (threads.open.length > 0 ? `Threads (${String(threads.open.length)})` : 'Threads')
