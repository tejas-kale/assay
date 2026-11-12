import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'

import type { PreviewSource } from '../../core/search.ts'
import { previewView } from '../../core/previewView.ts'
import type { PreviewView } from '../../core/previewView.ts'
import type { PreviewResult } from '../../shared/ipc.ts'
import { CodeView, languageOfPath } from './CodeView.tsx'
import { MermaidDiagram } from './Mermaid.tsx'
import { closeOnKeys, useFocusOnOpen } from './popup.ts'

const sourceLanguage = (source: PreviewSource | undefined) => {
  if (source?.type === 'path') return languageOfPath(source.path)
  return source?.type === 'text' ? source.language : undefined
}

/** The content of the file at `path`, read again when `refreshKey` changes. A newer path replaces an older one still loading. */
function usePreviewResult(path: string | undefined, refreshKey: unknown): PreviewResult | undefined {
  const [result, setResult] = useState<{ for: string; value: PreviewResult }>()
  useEffect(() => {
    if (path === undefined) return
    let live = true
    void window.app.files.preview(path).then(value => {
      if (live) setResult({ for: path, value })
    })
    return () => {
      live = false
    }
  }, [path, refreshKey])
  return result !== undefined && result.for === path ? result.value : undefined
}

type CodeProps = Readonly<{
  view: Extract<PreviewView, { view: 'code' }>
  source: PreviewSource | undefined
  path: string | undefined
  find?: string
  focus?: boolean
  /** Whether SQL shows its original text; kept by Preview, so it holds from one file to the next. */
  original: boolean
  onToggleOriginal: () => void
}>

function CodeBody({ view, source, path, find, focus, original, onToggleOriginal }: CodeProps) {
  return (
    <>
      <CodeView
        code={view.text}
        language={sourceLanguage(source)}
        focusKey={path ?? view.text}
        original={original}
        onToggleOriginal={onToggleOriginal}
        passive={!focus}
        autoFocus={focus ?? false}
        find={find}
      />
      {view.truncated && <div className="status dim">Cut here: the file is larger than the preview shows.</div>}
    </>
  )
}

function PreviewBody({ view, ...code }: Readonly<{ view: PreviewView } & Omit<CodeProps, 'view'>>) {
  switch (view.view) {
    case 'reading':
      return <div className="empty">Reading…</div>
    case 'error':
      return <div className="status warn">{view.message}</div>
    case 'image':
      return <img src={view.dataUrl} alt={code.path} />
    case 'binary':
      return <div className="empty">Binary file, {view.size}. Enter in the Files tab opens it in its app.</div>
    case 'diagram':
      return (
        <div className="mermaid-file">
          <MermaidDiagram text={view.text} />
        </div>
      )
    case 'code':
      return <CodeBody view={view} {...code} />
  }
}

type PreviewProps = Readonly<{
  source: PreviewSource | undefined
  find?: string
  focus?: boolean
  bodyRef?: RefObject<HTMLDivElement | null>
  refreshKey?: unknown
}>

/**
 * A read-only look at a file or a piece of text, in the Code tab's view: highlighted by extension, SQL
 * formatted (`o` shows the original text). It follows `source`: a newer source replaces an older one
 * still loading. `find` selects and scrolls to the first match. `focus` puts the cursor in it (a
 * pop-up); otherwise it never takes the keys (the search box keeps them). `refreshKey` reads the file again.
 */
export function Preview({ source, find, focus, bodyRef, refreshKey }: PreviewProps) {
  const path = source?.type === 'path' ? source.path : undefined
  const fetched = usePreviewResult(path, refreshKey)
  const [original, setOriginal] = useState(false)
  const shown: PreviewResult | undefined =
    source?.type === 'text' ? { ok: true, kind: 'text', text: source.text, truncated: false } : fetched
  return (
    <div className="preview" aria-label="Preview">
      <div className="subhead preview-title dim">{source === undefined ? 'Nothing selected' : (path ?? 'Text')}</div>
      <div className="preview-body" ref={bodyRef} tabIndex={-1}>
        {source !== undefined && (
          <PreviewBody
            view={previewView(shown, path)}
            source={source}
            path={path}
            find={find}
            focus={focus}
            original={original}
            onToggleOriginal={() => {
              setOriginal(o => !o)
            }}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The preview as a pop-up over the window, with the cursor in it: h j k l, w b, g G move, `o` shows
 * SQL's original text. Esc, Tab or q closes it, and `onClose` gives the keys back to the list.
 */
export function PreviewPopup({ source, onClose }: Readonly<{ source: PreviewSource; onClose: () => void }>) {
  const box = useRef<HTMLDivElement>(null)
  // An image, a binary file or an error has no editor to focus: the pop-up itself takes the keys.
  useFocusOnOpen(box)
  // At the page root, so no pane drawn later on the page covers it. React still bubbles its keys to the tab, which ignores keys from a dialog.
  return createPortal(
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="palette preview-popup"
        role="dialog"
        aria-modal="true"
        aria-label="Preview"
        tabIndex={-1}
        ref={box}
        onMouseDown={e => {
          e.stopPropagation()
        }}
        onKeyDown={closeOnKeys(onClose)}
      >
        <Preview source={source} focus />
        <div className="hint">h j k l · w b · g G move · o original SQL · Esc / Tab / q close</div>
      </div>
    </div>,
    document.body,
  )
}
