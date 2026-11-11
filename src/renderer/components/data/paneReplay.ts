// The kernel's restart prompt and the Replay view: both take the pane's keys until answered or left.

import { useState } from 'react'

import { initReplay, replayKey } from '../../../core/replay.ts'
import type { ReplayState } from '../../../core/replay.ts'
import type { TabIdIn } from '../../../core/tabs.ts'
import type { Run } from '../../../shared/ipc.ts'
import type { SendRequest } from './paneRequests.ts'
import { focusDataPane } from './paneState.ts'
import type { PaneActions } from './paneState.ts'

export type RestartPrompt = { asking: boolean; ask: () => void; cancel: () => void; answer: (key: string) => void }

/** "Restart the kernel?": y sends the restart; y, n and Escape close the prompt; other keys are ignored. */
export function useRestartPrompt(send: SendRequest): RestartPrompt {
  const [asking, setAsking] = useState(false)
  return {
    asking,
    ask: () => {
      setAsking(true)
    },
    cancel: () => {
      setAsking(false)
    },
    answer: key => {
      if (key !== 'y' && key !== 'n' && key !== 'Escape') return
      setAsking(false)
      focusDataPane()
      if (key === 'y') send({ kind: 'restart' })
    },
  }
}

export type Replay = {
  /** The open view, and the tab it goes back to once the replay is sent. */
  open: { state: ReplayState; back: TabIdIn<'data'> } | undefined
  start: () => void
  dismiss: () => void
  onKey: (key: string) => void
}

export function useReplay(
  at: PaneActions & { runs: Run[]; tab: TabIdIn<'data'>; send: SendRequest; restart: RestartPrompt; follow: () => void },
): Replay {
  const [open, setOpen] = useState<Replay['open']>()
  const sendReplay = (runs: number[], back: TabIdIn<'data'>) => {
    at.send({ kind: 'replay', runs }, () => {
      setOpen(undefined)
      at.follow()
      at.onTab(back)
      focusDataPane()
    })
  }
  return {
    open,
    start: () => {
      const python = at.runs.filter(r => r.language === 'python')
      if (python.length === 0) {
        at.onToast('No Python runs to replay.')
        return
      }
      at.restart.cancel()
      setOpen({ state: initReplay(python), back: at.tab })
    },
    dismiss: () => {
      setOpen(undefined)
    },
    onKey: key => {
      if (!open) return
      const next = replayKey(open.state, key)
      if (next.effect?.type === 'leave') {
        setOpen(undefined)
        focusDataPane()
      }
      else if (next.effect?.type === 'send') sendReplay(next.effect.runs, open.back)
      else setOpen({ ...open, state: next.state })
    },
  }
}
