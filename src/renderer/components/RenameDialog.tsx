import { useState } from 'react'

import { dialogKey } from '../../core/dialogKeys.ts'

type Props = Readonly<{ title: string; onDone: (renamed: boolean) => void }>

/** Renames through the main process; `message` holds why it failed. */
function useRename(onDone: Props['onDone']) {
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  function rename(text: string) {
    if (busy) return
    setBusy(true)
    window.app.analyses.rename(text).then(
      result => {
        setBusy(false)
        if (result.ok) onDone(true)
        else setMessage(result.message)
      },
      (err: unknown) => {
        setBusy(false)
        setMessage(String(err))
      },
    )
  }
  return { message, clearMessage: () => { setMessage(undefined) }, rename }
}

/** The "Rename analysis" prompt: edits the title only; the folder keeps its name. */
export function RenameDialog({ title, onDone }: Props) {
  const [text, setText] = useState(title)
  const { message, clearMessage, rename } = useRename(onDone)

  function onKeyDown(e: React.KeyboardEvent) {
    const key = dialogKey(e.key, e.nativeEvent.isComposing)
    if (key === undefined) return
    e.preventDefault()
    if (key === 'confirm') rename(text)
    else onDone(false)
  }

  return (
    <div className="overlay" onMouseDown={() => { onDone(false) }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Rename analysis" onMouseDown={e => { e.stopPropagation() }}>
        <input
          autoFocus
          value={text}
          placeholder="Title"
          spellCheck={false}
          onFocus={e => { e.currentTarget.select() }}
          onChange={e => {
            setText(e.target.value)
            clearMessage()
          }}
          onKeyDown={onKeyDown}
        />
        {message && <div className="status warn">{message}</div>}
        <div className="hint">Enter renames the title. The folder name stays.</div>
      </div>
    </div>
  )
}
