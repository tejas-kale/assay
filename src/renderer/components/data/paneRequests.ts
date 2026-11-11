// Sending the pane's requests to Claude's session (`.assay/requests/`), and reporting each reply, or its absence, once.

import { useEffect, useRef } from 'react'

import { pickupMissed, replyToast } from '../../../core/dataPane.ts'
import type { RunRequest, RunStatus } from '../../../shared/ipc.ts'
import { isStepsRequest } from '../StepsTab.tsx'
import { trustRequests } from '../TrustTab.tsx'

/** The user's reply is not expected after this long: the mod only polls while Claude's session is alive. */
const PICKUP_MS = 10_000

type Pending = { kind: RunRequest['kind']; timer: ReturnType<typeof setTimeout> }

/** Writes a request, then reports once whether the session picked it up. `onSent` runs when the file is written. */
export type SendRequest = (request: RunRequest, onSent?: () => void) => void

export function useRequests(status: RunStatus, runCount: number, onToast: (text: string) => void): SendRequest {
  const pending = useRef(new Map<string, Pending>())
  // What the pickup check reads when its timer fires: the state of then, not of the send.
  const now = useRef({ status, runCount })
  useEffect(() => {
    now.current = { status, runCount }
  })
  useEffect(() => {
    const sent = pending.current
    const stop = window.app.runs.onReply(reply => {
      // The Trust and Steps tabs read the replies to their own requests.
      if (trustRequests.has(reply.id) || isStepsRequest(reply.id) || 'proposals' in reply) return
      const request = sent.get(reply.id)
      if (request) clearTimeout(request.timer)
      sent.delete(reply.id)
      const text = replyToast(request?.kind, reply)
      if (text !== undefined) onToast(text)
    })
    return () => {
      stop()
      sent.forEach(p => {
        clearTimeout(p.timer)
      })
    }
  }, [onToast])

  return (request, onSent) => {
    const sentAt = runCount
    void window.app.runs.request(request).then(result => {
      if (!result.ok) {
        onToast(result.message)
        return
      }
      onSent?.()
      onToast("Sent to Claude's session…")
      const timer = setTimeout(() => {
        pending.current.delete(result.id)
        if (pickupMissed(now.current, sentAt)) onToast('The session has not picked up the request. Is Claude running in this window?')
      }, PICKUP_MS)
      pending.current.set(result.id, { kind: request.kind, timer })
    })
  }
}
