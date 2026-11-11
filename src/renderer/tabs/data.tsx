import { DataTab, Placeholder } from '../components/DataPane.tsx'
import type { DataTabProps } from './types.ts'

export function Data({ pane }: Readonly<DataTabProps>) {
  const { current, table } = pane
  if (!current) return <Placeholder text="No runs yet. Claude's queries appear here." />
  return (
    <DataTab
      header={pane.header}
      view={pane.view}
      status={pane.status}
      run={current}
      textView={table.textView}
      tableCount={table.count}
      onToggleText={table.toggleText}
      onTable={table.step}
      onCode={() => {
        pane.onTab('code')
      }}
      onPin={pane.togglePin}
      onStep={pane.stepRun}
    />
  )
}
