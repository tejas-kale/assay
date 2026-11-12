// The Trust tab: the proposals in the analysis, each with Check, and the latest review, live, in pytest style.
// A review whose checks all passed shows Trust and Reject. The server (Assay's MCP server in Claude's session)
// runs the checks, which are advice; the files shown are the ones main reads from the draft folder, with their
// hashes, and Trust approves exactly those through main (specs/trust-ledger.md). Reject only closes the review.
import { useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'

import type { Proposal, TrustAnswer } from '../../core/requests.ts'
import { canAnswer, canCheck, diffLines, earlierReview, outcomeWord, stateLine, stepDetail, stepTitle } from '../../core/trust.ts'
import type { TrustReview, TrustSample, TrustStep } from '../../core/trust.ts'
import type { DraftFile, TrustFilesResult } from '../../core/trustApprove.ts'
import { checkPlan, mayAnswer, movedProposal, settledKey, trustTabKey } from '../../core/trustTab.ts'
import { CodeView } from './CodeView.tsx'
import type { SelectionHandle } from './CodeView.tsx'
import { isPaneKey } from './common.tsx'
import { trustRequests, useClock, useDraft, useTrustRequests } from './trust/trustRequests.ts'
import { Unadopted, languageOf } from './trust/Unadopted.tsx'

export { trustRequests }

const LINE = 40

type Props = Readonly<{
  review: TrustReview | undefined
  onToast: (text: string) => void
  /** The proposal's code, for Cmd+Enter on selected SQL. */
  selectionRef?: RefObject<SelectionHandle | null>
}>

type Requests = ReturnType<typeof useTrustRequests>

function ProposalList(props: Readonly<{ requests: Requests; review: TrustReview | undefined; chosen: Proposal | undefined; onSelect: (i: number) => void }>) {
  const { requests, review, chosen } = props
  const { proposals, isSending } = requests
  return (
    <div className="trust-proposals">
      {proposals === undefined && <div className="dim">Asking Claude's session for the proposals…</div>}
      {proposals?.length === 0 && <div className="dim">No proposals: Claude proposes calculations in lib/trusted/ and drafts dictionary entries in lib/dictionaries/.</div>}
      {proposals?.map((p, i) => (
        <div key={p.name} className={p === chosen ? 'trust-proposal selected' : 'trust-proposal'} onClick={() => { props.onSelect(i) }}>
          <span>{p.name}</span>
          <span className="dim">{p.folder}/</span>
          <button disabled={!canCheck(review) || isSending} onClick={() => { requests.check(p.name) }}>
            {p === chosen ? 'Check (c)' : 'Check'}
          </button>
        </div>
      ))}
    </div>
  )
}

function EarlierReview(props: Readonly<{ review: TrustReview | undefined; hasProposals: boolean }>) {
  const { review } = props
  if (!review) return <div className="empty">No review yet. Check a proposal to start one.</div>
  return (
    <div className="empty trust-earlier">
      Earlier review: {review.name} was {outcomeWord(review.state)} on {new Date(review.endedAt ?? review.startedAt).toLocaleString()}. It is not
      one of the proposals above.{props.hasProposals ? ' Check one to start a new review.' : ''}
    </div>
  )
}

function StepRow({ step }: Readonly<{ step: TrustStep }>) {
  return (
    <div>
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
  )
}

function SampleTable({ sample }: Readonly<{ sample: TrustSample }>) {
  return (
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
  )
}

/** The files main read from the draft folder, each with its sha256: what Trust approves. */
function DraftFiles(props: Readonly<{ review: TrustReview; draft: TrustFilesResult | undefined; selectionRef: Props['selectionRef'] }>) {
  const { draft, review } = props
  if (!draft) return <div className="dim">Reading the draft files…</div>
  if (!draft.ok) return <div className="trust-state bad">{draft.message}</div>
  const firstSql = draft.files.find((file: DraftFile) => languageOf(file.name) === 'sql')
  return (
    <>
      <div className="dim">Trust approves exactly these files, as read from the draft folder now:</div>
      {draft.files.map(file => (
        <div key={file.name} className="trust-code">
          <div className="dim" title={file.sha256}>
            {file.name} · sha256 {file.sha256.slice(0, 12)}…
          </div>
          <CodeView
            code={file.text}
            language={languageOf(file.name)}
            focusKey={`${review.name}/${file.name}`}
            original
            onToggleOriginal={() => undefined}
            passive
            unfocusable
            handleRef={file === firstSql ? props.selectionRef : undefined}
          />
        </div>
      ))}
    </>
  )
}

function ReviewDetails(props: Readonly<{ review: TrustReview; draft: TrustFilesResult | undefined; selectionRef: Props['selectionRef'] }>) {
  const { review } = props
  return (
    <>
      <div className="trust-title">
        Trust {review.name} · {review.what}
        {review.replaces ? ' · replaces the trusted version' : ''}
      </div>
      {review.description && <div className="trust-desc">{review.description}</div>}
      <DraftFiles review={review} draft={props.draft} selectionRef={props.selectionRef} />
      {review.steps.length > 0 && <div className="dim trust-environment">Checks ran inside Claude's environment: approve the code you see.</div>}
      {review.steps.map((step, i) => (
        <StepRow key={i} step={step} />
      ))}
      {review.sample && <SampleTable sample={review.sample} />}
    </>
  )
}

function StateBar(props: Readonly<{ review: TrustReview; now: number; isSending: boolean; hasDraft: boolean; onAnswer: (said: TrustAnswer) => void }>) {
  const { review, isSending } = props
  const state = stateLine(review, props.now)
  return (
    <div className={`trust-state ${state.tone}`}>
      <span>{state.text}</span>
      {canAnswer(review) && (
        <span className="trust-answer">
          <button disabled={isSending || !props.hasDraft} onClick={() => { props.onAnswer('trust') }}>
            Trust
          </button>
          <button disabled={isSending} onClick={() => { props.onAnswer('reject') }}>
            Reject
          </button>
        </span>
      )}
    </div>
  )
}

/** Keys: scrolling, moving among the proposals, Check, Trust, Reject and a fresh list. */
function useTrustKeys(args: { hasDraft: boolean; requests: Requests; review: TrustReview | undefined; chosen: Proposal | undefined; bodyRef: RefObject<HTMLDivElement | null>; onToast: Props['onToast']; setSelected: (move: (i: number) => number) => void }) {
  const { requests, review, chosen, bodyRef } = args
  const { proposals, isSending } = requests

  function onCheck() {
    const plan = checkPlan(review, isSending)
    if (plan.do === 'wait') args.onToast(plan.message)
    else if (plan.do === 'check' && chosen) requests.check(chosen.name)
  }

  return (e: KeyboardEvent) => {
    const key = isPaneKey(e) ? trustTabKey(e.key) : undefined
    const body = bodyRef.current
    if (key === undefined || (key === 'check' && !chosen)) return
    if (key === 'down') body?.scrollBy({ top: LINE })
    else if (key === 'up') body?.scrollBy({ top: -LINE })
    else if (key === 'top') body?.scrollTo({ top: 0 })
    else if (key === 'bottom') body?.scrollTo({ top: body.scrollHeight })
    else if (key === 'next') args.setSelected(i => movedProposal(i, 1, proposals?.length))
    else if (key === 'previous') args.setSelected(i => movedProposal(i, -1, proposals?.length))
    else if (key === 'check') onCheck()
    else if (key === 'list') requests.list()
    else if (mayAnswer(review, isSending) && (key === 'reject' || args.hasDraft)) requests.answer(key)
    else return
    e.preventDefault()
  }
}

export function TrustTab({ review, onToast, selectionRef }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const now = useClock(review?.state === 'checking')
  const draft = useDraft(review)
  const files = draft.result?.ok ? draft.result.files : undefined
  const requests = useTrustRequests(review, onToast, files, draft.reload)
  const [selected, setSelected] = useState(0)
  const { proposals } = requests
  const chosen = proposals?.[Math.min(selected, proposals.length - 1)]
  const onKeyDown = useTrustKeys({ hasDraft: files !== undefined, requests, review, chosen, bodyRef, onToast, setSelected })
  const earlier = !review || earlierReview(review, proposals)

  return (
    <div className="run" tabIndex={-1} data-focus-target onKeyDown={onKeyDown}>
      <div className="run-body trust-body" ref={bodyRef}>
        <ProposalList requests={requests} review={review} chosen={chosen} onSelect={setSelected} />
        <Unadopted reloadKey={settledKey(review)} onToast={onToast} />
        {earlier ? <EarlierReview review={review} hasProposals={(proposals?.length ?? 0) > 0} /> : <ReviewDetails review={review} draft={draft.result} selectionRef={selectionRef} />}
      </div>
      {!earlier && <StateBar review={review} now={now} isSending={requests.isSending} hasDraft={files !== undefined} onAnswer={requests.answer} />}
    </div>
  )
}
