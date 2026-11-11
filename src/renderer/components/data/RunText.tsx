import { useEffect, useState } from 'react'

import type { Run, RunStatus, RunView } from '../../../shared/ipc.ts'

/** Ticks once a second while `on`. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [on])
  return now
}

/** Whole seconds since the run started, while it runs. */
function useRunningSeconds(run: Run, status: RunStatus): number | undefined {
  const running = status.running?.number === run.number ? status.running : undefined
  const now = useNow(running !== undefined)
  return running && Math.max(0, Math.round((now - running.startedAt) / 1000))
}

/** What the Data and Code tabs say about a run with no result: running, failed, or simply none saved. */
export function NoResult({ run, status }: Readonly<{ run: Run; status: RunStatus }>) {
  const seconds = useRunningSeconds(run, status)
  const noun = run.language === 'python' ? 'Run' : 'Query'
  if (seconds !== undefined) {
    return <div className="empty running">{noun} {run.label} is running… {seconds} s</div>
  }
  const failed = status.failed[run.number]
  if (failed !== undefined) return <pre className="status warn run-error">{noun} {run.label} failed:{'\n'}{failed}</pre>
  return <div className="empty">No result saved for {noun.toLowerCase()} {run.label}. It may have failed in an earlier session.</div>
}

/** A Python run's stdout and error: the whole text view, updated on every state push while it runs. */
export function TextView({ run, view, status }: Readonly<{ run: Run; view: RunView; status: RunStatus }>) {
  const seconds = useRunningSeconds(run, status)
  const result = view.result
  if (!result) return <NoResult run={run} status={status} />
  const running = seconds !== undefined
  const { error } = result
  return (
    <div className="run-body">
      {running && <div className="empty running">Run {run.label} is running… {seconds} s</div>}
      {result.status === 'running' && !running && <div className="empty">Run {run.label} is marked running but the session is not running it: it was cut off.</div>}
      {result.status === 'interrupted' && <div className="status warn">Run {run.label} was interrupted.</div>}
      {result.stdout !== '' && <pre className="run-text">{result.stdout}</pre>}
      {result.stdoutTruncated && <div className="dim run-text">(output cut at 1 MB)</div>}
      {error && (
        <pre className="run-text traceback">
          {error.name}: {error.message}
          {error.traceback !== '' && `\n\n${error.traceback}`}
        </pre>
      )}
      {result.stdout === '' && !error && !running && result.status === 'ok' && <div className="empty">No output.</div>}
    </div>
  )
}
