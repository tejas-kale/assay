// The app window's own state: which tabs are shown, where the focus is asked to go, which overlay is open, the toast.
// Commands change it through `apply(effects)` (core/appCommands.ts decides the effects, appEffects.ts carries them out).
import { useCallback, useRef, useState } from 'react'

import type { Effect, Overlay } from '../../../core/appCommands.ts'
import type { TabIdIn, TabPrefs } from '../../../core/tabs.ts'
import type { DataCommand } from '../DataPane.tsx'
import type { FocusRequest } from '../Workspace.tsx'
import type { Reveal } from '../common.tsx'
import { applyEffects } from './appEffects.ts'

const TOAST_MS = 4000

function useNavigation() {
  const [notesTab, setNotesTab] = useState<TabIdIn<'notes'>>('threads')
  const [dataTab, setDataTab] = useState<TabIdIn<'data'>>('data')
  const [focusRequest, setFocusRequest] = useState<FocusRequest>()
  // Ctrl+0: the terminal fills the analysis. Focus moving to another pane brings the panes back, so it never lands in a hidden one.
  const [zoomed, setZoomed] = useState(false)
  const [dataCommand, setDataCommand] = useState<DataCommand>()
  const [reveal, setReveal] = useState<Reveal>()
  const counter = useRef(0)
  /** A number no earlier request had: it makes a repeat of the same request a new one. */
  const nextRequest = () => {
    counter.current += 1
    return counter.current
  }
  return { notesTab, setNotesTab, dataTab, setDataTab, focusRequest, setFocusRequest, zoomed, setZoomed, dataCommand, setDataCommand, reveal, setReveal, nextRequest }
}

function useOverlays() {
  const [palette, setPalette] = useState<Overlay>()
  const [search, setSearch] = useState<Overlay>()
  const [settingsOpen, setSettingsOpen] = useState<Overlay>()
  const [renaming, setRenaming] = useState(false)
  const [shortcuts, setShortcuts] = useState(0)
  const [pickerFocus, setPickerFocus] = useState(0)
  return { palette, setPalette, search, setSearch, settingsOpen, setSettingsOpen, renaming, setRenaming, shortcuts, setShortcuts, pickerFocus, setPickerFocus }
}

function useToast() {
  const [toast, setToast] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Stable: the request hooks depend on it, and a new one each render would clear their pending pickup warnings.
  const showToast = useCallback((text: string) => {
    setToast(text)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setToast(undefined)
    }, TOAST_MS)
  }, [])
  return { toast, showToast }
}

export type Navigation = ReturnType<typeof useNavigation>
export type Overlays = ReturnType<typeof useOverlays>
export type AppWindow = Navigation &
  Overlays & {
    toast: string | undefined
    showToast: (text: string) => void
    /** The tab settings in force. */
    tabs: TabPrefs
    apply: (effects: Effect[]) => void
  }

/** The window's state, and `apply` to carry out a command's effects on it. */
export function useAppWindow(tabs: TabPrefs): AppWindow {
  const navigation = useNavigation()
  const overlays = useOverlays()
  const { toast, showToast } = useToast()
  const surface = { ...navigation, ...overlays, showToast, tabs }
  return {
    ...surface,
    toast,
    apply: effects => {
      applyEffects(effects, surface)
    },
  }
}
