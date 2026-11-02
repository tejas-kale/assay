import { useState } from 'react'

/** The "Rename analysis" prompt: edits the title only; the folder keeps its name. */
export function RenameDialog({ title, onDone }: { title: string; onDone: (renamed: boolean) => void }) {
  const [text, setText] = useState(title)
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)

  function submit() {
    if (busy) return
    setBusy(true)
    window.app.analyses.rename(text).then(
      result => {
        setBusy(false)
        if (result.ok) onDone(true)
        else setMessage(result.message)
      },
      err => {
        setBusy(false)
        setMessage(String(err))
      },
    )
  }

  return (
    <div className="overlay" onMouseDown={() => onDone(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Rename analysis" onMouseDown={e => e.stopPropagation()}>
        <input
          autoFocus
          value={text}
          placeholder="Title"
          spellCheck={false}
          onFocus={e => e.currentTarget.select()}
          onChange={e => {
            setText(e.target.value)
            setMessage(undefined)
          }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onDone(false)
            }
          }}
        />
        {message && <div className="status warn">{message}</div>}
        <div className="hint">Enter renames the title. The folder name stays.</div>
      </div>
    </div>
  )
}
