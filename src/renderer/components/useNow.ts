import { useEffect, useState } from 'react'

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
