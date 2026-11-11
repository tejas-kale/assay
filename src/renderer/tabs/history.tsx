import { History as HistoryList } from '../components/data/History.tsx'
import type { DataTabProps } from './types.ts'

export function History({ pane }: Readonly<DataTabProps>) {
  return <HistoryList runs={pane.runs} status={pane.status} current={pane.current} onChoose={pane.choose} onPin={pane.togglePin} />
}
