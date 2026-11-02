import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'

import type { PreviewSource } from '../../core/search.ts'
import type { PreviewResult } from '../../shared/ipc.ts'
import { CodeView, languageOfPath } from './CodeView.tsx'

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`

/**
 * A read-only look at a file or a piece of text, in the Code tab's view: highlighted by extension, SQL
 * formatted (`o` shows the original text). It follows `source`: a newer source replaces an older one
 * still loading. `find` selects and scrolls to the first match. `focus` puts the cursor in it (a
 * pop-up); otherwise it never takes the keys (the search box keeps them). `refreshKey` reads the file again.
 */
export function Preview(props: {
  source: PreviewSource | undefined
  find?: string | undefined
  focus?: boolean
  bodyRef?: RefObject<HTMLDivElement | null>
  refreshKey?: unknown
}) {
  const { source, find, focus } = props
  const [result, setResult] = useState<{ for: string; value: PreviewResult }>()
  const [original, setOriginal] = useState(false)
  const path = source?.type === 'path' ? source.path : undefined

  useEffect(() => {
    if (path === undefined) return
    let live = true
    void window.app.files.preview(path).then(value => {
      if (live) setResult({ for: path, value })
    })
    return () => {
      live = false
    }
  }, [path, props.refreshKey])

  const shown: PreviewResult | undefined =
    source?.type === 'text' ? { ok: true, kind: 'text', text: source.text, truncated: false } : result && result.for === path ? result.value : undefined

  return (
    <div className="preview" aria-label="Preview">
      <div className="subhead preview-title dim">{source === undefined ? 'Nothing selected' : path ?? 'Text'}</div>
      <div className="preview-body" ref={props.bodyRef} tabIndex={-1}>
        {source === undefined ? null : shown === undefined ? (
          <div className="empty">Reading…</div>
        ) : !shown.ok ? (
          <div className="status warn">{shown.message}</div>
        ) : shown.kind === 'image' ? (
          <img src={shown.dataUrl} alt={path} />
        ) : shown.kind === 'binary' ? (
          <div className="empty">Binary file, {size(shown.size)}. Enter in the Files tab opens it in its app.</div>
        ) : (
          <>
            <CodeView
              code={shown.text}
              language={path === undefined ? undefined : languageOfPath(path)}
              focusKey={path ?? shown.text}
              original={original}
              onToggleOriginal={() => setOriginal(o => !o)}
              passive={!focus}
              autoFocus={focus ?? false}
              find={find}
            />
            {shown.truncated && <div className="status dim">Cut here: the file is larger than the preview shows.</div>}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The preview as a pop-up over the window, with the cursor in it: h j k l, w b, g G move, `o` shows
 * SQL's original text. Esc, Tab or q closes it, and `onClose` gives the keys back to the list.
 */
export function PreviewPopup(props: { source: PreviewSource; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  // An image, a binary file or an error has no editor to focus: the pop-up itself takes the keys.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!box.current?.contains(document.activeElement)) box.current?.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [])
  // At the page root, so no pane drawn later on the page covers it. React still bubbles its keys to the tab, which ignores keys from a dialog.
  return createPortal(
    <div className="overlay" onMouseDown={props.onClose}>
      <div
        className="palette preview-popup"
        role="dialog"
        aria-modal="true"
        aria-label="Preview"
        tabIndex={-1}
        ref={box}
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.metaKey || e.ctrlKey || e.altKey) return
          if (e.key === 'Escape' || e.key === 'Tab' || e.key === 'q') {
            e.preventDefault()
            e.stopPropagation()
            props.onClose()
          }
        }}
      >
        <Preview source={props.source} focus />
        <div className="hint">h j k l · w b · g G move · o original SQL · Esc / Tab / q close</div>
      </div>
    </div>,
    document.body,
  )
}
