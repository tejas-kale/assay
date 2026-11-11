import { OverviewTab } from '../components/OverviewTab.tsx'
import type { NotesTabProps } from './types.ts'

export function Overview({ state }: Readonly<NotesTabProps>) {
  return <OverviewTab key="overview" overview={state.overview} slug={state.analysis.name} />
}
