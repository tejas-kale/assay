// Mermaid diagrams: a ```mermaid block in a note, or a .mmd / .mermaid file in a preview.
// mermaid is large, so it loads on first use, in its own chunk.
import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'

import { mermaidNodeIndex } from '../../core/lineage.ts'
import { THEMES } from '../../core/theme.ts'
import type { ThemeMode } from '../../core/theme.ts'
import { currentMode, onModeChange } from '../appearance.ts'

export type Rendered = { svg: string } | { error: string }

let mermaidModule: Promise<typeof import('mermaid').default> | undefined
let counter = 0
// mermaid keeps one global config: renders run one at a time, each with its theme set first.
let queue: Promise<unknown> = Promise.resolve()

/** The diagram as SVG text, drawn in the app's colours for `mode`, or mermaid's error message. */
export function renderMermaid(text: string, mode: ThemeMode): Promise<Rendered> {
  const job = queue.then(async (): Promise<Rendered> => {
    const mermaid = await (mermaidModule ??= import('mermaid').then(m => m.default))
    const ui = THEMES[mode].ui
    mermaid.initialize({
      startOnLoad: false,
      // Labels are text only: no HTML or clicks from a note's diagram.
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        darkMode: mode === 'dark',
        background: ui.bg,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
        fontSize: '13px',
        primaryColor: ui.panel,
        primaryTextColor: ui.text,
        primaryBorderColor: ui.accent,
        secondaryColor: ui.bg,
        tertiaryColor: ui.bg,
        lineColor: ui.dim,
        textColor: ui.text,
      },
    })
    const id = `mermaid-${++counter}`
    try {
      const { svg } = await mermaid.render(id, text)
      return { svg }
    } catch (err) {
      // A failed render can leave its scratch element in the page.
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  queue = job.catch(() => undefined)
  return job
}

/**
 * One diagram, redrawn when its text or the system's light / dark setting changes. A bad diagram shows its error and source.
 * `onNodeClick(i)` hears a click on a flowchart node whose id is our `n<i>`: the click handler is on the container, so
 * mermaid's strict mode (no click bindings in the SVG) stays on.
 */
export function MermaidDiagram({ text, onNodeClick }: { text: string; onNodeClick?: (node: number) => void }) {
  const [mode, setMode] = useState(currentMode)
  const [out, setOut] = useState<{ for: string; value: Rendered }>()
  useEffect(() => onModeChange(setMode), [])
  useEffect(() => {
    let live = true
    const key = `${mode}\0${text}`
    void renderMermaid(text, mode).then(value => {
      if (live) setOut({ for: key, value })
    })
    return () => {
      live = false
    }
  }, [text, mode])

  const value = out?.value
  if (!value) return <div className="mermaid-diagram dim">Drawing diagram…</div>
  if ('error' in value)
    return (
      <div className="mermaid-diagram">
        <div className="status warn">Mermaid could not draw this: {value.error.split('\n')[0]}</div>
        <pre className="filetext note-code">{text}</pre>
      </div>
    )
  // mermaid's strict mode sanitises the SVG it returns.
  const onClick = onNodeClick
    ? (e: MouseEvent) => {
        const node = e.target instanceof Element ? e.target.closest('g.node') : null
        const index = node ? mermaidNodeIndex(node.id) : undefined
        if (index !== undefined) onNodeClick(index)
      }
    : undefined
  return <div className="mermaid-diagram" onClick={onClick} dangerouslySetInnerHTML={{ __html: value.svg }} />
}
