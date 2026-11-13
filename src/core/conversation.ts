import { callRunNumber, resultText } from './conversationCall.ts'
import type { ConversationCall, ConversationFiles, ConversationTable, ConversationRun } from './conversationCall.ts'
import { conversationNoteRow } from './conversationNotes.ts'
import type { ConversationNoteRow } from './conversationNotes.ts'
import { pythonConversation } from './conversationPython.ts'
import { codeBody, parseCsv, parseRunHeader, parseRuns } from './runs.ts'

export type { ConversationCall, ConversationFiles, ConversationTable, ConversationRun } from './conversationCall.ts'
export { resultText, callRunNumber } from './conversationCall.ts'
export type ConversationRow = ConversationRun | ConversationNoteRow

export function conversationTable(file: string, text: string): ConversationTable {
  const table = parseCsv(text, Number.MAX_SAFE_INTEGER)
  return { file, columns: table.columns, rows: table.rows.slice(0, 10), rowCount: table.rows.length, columnCount: table.columns.length }
}

function runningRow(call: ConversationCall): ConversationRow {
  const code: unknown = typeof call.input === 'object' && call.input !== null ? Reflect.get(call.input, 'sql') : undefined
  return { kind: 'run', author: 'claude', language: 'sql', code: typeof code === 'string' ? code : '', running: true, tables: [], plots: [] }
}

export function conversationRow(call: ConversationCall, files: ConversationFiles = {}): ConversationRow {
  if (call.tool === 'mcp__assay__python') return pythonConversation(call, files)
  if (call.tool !== 'mcp__assay__sql') return conversationNoteRow({ ...call, output: resultText(call.output) })
  if (call.isRunning) return runningRow(call)
  const number = callRunNumber(call)
  const run = parseRuns(Object.keys(files)).find(item => item.number === number)
  const text = run?.code ? files[run.code] : undefined
  if (!run?.code || text === undefined) return { kind: 'engine' }
  const csv = run.data ? files[run.data] : undefined
  const failed = call.isErrored || /^Query \d+ failed\b/m.test(resultText(call.output))
  if (!failed && csv === undefined) return { kind: 'engine' }
  const header = parseRunHeader(text)
  const body = codeBody(text, 'sql')
  return {
    kind: 'run', number, author: header.author, language: 'sql', code: body,
    running: false, tables: run.data && csv !== undefined ? [conversationTable(run.data, csv)] : [], plots: [],
    ...(failed && { error: resultText(call.output) }),
  }
}
