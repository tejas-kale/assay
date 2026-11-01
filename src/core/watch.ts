export type WatchStat = { mtimeMs: number; size: number }
export type WatchPort = {
  stat(path: string): Promise<WatchStat | undefined>
  /** Calls `cb` every `ms`; the result stops it. */
  setInterval(cb: () => void, ms: number): () => void
}

const signature = (stat: WatchStat | undefined) => (stat ? `${stat.mtimeMs}:${stat.size}` : 'missing')

/**
 * Calls `onChange(path)` when a file's mtime, size or existence changes (a rename-over save
 * changes the mtime). The state at the call is the baseline. Returns a stop function.
 */
export function pollFiles(port: WatchPort, paths: readonly string[], onChange: (path: string) => void, intervalMs = 500): () => void {
  const seen = new Map<string, string>()
  let isStopped = false
  let isBusy = false

  const look = (path: string) => port.stat(path).then(signature, () => 'missing')
  const ready = Promise.all(paths.map(async path => seen.set(path, await look(path))))

  const stop = port.setInterval(async () => {
    if (isBusy) return
    isBusy = true
    try {
      await ready
      const now = await Promise.all(paths.map(look))
      if (isStopped) return
      paths.forEach((path, i) => {
        const next = now[i] ?? 'missing'
        if (seen.get(path) !== next) {
          seen.set(path, next)
          onChange(path)
        }
      })
    } finally {
      isBusy = false
    }
  }, intervalMs)

  return () => {
    isStopped = true
    stop()
  }
}
