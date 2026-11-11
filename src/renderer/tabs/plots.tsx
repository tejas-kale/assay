import { Placeholder, PlotsTab } from '../components/DataPane.tsx'
import type { DataTabProps } from './types.ts'

export function Plots({ pane }: Readonly<DataTabProps>) {
  const { current, plot } = pane
  if (!current) return <Placeholder text="No runs yet. Claude's queries appear here." />
  return (
    <PlotsTab
      header={pane.header}
      run={current}
      runs={pane.runs}
      plot={plot.n}
      plotCount={plot.count}
      onPlot={plot.step}
      onCode={() => {
        pane.onTab('code')
      }}
      onPin={pane.togglePin}
      onStep={pane.stepRun}
    />
  )
}
