import { codeBody, parseCsv, parseRunHeader, parseRunResult, parseRuns } from './runs.ts'
import { callRunNumber } from './conversationCall.ts'
import type { ConversationCall, ConversationFiles, ConversationRun } from './conversationCall.ts'

type PythonRow = ConversationRun | { kind: 'engine' }

export function pythonConversation(call: ConversationCall, files: ConversationFiles): PythonRow {
  if (call.isRunning) {
    const code: unknown = typeof call.input === 'object' && call.input !== null ? Reflect.get(call.input, 'code') : undefined
    return { kind: 'run', author: 'claude', language: 'python', code: typeof code === 'string' ? code : '', running: true, tables: [], plots: [] }
  }
  const number = callRunNumber(call)
  const run = parseRuns(Object.keys(files)).find(item => item.number === number && item.language === 'python')
  const text = run?.code ? files[run.code] : undefined
  const result = run?.result ? parseRunResult(files[run.result] ?? '') : undefined
  if (!run?.code || text === undefined || !result) return { kind: 'engine' }
  if (result.tables.some(table => !run.tables.includes(table.file))) return { kind: 'engine' }
  if (result.plots.some(file => !run.plots.includes(file))) return { kind: 'engine' }
  const tables: ConversationRun['tables'] = []
  for (const file of run.tables) {
    const metadata = result.tables.find(table => table.file === file)
    const csv = files[file]
    if (!metadata || csv === undefined) return { kind: 'engine' }
    const table = parseCsv(csv, 10)
    tables.push({ file, columns: table.columns, rows: table.rows, rowCount: metadata.rowCount, columnCount: table.columns.length })
  }
  return {
    kind: 'run', number: run.number, author: parseRunHeader(text, 'python').author, language: 'python',
    code: codeBody(text, 'python'), running: result.status === 'running', tables,
    plots: run.plots.filter(file => result.plots.includes(file)), stdout: result.stdout,
    ...(result.error && { error: result.error.traceback || `${result.error.name}: ${result.error.message}` }),
  }
}
