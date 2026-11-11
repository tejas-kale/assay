import { Placeholder } from '../components/DataPane.tsx'
import { StepsTab } from '../components/StepsTab.tsx'
import type { DataTabProps } from './types.ts'

export function Steps({ pane }: Readonly<DataTabProps>) {
  if (!pane.current) return <Placeholder text="No runs yet. Claude's queries appear here." />
  return (
    <StepsTab
      header={pane.header}
      view={pane.view}
      run={pane.current}
      onToast={pane.onToast}
      onCode={() => {
        pane.onTab('code')
      }}
      onPin={pane.togglePin}
      onStep={pane.stepRun}
    />
  )
}
