import { PlotsTab } from '../components/data/PlotsTab.tsx'
import { Placeholder } from '../components/data/RunHeader.tsx'
import type { DataTabProps } from './types.ts'

export function Plots({ pane }: Readonly<DataTabProps>) {
  const { current, plot } = pane
  if (!current) return <Placeholder text="No runs yet. Claude's queries appear here." />
  const actions = {
    onCode: () => {
      pane.onTab('code')
    },
    onPin: pane.togglePin,
    onStep: pane.stepRun,
  }
  return <PlotsTab header={pane.header} run={current} runs={pane.runs} plot={plot.n} onPlot={plot.step} actions={actions} />
}
