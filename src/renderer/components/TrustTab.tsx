// The Trust tab: the latest `/an trust` review, live, in pytest style. Read-only; the approval is
// the mod's question in the Claude pane.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { diffLines, stateLine, stepDetail, stepTitle } from '../../core/trust.ts'
import type { TrustReview } from '../../core/trust.ts'
import { CodeView } from './CodeView.tsx'
import { isPaneKey } from './common.tsx'

const LINE = 40

export function TrustTab({ review }: { review: TrustReview | undefined }) {
  const ref = useRef<HTMLDivElement>(null)
  const checking = review?.state === 'checking'
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!checking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [checking])

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    const body = ref.current
    if (!body) return
    if (e.key === 'j') body.scrollBy({ top: LINE })
    else if (e.key === 'k') body.scrollBy({ top: -LINE })
    else if (e.key === 'g') body.scrollTo({ top: 0 })
    else if (e.key === 'G') body.scrollTo({ top: body.scrollHeight })
    else return
    e.preventDefault()
  }

  if (!review) {
    return (
      <div className="list placeholder" tabIndex={-1} data-focus-target>
        <div className="empty">No review. Type /an trust &lt;name&gt; in Claude.</div>
      </div>
    )
  }

  const state = stateLine(review, now)
  const sample = review.sample
  return (
    <div className="run" tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
      <div className="run-body trust-body" ref={ref}>
        <div className="trust-title">
          Trust {review.name} · {review.what}
          {review.replaces ? ' · replaces the trusted version' : ''}
        </div>
        {review.description && <div className="trust-desc">{review.description}</div>}
        {review.code !== undefined && (
          <div className="trust-code">
            <CodeView code={review.code} language={review.language === 'yaml' ? undefined : review.language} focusKey={review.name} original onToggleOriginal={() => undefined} passive />
          </div>
        )}
        {review.steps.map((step, i) => (
          <div key={i}>
            <div className={step.ok ? 'trust-step ok' : 'trust-step fail'}>
              <span className="verdict">{step.ok ? 'PASSED' : 'FAILED'}</span>
              <span>{stepTitle(step)}</span>
              <span className="dim">{stepDetail(step)}</span>
            </div>
            {step.diff && (
              <div className="trust-diff">
                {diffLines(step.diff).map((line, j) => (
                  <div key={j} className={line.kind === 'same' ? undefined : line.kind}>
                    {line.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {sample && (
          <div className="trust-sample">
            <div className="dim">
              Live sample: {sample.rows.length} of {sample.total ?? sample.rows.length} rows
            </div>
            <table className="grid">
              <thead>
                <tr>
                  {sample.columns.map((name, c) => (
                    <th key={c}>{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sample.rows.map((row, r) => (
                  <tr key={r}>
                    {sample.columns.map((_, c) => (
                      <td key={c}>{row[c] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className={`trust-state ${state.tone}`}>{state.text}</div>
    </div>
  )
}
