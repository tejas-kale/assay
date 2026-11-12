// The Trust tab's talk with Claude's session: the proposals it lists, and the checks and answers it sends.
import { useEffect, useEffectEvent, useState } from 'react'

import type { Proposal, Reply, RunRequest, TrustAnswer } from '../../../core/requests.ts'
import { hashesOf } from '../../../core/trustApprove.ts'
import type { DraftFile, TrustFilesResult } from '../../../core/trustApprove.ts'
import { settledKey } from '../../../core/trustTab.ts'
import type { TrustReview } from '../../../core/trust.ts'

/** The ids of the requests this tab sent: the data pane leaves their replies to it. */
export const trustRequests = new Set<string>()

/** The tab's own tick: `now` moves every second while a check runs, and is read afresh when one starts. */
export function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const tick = () => {
      setNow(Date.now())
    }
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [running])
  return now
}

/** The list, and whether a check or answer is on its way; replies come back as the list or why a request was refused. */
function useReplies(onToast: (text: string) => void) {
  const [proposals, setProposals] = useState<Proposal[]>()
  const [isSending, setSending] = useState(false)
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
  return { proposals, isSending, setSending }
}

/**
 * The proposal's files as main reads them from the draft folder, read again whenever the review moves on. This, not the
 * code in the server's report, is what Trust approves: the hashes sent are the hashes of these files.
 */
export function useDraft(review: TrustReview | undefined) {
  const name = review?.name
  const kind = review?.kind
  const startedAt = review?.startedAt
  const state = review?.state
  const key = `${String(name)}:${String(kind)}:${String(startedAt)}:${String(state)}`
  const [loaded, setLoaded] = useState<{ key: string; result: TrustFilesResult }>()
  const [again, setAgain] = useState(0)
  useEffect(() => {
    if (name === undefined || kind === undefined) return
    let isLive = true
    void window.app.trust.files({ name, kind }).then(result => {
      if (isLive) setLoaded({ key, result })
    })
    return () => {
      isLive = false
    }
  }, [key, name, kind, again])
  const result = loaded?.key === key ? loaded.result : undefined
  return {
    result,
    reload: () => {
      setAgain(n => n + 1)
    },
  }
}

/** Sends Trust to main with the hashes of the files shown; a refusal is said, and the draft read again. */
async function approve(review: TrustReview, files: readonly DraftFile[], onToast: (text: string) => void, reload: () => void) {
  const result = await window.app.trust.approve({ name: review.name, kind: review.kind, hashes: hashesOf(files) })
  if (!result.ok) {
    onToast(result.message)
    reload()
  }
}

/** Trust goes to main with the hashes of the files shown (main approves, never the server); Reject only tells the server to close the review. */
export function useTrustRequests(review: TrustReview | undefined, onToast: (text: string) => void, files: readonly DraftFile[] | undefined, reload: () => void) {
  const { proposals, isSending, setSending } = useReplies(onToast)

  const send = (request: RunRequest) => {
    void window.app.runs.request(request).then(result => {
      if (!result.ok) {
        onToast(result.message)
        return
      }
      trustRequests.add(result.id)
      if (request.kind !== 'trust-list') setSending(true)
    })
  }
  const list = () => {
    send({ kind: 'trust-list' })
  }
  const listOnSettle = useEffectEvent(list)
  // The list on opening the tab, and again whenever a review ends (an approval removes its draft).
  const settled = settledKey(review)
  useEffect(() => {
    listOnSettle()
  }, [settled])

  return {
    proposals,
    isSending,
    list,
    check: (name: string) => {
      send({ kind: 'trust-check', name })
    },
    answer: (said: TrustAnswer) => {
      if (!review) return
      if (said === 'reject') send({ kind: 'trust-done', name: review.name, outcome: 'rejected' })
      else if (files) {
        setSending(true)
        void approve(review, files, onToast, reload).then(() => {
          setSending(false)
        })
      }
    },
  }
}
