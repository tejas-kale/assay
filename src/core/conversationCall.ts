// Shared tool-call data and stored-result parsing; the SQL and Python row models both depend on this leaf.
export type ConversationCall = { tool: string; input: unknown; output?: unknown; isRunning?: boolean; isErrored?: boolean; isExpanded?: boolean }
export type ConversationFiles = Readonly<Record<string, string>>
export type ConversationTable = { file: string; columns: string[]; rows: string[][]; rowCount: number; columnCount: number }
export type ConversationRun = {
  kind: 'run'; number?: number; author: 'claude' | 'user'; language: 'sql' | 'python'; code: string
  file?: string; blockedReason?: string; running: boolean; tables: ConversationTable[]; plots: string[]; error?: string; stdout?: string
}
export function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  if (typeof output !== 'object' || output === null) return ''
  const content: unknown = Reflect.get(output, 'content')
  if (!Array.isArray(content)) return ''
  return content.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null || Reflect.get(block, 'type') !== 'text') return []
    const text: unknown = Reflect.get(block, 'text')
    return typeof text === 'string' ? [text] : []
  }).join('\n')
}

export function callRunNumber(call: ConversationCall): number | undefined {
  const match = /^(?:Run|Query)\s+(\d+)\b/im.exec(resultText(call.output))
  return match ? Number(match[1]) : undefined
}
