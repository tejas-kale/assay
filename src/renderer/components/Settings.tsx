import { useEffect, useRef, useState } from 'react'

/** Sets the analysis folder. `onClose` is undefined while no folder is set, since the app cannot go on without one. */
export function Settings({ root, onClose }: { root: string | undefined; onClose: (() => void) | undefined }) {
  const [input, setInput] = useState(root ?? '')
  const [message, setMessage] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function save() {
    window.app.settings.setRoot(input).then(
      result => {
        if (!result.ok) setMessage(result.message)
        else onClose?.()
      },
      err => setMessage(String(err)),
    )
  }
  function choose() {
    void window.app.settings.chooseRoot().then(path => {
      if (path) {
        setInput(path)
        setMessage(undefined)
      }
      inputRef.current?.focus()
    })
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette settings" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={e => e.stopPropagation()}>
        <h1>Settings</h1>
        <label htmlFor="settings-root">Analysis folder</label>
        <div className="settings-row">
          <input
            id="settings-root"
            ref={inputRef}
            value={input}
            placeholder="~/path/to/folder"
            spellCheck={false}
            onChange={e => {
              setInput(e.target.value)
              setMessage(undefined)
            }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose?.()
              }
            }}
          />
          <button type="button" onClick={choose}>Choose</button>
        </div>
        <div className="hint">Analyses live in its analyses/ subfolder. Enter saves{onClose ? ', Escape cancels' : ''}.</div>
        {message && <div className="status warn">{message}</div>}
      </div>
    </div>
  )
}
