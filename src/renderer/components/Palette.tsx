import { useState } from 'react'

import { fuzzyRank } from '../../core/fuzzy.ts'
import { paletteCommands, shortcutLabel } from '../../core/keymap.ts'
import type { CommandId } from '../../core/keymap.ts'
import { useUpdate } from './Updates.tsx'

export function Palette({ onRun, onClose }: { onRun: (id: CommandId) => void; onClose: () => void }) {
  const [update] = useUpdate()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const shown = fuzzyRank(paletteCommands({ isUpdateReady: update?.status === 'ready' }), query, c => c.title)
  const index = Math.max(0, Math.min(selected, shown.length - 1))

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={e => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder="Type a command"
          spellCheck={false}
          onChange={e => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
            const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
            if (down || up) {
              e.preventDefault()
              setSelected(index + (down ? 1 : -1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const command = shown[index]
              if (command) onRun(command.id)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <ul role="listbox">
          {shown.map((command, i) => (
            <li key={command.id} role="option" aria-selected={i === index} className={i === index ? 'row sel' : 'row'}>
              <span className="grow">{command.title}</span>
              <span className="dim">{shortcutLabel(command.id)}</span>
            </li>
          ))}
          {shown.length === 0 && <li className="empty">No command matches</li>}
        </ul>
      </div>
    </div>
  )
}
