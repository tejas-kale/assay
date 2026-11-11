import { useEffect, useState } from 'react'

import { updateBanner, updateText } from '../../core/update.ts'
import type { UpdateView } from '../../shared/ipc.ts'

/** The updater's view, kept current as it checks, downloads and fails. */
export function useUpdate(): [UpdateView | undefined, (view: UpdateView) => void] {
  const [view, setView] = useState<UpdateView>()
  useEffect(() => {
    void window.app.update.get().then(setView)
    return window.app.update.onChange(setView)
  }, [])
  return [view, setView]
}

/** `Assay 0.4.3 is ready. Restart`, in every analysis view once an update is downloaded. */
export function UpdateBanner() {
  const [view] = useUpdate()
  const text = view && updateBanner(view)
  if (!text) return null
  return (
    <div className="banner update" role="status">
      {text}{' '}
      <button type="button" onClick={() => void window.app.update.restart()}>
        Restart
      </button>
    </div>
  )
}

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Settings > Updates: the version, what the updater is doing, the last check and error, and the token. */
export function Updates() {
  const [view, setView] = useUpdate()
  if (!view) return null
  return (
    <section className="updates" aria-label="Updates">
      <label htmlFor="update-token">Updates: Assay {view.current}</label>
      <div className="hint">
        {view.isPackaged ? updateText(view) : 'Updates run only in a release build.'}
        {view.lastCheck !== undefined && ` Last check ${timeOf(view.lastCheck)}.`}
      </div>
      {view.error && <div className="status warn">{view.error}</div>}
      <TokenRow hasToken={view.hasToken} onForget={() => void window.app.update.clearToken().then(setView)} />
      <div className="hint">A fine-grained token for tejas-kale/assay with Contents read-only. It is kept in the Keychain.</div>
    </section>
  )
}

/** The token field: Save keeps a pasted token, Forget drops the kept one. The token is never shown again. */
function TokenRow({ hasToken, onForget }: Readonly<{ hasToken: boolean; onForget: () => void }>) {
  const [input, setInput] = useState('')
  const [message, setMessage] = useState<string>()
  const save = () => {
    void window.app.update.setToken(input).then(result => {
      setMessage(result.ok ? undefined : result.message)
      if (result.ok) setInput('')
    })
  }
  return (
    <>
      <div className="settings-row">
        <input
          id="update-token"
          type="password"
          value={input}
          placeholder={hasToken ? 'A token is kept. Paste another to replace it' : 'github_pat_...'}
          spellCheck={false}
          autoComplete="off"
          onChange={e => {
            setInput(e.target.value)
            setMessage(undefined)
          }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.key !== 'Enter') return
            e.preventDefault()
            save()
          }}
        />
        <button type="button" onClick={save} disabled={!input}>
          Save
        </button>
        {hasToken && <button type="button" onClick={onForget}>Forget</button>}
      </div>
      {message && <div className="status warn">{message}</div>}
    </>
  )
}
