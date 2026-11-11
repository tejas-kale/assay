/** "just now", "5 min ago", "3 h ago", "2 d ago", "4 w ago", "6 mo ago", "2 y ago". */
export function formatAge(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${String(days)} d ago`
  if (days < 30) return `${String(Math.floor(days / 7))} w ago`
  if (days < 365) return `${String(Math.floor(days / 30))} mo ago`
  return `${String(Math.floor(days / 365))} y ago`
}
