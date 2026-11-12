import { useEffect, useRef, useState } from 'react'

import { dialogKey } from '../../core/dialogKeys.ts'
import type { SettingsView } from '../../shared/ipc.ts'
import { Doctor } from './Doctor.tsx'
import { StripSettings, TabSettings } from './LayoutSettings.tsx'
import { Updates } from './Updates.tsx'

type Props = Readonly<{ settings: SettingsView; onClose: (() => void) | undefined }>

/** The folder field: typing, saving, and the folder picker. `message` holds why a save failed. */
function useRootField(root: string | undefined, onClose: Props['onClose']) {
  const [input, setInput] = useState(root ?? '')
  const [message, setMessage] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function save(path = input) {
    window.app.settings.setRoot(path).then(
      result => {
        if (!result.ok) setMessage(result.message)
        else onClose?.()
      },
      (err: unknown) => {
        setMessage(String(err))
      },
    )
  }
  function choose() {
    void window.app.settings.chooseRoot().then(path => {
      if (path) {
        setInput(path)
        setMessage(undefined)
        save(path)
      }
      inputRef.current?.focus()
    })
  }
  function edit(text: string) {
    setInput(text)
    setMessage(undefined)
  }
  return { input, message, inputRef, save, choose, edit }
}

/**
 * Sets the analysis folder, the tabs and the strip, keeps the update token, and shows the Doctor. `onClose` is
 * undefined while no folder is set, since the app cannot go on without one.
 */
export function Settings({ settings, onClose }: Props) {
  const { input, message, inputRef, save, choose, edit } = useRootField(settings.root, onClose)

  function onKeyDown(e: React.KeyboardEvent) {
    const key = dialogKey(e.key, e.nativeEvent.isComposing)
    if (key === undefined) return
    e.preventDefault()
    if (key === 'confirm') save()
    else onClose?.()
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette settings" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={e => { e.stopPropagation() }}>
        <h1>Settings</h1>
        <label htmlFor="settings-root">Analysis folder</label>
        <div className="settings-row">
          <input
            id="settings-root"
            ref={inputRef}
            value={input}
            placeholder="~/path/to/folder"
            spellCheck={false}
            onChange={e => { edit(e.target.value) }}
            onKeyDown={onKeyDown}
          />
          <button type="button" onClick={choose}>Choose</button>
        </div>
        <div className="hint">Analyses live in its analyses/ subfolder; picking one analysis works too. Enter saves{onClose ? ', Escape cancels' : ''}.</div>
        {message && <div className="status warn">{message}</div>}
        <TabSettings tabs={settings.tabs} />
        <StripSettings strip={settings.strip} />
        <Updates />
        <Doctor />
      </div>
    </div>
  )
}
