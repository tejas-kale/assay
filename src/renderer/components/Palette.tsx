import { useState } from 'react'

import { fuzzyRank } from '../../core/fuzzy.ts'
import { COMMANDS } from '../../core/keymap.ts'
import type { Command, CommandId } from '../../core/keymap.ts'

const KEY_NAMES: Record<string, string> = { Enter: 'Return' }

function shortcut(command: Command): string {
  const a = command.accelerator
  if (!a) return ''
  const key = a.code.replace(/^Key|^Digit/, '')
  return `Cmd+${a.shift ? 'Shift+' : ''}${KEY_NAMES[key] ?? key}`
}

export function Palette({ onRun, onClose }: { onRun: (id: CommandId) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const shown = fuzzyRank(COMMANDS, query, c => c.title)
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
              <span className="dim">{shortcut(command)}</span>
            </li>
          ))}
          {shown.length === 0 && <li className="empty">No command matches</li>}
        </ul>
      </div>
    </div>
  )
}
