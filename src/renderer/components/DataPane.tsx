import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { ComponentType, ReactNode, RefObject } from 'react'

import { headerNote, runNumber, seenOf } from '../../core/dataPane.ts'
import { shortcutLabel } from '../../core/keymap.ts'
import type { CommandId } from '../../core/keymap.ts'
import { runningLabel } from '../../core/steps.ts'
import { tabSpec } from '../../core/tabs.ts'
import type { TabIdIn } from '../../core/tabs.ts'
import { trustSeenKey } from '../../core/trust.ts'
import type { Run, RunStatus, RunView, TrustReview } from '../../shared/ipc.ts'
import type { SelectionHandle } from './CodeView.tsx'
import { CodeTab } from './data/CodeTab.tsx'
import type { Edit } from './data/CodeTab.tsx'
import { runCode, useEditing } from './data/paneEdit.ts'
import type { Editing } from './data/paneEdit.ts'
import { useReplay, useRestartPrompt } from './data/paneReplay.ts'
import { useRequests } from './data/paneRequests.ts'
import type { SendRequest } from './data/paneRequests.ts'
import { focusDataPane, useFocusAfterStep, useHeldRun, useMarkers, useRunPicks, useRunView } from './data/paneState.ts'
import type { HeldRun, RunPicks } from './data/paneState.ts'
import { Prompt, ReplayView } from './data/Replay.tsx'
import { LinkButton, RunHeader } from './data/RunHeader.tsx'

export type { Edit } from './data/CodeTab.tsx'

/**
 * What the data pane hands the tab on screen (src/renderer/tabs): the current run and its header, and the pane's
 * actions. Each tab picks what it needs.
 */
export type DataPaneModel = {
  runs: Run[]
  status: RunStatus
  trust: TrustReview | undefined
  /** The run the pane shows: Claude's latest, unless one is held. */
  current: Run | undefined
  view: RunView | undefined
  /** The current run's header line, with this tab's links. */
  header: ReactNode
  edit: Edit | undefined
  onTab: (tab: TabIdIn<'data'>) => void
  onToast: (text: string) => void
  choose: (run: Run) => void
  togglePin: () => void
  stepRun: (delta: 1 | -1) => void
  startNew: () => void
  /** The Code tab, under `header`. */
  codeTab: (header: ReactNode) => ReactNode
  trustSelection: RefObject<SelectionHandle | null>
  table: RunPicks['table']
  plot: RunPicks['plot']
}

/** The shared props of the data pane's tab components. */
export type DataTabProps = { pane: DataPaneModel }

/** A command the app sends to the pane: `n` makes a repeat of the same command a new request. */
export type DataCommand = { n: number } & (
  | { id: Extract<CommandId, 'pin.toggle' | 'code.edit' | 'code.new' | 'code.run' | 'run.interrupt' | 'kernel.restart' | 'replay.open'> }
  /** Hold run `number`, as choosing it in History does (a followed citation in a note). */
  | { id: 'run.show'; number: number }
)

type Props = Readonly<{
  tab: TabIdIn<'data'>
  /** The tabs that are on, in the user's order. */
  tabs: readonly TabIdIn<'data'>[]
  /** The component of `tab` (src/renderer/tabs/index.ts). */
  Body: ComponentType<DataTabProps>
  runs: Run[]
  status: RunStatus
  trust?: TrustReview
  onTab: (tab: TabIdIn<'data'>) => void
  command: DataCommand | undefined
  onToast: (text: string) => void
}>

/** What the pane's header and model are built from. */
type Pane = Props & { held: HeldRun; picks: RunPicks; view: RunView | undefined; editing: Editing }

/**
 * Data, Plots, Code, Steps, History and Trust over `queries/`. All show one current run: Claude's latest, unless a run
 * is held (chosen in History, or pinned with `p`). Data links to the run's code and Code links back to its data. Code
 * can edit the run, or open a new SQL query (`n`), and Cmd+Enter sends the code to the mod as a new run. Python runs
 * add table switching and a stdout view to Data, the Plots tab, the kernel restart prompt and the Replay view.
 */
export function DataPane(props: Props) {
  const { tab, runs, status, trust, onTab, onToast } = props
  const [edit, setEdit] = useState<Edit>()
  const held = useHeldRun({ runs, locked: edit !== undefined && tab === 'code', onTab, onToast })
  const picks = useRunPicks(held.current)
  const view = useRunView(held.current, runs, picks.table.k)
  useFocusAfterStep(view, held.steppedRef)
  const markers = useMarkers(seenOf({ current: held.current, status, runCount: runs.length, ...(trust && { trust: trustSeenKey(trust) }) }), tab)
  const send = useRequests(status, runs.length, onToast)
  const editing = useEditing({ edit, setEdit, tab, current: held.current, view, onTab, onToast })
  const runIt = () => {
    runCode({ tab, editing, setEdit, current: held.current, view, runs, trust, send, follow: held.follow, onTab, onToast })
  }
  const restart = useRestartPrompt(send)
  const replay = useReplay({ runs, tab, send, restart, follow: held.follow, onTab, onToast })
  usePaneCommands(props.command, { held, editing, runIt, send, restart: restart.ask, replay: replay.start, runs, onToast })
  const showTab = (id: TabIdIn<'data'>) => {
    replay.dismiss()
    onTab(id)
  }
  return (
    <>
      <TabBar tabs={props.tabs} tab={tab} markers={markers} replaying={replay.open !== undefined} onTab={showTab} />
      {restart.asking && <Prompt text="Restart the kernel? Its variables are lost. y / n" onKey={restart.answer} />}
      {replay.open ? <ReplayView state={replay.open.state} onKey={replay.onKey} /> : <props.Body pane={paneModel({ ...props, held, picks, view, editing })} />}
    </>
  )
}

