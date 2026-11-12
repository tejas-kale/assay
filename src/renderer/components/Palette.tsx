import { useState } from 'react'

import { paletteKey } from '../../core/dialogKeys.ts'
import { fuzzyRank } from '../../core/fuzzy.ts'
import { paletteCommands, shortcutLabel } from '../../core/keymap.ts'
import type { CommandId } from '../../core/keymap.ts'
import { useUpdate } from './Updates.tsx'

type Props = Readonly<{ onRun: (id: CommandId) => void; onClose: () => void }>

function CommandRows({ commands, index }: Readonly<{ commands: readonly { id: CommandId; title: string }[]; index: number }>) {
  return (
    <ul role="listbox">
      {commands.map((command, i) => (
        <li key={command.id} role="option" aria-selected={i === index} className={i === index ? 'row sel' : 'row'}>
          <span className="grow">{command.title}</span>
          <span className="dim">{shortcutLabel(command.id)}</span>
        </li>
      ))}
      {commands.length === 0 && <li className="empty">No command matches</li>}
    </ul>
  )
}

export function Palette({ onRun, onClose }: Props) {
  const [update] = useUpdate()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const shown = fuzzyRank(paletteCommands({ isUpdateReady: update?.status === 'ready' }), query, c => c.title)
  const index = Math.max(0, Math.min(selected, shown.length - 1))

  function onKeyDown(e: React.KeyboardEvent) {
    const key = paletteKey(e.key, e.ctrlKey, e.nativeEvent.isComposing)
    if (key === undefined) return
    e.preventDefault()
    if (key === 'next') setSelected(index + 1)
    else if (key === 'previous') setSelected(index - 1)
    else if (key === 'cancel') onClose()
    else if (shown[index]) onRun(shown[index].id)
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={e => { e.stopPropagation() }}>
        <input
          autoFocus
          value={query}
          placeholder="Type a command"
          spellCheck={false}
          onChange={e => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
        />
        <CommandRows commands={shown} index={index} />
      </div>
    </div>
  )
}
