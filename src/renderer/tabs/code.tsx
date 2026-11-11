import { NewQueryHeader, Placeholder } from '../components/data/RunHeader.tsx'
import type { DataTabProps } from './types.ts'

export function Code({ pane }: Readonly<DataTabProps>) {
  if (pane.edit && !pane.edit.from) return <>{pane.codeTab(<NewQueryHeader engine={pane.runs.findLast(r => r.language === 'sql')?.engine ?? 'databricks'} />)}</>
  if (!pane.current) {
    const onKey = (key: string) => {
      if (key !== 'n') return false
      pane.startNew()
      return true
    }
    return <Placeholder text="No runs yet. n: new SQL query." onKey={onKey} />
  }
  return <>{pane.codeTab(pane.header)}</>
}
