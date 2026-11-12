import { useEffect, useState } from 'react'

/** How often a list's ages count on: they show minutes at the finest. */
export const AGE_REFRESH_MS = 30_000

/** The time now in ms, read again every `everyMs`: for ages that should keep counting while a view stays open. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, everyMs)
    return () => {
      clearInterval(timer)
    }
  }, [everyMs])
  return now
}
