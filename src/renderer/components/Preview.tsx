import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import type { PreviewSource } from '../../core/search.ts'
import type { PreviewResult } from '../../shared/ipc.ts'

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`

/** `text` with the first case-insensitive `mark` in a <mark>, which the preview scrolls to. */
function Marked({ text, mark }: { text: string; mark: string | undefined }) {
  const at = mark ? text.toLowerCase().indexOf(mark.toLowerCase()) : -1
  if (!mark || at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + mark.length)}</mark>
      {text.slice(at + mark.length)}
    </>
  )
}

/**
 * A read-only look at a file or a piece of text, beside a list. It follows `source`: a newer source
 * replaces an older one still loading. `mark` highlights and scrolls to the first match of the query.
 * `bodyRef` is the scroll box, for the owner's scroll keys. `refreshKey` reads the file again.
 */
export function Preview(props: { source: PreviewSource | undefined; mark?: string; bodyRef?: RefObject<HTMLDivElement | null>; refreshKey?: unknown }) {
  const { source, mark } = props
  const [result, setResult] = useState<{ for: string; value: PreviewResult }>()
  const ownRef = useRef<HTMLDivElement>(null)
  const bodyRef = props.bodyRef ?? ownRef
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

  // A new item (or query) starts at its top, or at the match, once its content is there. A re-read of the same item keeps the scroll.
  const placed = useRef<string>(undefined)
  const placeKey = source === undefined ? undefined : `${path ?? (source.type === 'text' ? source.text : '')}\0${mark ?? ''}`
  useEffect(() => {
    const box = bodyRef.current
    if (!box || shown === undefined || placeKey === placed.current) return
    placed.current = placeKey
    const hit = box.querySelector('mark')
    if (hit) hit.scrollIntoView({ block: 'center' })
    else box.scrollTop = 0
  }, [shown, placeKey, bodyRef])

  return (
    <div className="preview" aria-label="Preview">
      <div className="subhead preview-title dim">{source === undefined ? 'Nothing selected' : path ?? 'Text'}</div>
      <div className="preview-body" ref={bodyRef}>
        {source === undefined ? null : shown === undefined ? (
          <div className="empty">Reading…</div>
        ) : !shown.ok ? (
          <div className="status warn">{shown.message}</div>
        ) : shown.kind === 'image' ? (
          <img src={shown.dataUrl} alt={path} />
        ) : shown.kind === 'binary' ? (
          <div className="empty">Binary file, {size(shown.size)}. Enter opens it in its app.</div>
        ) : (
          <pre className="filetext">
            <Marked text={shown.text} mark={mark} />
            {shown.truncated && <span className="dim">{'\n'}… cut here: the file is larger than the preview shows.</span>}
          </pre>
        )}
      </div>
    </div>
  )
}
