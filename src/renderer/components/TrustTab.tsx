// The Trust tab: the proposals in the analysis, each with Check, and the latest review, live, in pytest style.
// A review whose checks all passed shows Trust and Reject. The server (Assay's MCP server in Claude's session)
// runs the checks and the commit; this tab only sends `trust-list`, `trust-check` and `trust-answer` requests.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import type { Proposal, Reply, TrustAnswer } from '../../core/requests.ts'
import { canAnswer, canCheck, diffLines, earlierReview, outcomeWord, stateLine, stepDetail, stepTitle } from '../../core/trust.ts'
import type { TrustReview } from '../../core/trust.ts'
import { CodeView } from './CodeView.tsx'
import { isPaneKey } from './common.tsx'

const LINE = 40

/** The ids of the requests this tab sent: the data pane leaves their replies to it. */
export const trustRequests = new Set<string>()

type Props = { review: TrustReview | undefined; onToast: (text: string) => void }

export function TrustTab({ review, onToast }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const checking = review?.state === 'checking'
  const [now, setNow] = useState(Date.now())
  const [proposals, setProposals] = useState<Proposal[] | undefined>(undefined)
  const [selected, setSelected] = useState(0)
  const [isSending, setSending] = useState(false)
  useEffect(() => {
    setNow(Date.now())
    if (!checking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [checking])

  // Replies to this tab's requests: the list, or why a check or an answer was refused.
  useEffect(
    () =>
      window.app.runs.onReply((reply: Reply) => {
        if (!trustRequests.delete(reply.id)) return
        setSending(false)
        if ('proposals' in reply) setProposals(reply.proposals)
        else if ('error' in reply) onToast(reply.error)
      }),
    [onToast],
  )

  const send = (request: Parameters<typeof window.app.runs.request>[0]) => {
    void window.app.runs.request(request).then(result => {
      if (!result.ok) return onToast(result.message)
      trustRequests.add(result.id)
      if (request.kind !== 'trust-list') setSending(true)
    })
  }
  const list = () => send({ kind: 'trust-list' })
  const check = (name: string) => send({ kind: 'trust-check', name })
  const answer = (said: TrustAnswer) => review && send({ kind: 'trust-answer', name: review.name, answer: said })

  // The list on opening the tab, and again whenever a review ends (an approval removes its draft).
  const settled = review && !checking && review.state !== 'asking' ? `${review.name}:${review.state}:${review.startedAt}` : ''
  useEffect(list, [settled])

  const chosen = proposals?.[Math.min(selected, proposals.length - 1)]
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isPaneKey(e)) return
    const body = ref.current
    if (e.key === 'j') body?.scrollBy({ top: LINE })
    else if (e.key === 'k') body?.scrollBy({ top: -LINE })
    else if (e.key === 'g') body?.scrollTo({ top: 0 })
    else if (e.key === 'G') body?.scrollTo({ top: body.scrollHeight })
    else if (e.key === 'J' || e.key === 'ArrowDown') setSelected(i => Math.min((proposals?.length ?? 1) - 1, i + 1))
    else if (e.key === 'K' || e.key === 'ArrowUp') setSelected(i => Math.max(0, i - 1))
    else if ((e.key === 'c' || e.key === 'Enter') && chosen) {
      if (!canCheck(review)) onToast(`Wait for the review of ${review?.name ?? 'the other proposal'} to finish.`)
      else if (!isSending) check(chosen.name)
    }
    else if (e.key === 't' && canAnswer(review) && !isSending) answer('trust')
    else if (e.key === 'r' && canAnswer(review) && !isSending) answer('reject')
    else if (e.key === 'l') list()
    else return
    e.preventDefault()
  }

  const proposalList = (
    <div className="trust-proposals">
      {proposals === undefined && <div className="dim">Asking Claude's session for the proposals…</div>}
      {proposals?.length === 0 && <div className="dim">No proposals: Claude proposes calculations in lib/trusted/ and drafts dictionary entries in lib/dictionaries/.</div>}
      {proposals?.map((p, i) => (
        <div key={p.name} className={p === chosen ? 'trust-proposal selected' : 'trust-proposal'} onClick={() => setSelected(i)}>
          <span>{p.name}</span>
          <span className="dim">{p.folder}/</span>
          <button disabled={!canCheck(review) || isSending} onClick={() => check(p.name)}>
            {p === chosen ? 'Check (c)' : 'Check'}
          </button>
        </div>
      ))}
    </div>
  )

  if (!review || earlierReview(review, proposals)) {
    return (
      <div className="run" tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
        <div className="run-body trust-body" ref={ref}>
          {proposalList}
          {review ? (
            <div className="empty trust-earlier">
              Earlier review: {review.name} was {outcomeWord(review.state)} on {new Date(review.endedAt ?? review.startedAt).toLocaleString()}. It is not
              one of the proposals above.{proposals?.length ? ' Check one to start a new review.' : ''}
            </div>
          ) : (
            <div className="empty">No review yet. Check a proposal to start one.</div>
          )}
        </div>
      </div>
    )
  }

  const state = stateLine(review, now)
  const sample = review.sample
  return (
    <div className="run" tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
      <div className="run-body trust-body" ref={ref}>
        {proposalList}
        <div className="trust-title">
          Trust {review.name} · {review.what}
          {review.replaces ? ' · replaces the trusted version' : ''}
        </div>
        {review.description && <div className="trust-desc">{review.description}</div>}
        {review.code !== undefined && (
          <div className="trust-code">
            <CodeView code={review.code} language={review.language === 'yaml' ? undefined : review.language} focusKey={review.name} original onToggleOriginal={() => undefined} passive unfocusable />
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
      <div className={`trust-state ${state.tone}`}>
        <span>{state.text}</span>
        {canAnswer(review) && (
          <span className="trust-answer">
            <button disabled={isSending} onClick={() => answer('trust')}>
              Trust
            </button>
            <button disabled={isSending} onClick={() => answer('reject')}>
              Reject
            </button>
          </span>
        )}
      </div>
    </div>
  )
}
