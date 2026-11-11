import { TrustTab } from '../components/TrustTab.tsx'
import type { DataTabProps } from './types.ts'

export function Trust({ pane }: Readonly<DataTabProps>) {
  return <TrustTab review={pane.trust} onToast={pane.onToast} selectionRef={pane.trustSelection} />
}
