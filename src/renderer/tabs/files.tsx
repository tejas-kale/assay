import { FilesTab } from '../components/FilesTab.tsx'
import type { NotesTabProps } from './types.ts'

export function Files({ state, reveal, onRevealed }: Readonly<NotesTabProps>) {
  return <FilesTab key="files" refreshKey={state} reveal={reveal} onRevealed={onRevealed} />
}
