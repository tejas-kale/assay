// What the window is showing, and the subscriptions that keep it current: the open analysis, settings, the newest trust review.
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import { showReviewEffects } from '../../../core/appCommands.ts'
import type { CommandId } from '../../../core/keymap.ts'
import type { HoldKind } from '../../../core/cmdHold.ts'
import type { AnalysisState, SettingsView } from '../../../shared/ipc.ts'
import type { AppWindow } from './useAppWindow.ts'

export type View = { type: 'loading' } | { type: 'picker' } | { type: 'workspace'; state: AnalysisState }

/** The open analysis (or the picker, when none is open), and `loadState` to read it again. */
export function useView() {
  const [view, setView] = useState<View>({ type: 'loading' })
  const loadState = useCallback(() => {
    window.app.state.get().then(
      state => {
        setView(state ? { type: 'workspace', state } : { type: 'picker' })
      },
      () => {
        setView({ type: 'picker' })
      },
    )
  }, [])
  useEffect(() => {
    loadState()
    return window.app.state.onChange(state => {
      setView({ type: 'workspace', state })
    })
  }, [loadState])
  return { view, loadState }
}

/** The settings, and which key is held (it shows the shortcuts). */
export function useSettings() {
  const [settings, setSettings] = useState<SettingsView>()
  const [hints, setHints] = useState<HoldKind>()
  useEffect(() => {
    void window.app.settings.get().then(setSettings)
    const stops = [window.app.settings.onChange(setSettings), window.app.onHints(setHints)]
    return () => {
      for (const stop of stops) stop()
    }
  }, [])
  return { settings, hints }
}

/** A new trust review shows the Trust tab, or says it is off. The keyboard stays where the user is typing (Claude). */
export function useReviewTab(view: View, w: AppWindow) {
  // The newest review start the data pane has switched to; undefined until the first state, whose review is only the baseline.
  const trustStart = useRef<number | null | undefined>(undefined)
  const reviewStart = view.type === 'workspace' ? (view.state.trust?.startedAt ?? null) : undefined
  const showReview = useEffectEvent(() => {
    w.apply(showReviewEffects(w.tabs))
  })
  useEffect(() => {
    if (reviewStart === undefined) return
    const known = trustStart.current
    trustStart.current = reviewStart
    if (known !== undefined && reviewStart !== null && reviewStart !== known) showReview()
  }, [reviewStart])
}

/** Runs the commands main sends (menu and keys), each with the newest `run`. */
export function useCommandChannel(run: (id: CommandId) => boolean) {
  const onCommand = useEffectEvent((id: CommandId) => {
    run(id)
  })
  useEffect(
    () =>
      window.app.onCommand(id => {
        onCommand(id)
      }),
    [],
  )
}
