import type { DataTabName } from './common.tsx'

export const DATA_TABS: { id: DataTabName; title: string; slice: number }[] = [
  { id: 'data', title: 'Data', slice: 2 },
  { id: 'plots', title: 'Plots', slice: 3 },
  { id: 'code', title: 'Code', slice: 2 },
  { id: 'history', title: 'History', slice: 2 },
]

/** Placeholders: the tabs say which slice brings them. */
export function DataPane({ tab }: { tab: DataTabName }) {
  const current = DATA_TABS.find(t => t.id === tab)
  return (
    <div className="list placeholder" tabIndex={-1} data-focus-target>
      <div className="empty">
        {current?.title} arrives in slice {current?.slice}.
      </div>
    </div>
  )
}