type Commands = {
  held: HeldRun
  editing: Editing
  runIt: () => void
  send: SendRequest
  restart: () => void
  replay: () => void
  runs: Run[]
  onToast: (text: string) => void
}

/** The app's commands reach the pane through one request at a time; a command sent before the pane existed (from
 * the picker) is not for it. */
function usePaneCommands(command: DataCommand | undefined, at: Commands) {
  const first = useRef(command?.n)
  const n = command?.n
  const perform = useEffectEvent(() => {
    if (!command || command.n === first.current) return
    if (command.id === 'run.show') {
      showRun(command.number, at)
      return
    }
    const actions: Record<typeof command.id, () => void> = {
      'pin.toggle': at.held.togglePin,
      'code.edit': at.editing.startEdit,
      'code.new': at.editing.startNew,
      'code.run': at.runIt,
      'run.interrupt': () => {
        at.send({ kind: 'interrupt' })
      },
      'kernel.restart': at.restart,
      'replay.open': at.replay,
    }
    actions[command.id]()
  })
  useEffect(() => {
    perform()
  }, [n])
}

/** Holds run `number`, as a followed citation asks; the citation came from another pane, so this one takes the keys. */
function showRun(number: number, at: Commands) {
  const run = at.runs.find(r => r.number === number)
  if (!run) {
    at.onToast(`No run ${runNumber(number)}`)
    return
  }
  at.held.choose(run)
  focusDataPane()
}

function TabBar(
  props: Readonly<{ tabs: readonly TabIdIn<'data'>[]; tab: TabIdIn<'data'>; markers: ReadonlySet<string>; replaying: boolean; onTab: (tab: TabIdIn<'data'>) => void }>,
) {
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map(id => (
        <button
          key={id}
          role="tab"
          tabIndex={-1}
          aria-selected={props.tab === id && !props.replaying}
          onClick={() => {
            props.onTab(id)
          }}
        >
          {tabSpec(id).title}
          {props.markers.has(id) && <span className="mark" title="New since you looked" />}
        </button>
      ))}
    </div>
  )
}

/** The Code tab under `header`: the current run's code, or the open edit. */
function codeTab(pane: Pane, header: ReactNode) {
  const { held, view, editing, onTab } = pane
  return (
    <CodeTab
      header={header}
      view={view}
      run={held.current}
      onData={() => {
        onTab('data')
      }}
      onPin={held.togglePin}
      onStep={held.stepRun}
      onEdit={editing.startEdit}
      onNew={editing.startNew}
      original={editing.original}
      onToggleOriginal={editing.toggleOriginal}
      edit={editing.edit}
      editText={editing.editText}
      onType={editing.onType}
      editorRef={editing.editor}
      selectionRef={editing.codeSelection}
      onLeave={editing.leave}
    />
  )
}

function paneModel(pane: Pane): DataPaneModel {
  const { held, picks, view, editing, onTab } = pane
  return {
    runs: pane.runs,
    status: pane.status,
    trust: pane.trust,
    current: held.current,
    view,
    header: held.current && <PaneHeader pane={pane} run={held.current} />,
    edit: editing.edit,
    onTab,
    onToast: pane.onToast,
    choose: held.choose,
    togglePin: held.togglePin,
    stepRun: held.stepRun,
    startNew: editing.startNew,
    codeTab: header => codeTab(pane, header),
    trustSelection: editing.trustSelection,
    table: picks.table,
    plot: picks.plot,
  }
}

/** The current run's header: its tags, the tab's note, the kernel's state and the link to Code or Data. */
function PaneHeader({ pane, run }: Readonly<{ pane: Pane; run: Run }>) {
  const { tab, held, picks, editing, onTab } = pane
  const kernel = pane.status.kernel
  const locked = editing.edit !== undefined && tab === 'code'
  const editingRun = locked ? editing.edit?.from : undefined
  const note = headerNote({ tab, python: picks.python, textView: picks.table.textView, table: picks.table, plot: picks.plot, steps: runningLabel(pane.view?.steps) })
  return (
    <>
      <RunHeader run={editingRun ?? run} status={pane.status} pinned={!held.following} editing={editingRun !== undefined} onFollow={held.follow} onStep={locked ? undefined : held.stepRun}>
        {note !== undefined && <span className="dim">{note}</span>}
        {kernel && (
          <span className={`kernel-state kernel-${kernel.state}`} title={kernel.message}>
            kernel {kernel.state}
          </span>
        )}
        <HeaderLinks tab={tab} editing={editing.edit !== undefined} onNew={editing.startNew} onTab={onTab} />
      </RunHeader>
      {kernel && (kernel.state === 'missing' || kernel.state === 'dead') && kernel.message && <div className="status warn">{kernel.message}</div>}
    </>
  )
}

function HeaderLinks(props: Readonly<{ tab: TabIdIn<'data'>; editing: boolean; onNew: () => void; onTab: (tab: TabIdIn<'data'>) => void }>) {
  const { onTab } = props
  if (props.tab !== 'code') {
    return <LinkButton onClick={() => { onTab('code') }} label="Code" shortcut={shortcutLabel('tab.code')} />
  }
  return (
    <>
      {!props.editing && <LinkButton onClick={props.onNew} label="New SQL" shortcut="n" />}
      <LinkButton onClick={() => { onTab('data') }} label="Data" shortcut={shortcutLabel('tab.data')} />
    </>
  )
}
