import { DataTab } from '../components/data/DataTab.tsx'
import { Placeholder } from '../components/data/RunHeader.tsx'
import type { DataTabProps } from './types.ts'

export function Data({ pane }: Readonly<DataTabProps>) {
  const { current, table } = pane
  if (!current) return <Placeholder text="No runs yet. Claude's queries appear here." />
  const actions = {
    onCode: () => {
      pane.onTab('code')
    },
    onPin: pane.togglePin,
    onStep: pane.stepRun,
  }
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
      actions={actions}
    />
  )
}
