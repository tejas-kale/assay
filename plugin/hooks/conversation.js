import { callRunNumber, conversationRow, parseRuns } from './conversation-model.js'
import { visidataButton, visidataCommand } from './conversation-clipboard.js'
import { bashKeyValues, codeElements, keyValueElement, tableElements, plotElements, quietText } from './conversation-view.js'

async function queryFolder($) {
  const analysis = await $.env.get('ASSAY_ANALYSIS')
  if (!analysis) return undefined
  const root = await $.fs.stat(analysis, { resolve: true })
  const folder = await $.fs.stat(`${analysis}/queries`, { resolve: true })
  if (!root.realPath || folder.realPath !== `${root.realPath}/queries`) return undefined
  return folder.realPath
}

async function runFiles($, call) {
  const number = callRunNumber(call)
  if (number === undefined || call.isRunning) return {}
  const folder = await queryFolder($)
  if (!folder) return {}
  const names = (await $.fs.list(folder)).map(entry => entry.name)
  const run = parseRuns(names).find(item => item.number === number)
  if (!run) return {}
  const files = {}
  for (const name of [run.code, run.data, run.result, ...run.tables, ...run.plots].filter(Boolean)) {
    const stat = await $.fs.stat(`${folder}/${name}`, { resolve: true })
    if (stat.kind !== 'file' || stat.realPath !== `${folder}/${name}`) return {}
    files[name] = run.plots.includes(name) ? stat.realPath : await $.fs.read(stat.realPath)
  }
  return files
}

async function expandRow($, id, key) {
  const ref = { plugin: 'assay', key: 'expansion', id }
  const { value = {} } = await $.state.get(ref)
  await $.state.set(ref, { ...value, [key]: true })
}

async function drawRun($, e, { row, engine, files }) {
  const { Box, Text, Code, Markdown, Button, Image } = $.ui.resolve(e)
  const { value = {} } = await $.state.get({ plugin: 'assay', key: 'expansion', id: e.props.tool_use_id })
  const expansion = e.props.isExpanded ? { ...value, code: true, ...Object.fromEntries(row.tables.map(table => [table.file, true])) } : value
  const expand = key => expandRow($, e.props.tool_use_id, key)
  const language = row.language === 'python' ? 'Python' : 'SQL'
  const title = row.running ? `${language} running` : `Run ${row.number} · ${row.author}`
  const pieces = [engine, h(Text, {}, title)]
  pieces.push(...codeElements({ Code, Button, row, expansion, expand }))
  if (row.stdout) pieces.push(h(Text, { wrap: 'wrap' }, row.stdout))
  if (row.error) pieces.push(h(Text, { wrap: 'wrap' }, row.error))
  pieces.push(...tableElements({ Text, Markdown, Button, row, files, expansion, expand }))
  for (const [index, table] of row.tables.entries()) {
    pieces.push(visidataButton({ Button, file: table.file, index, copy: (file, surface) => copyTable($, file, surface) }))
  }
  pieces.push(...plotElements({ Text, Image, row, files, surface: e.surface, columns: e.viewport?.columns ?? 80 }))
  return h(Box, { flexDirection: 'column', width: e.viewport?.columns ?? 80 }, ...pieces)
}

async function drawQuiet($, e, next) {
  if (e.props.isExpanded !== false || e.props.isErrored || e.props.isInterrupted) return drawExpanded($, e, next)
  const { value = {} } = await $.state.get({ plugin: 'assay', key: 'expansion', id: e.props.tool_use_id })
  if (value.details) return drawExpanded($, e, next)
  const { Box, Text, Button } = $.ui.resolve(e)
  return h(Box, { flexDirection: 'row', width: e.viewport?.columns ?? 80 },
    h(Text, { wrap: 'truncate' }, `${e.props.isRunning ? 'Running · ' : ''}${quietText(e.props)}`),
    h(Button, { key: 'details', label: 'details', onPress: () => expandRow($, e.props.tool_use_id, 'details') }))
}

/** An expanded call; Bash output that reads as `key: value` lines is drawn in colour in place of the engine's. */
async function drawExpanded($, e, next) {
  const lines = bashKeyValues(e.props)
  if (!lines) return next(e)
  const { Box, Text } = $.ui.resolve(e)
  const row = await next({ ...e, props: { ...e.props, output: undefined } })
  return h(Box, { flexDirection: 'column' }, row, keyValueElement({ Box, Text, lines }))
}

const RUN_TOOLS = new Set(['mcp__assay__sql', 'mcp__assay__python'])

function drawNote($, e, row, engine) {
  const { Box, Text, Code, Markdown } = $.ui.resolve(e)
  const pieces = [engine]
  if (row.kind === 'note') pieces.push(h(Markdown, { text: row.markdown }))
  if (row.kind === 'noteDiff' && row.hunks.length > 0 && row.diff.length <= 10000) {
    pieces.push(h(Text, { dimColor: true }, 'Replacement excerpt'))
    pieces.push(h(Code, { source: row.diff, format: 'diff', wrap: 'wrap' }))
  } else if (row.kind === 'noteDiff' && row.diff !== row.text) {
    pieces.push(h(Text, { wrap: 'wrap' }, row.diff))
  }
  pieces.push(h(Text, { wrap: 'wrap' }, row.text))
  return h(Box, { flexDirection: 'column', width: e.viewport?.columns ?? 80 }, ...pieces)
}

export function register(on) {
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (['Read', 'Grep', 'Glob', 'Bash'].includes(e.props.tool)) return drawQuiet($, e, next)
    if (!e.props.tool.startsWith('mcp__assay__')) return next(e)
    const files = await runFiles($, e.props).catch(() => ({}))
    const row = conversationRow(e.props, files)
    if (row.kind === 'engine') return next(e)
    // Older surfaces omit expansion state; preserve their engine row as a fallback.
    const engine = e.props.isExpanded === false ? undefined : await next(e)
    return row.kind === 'run' ? drawRun($, e, { row, engine, files }) : drawNote($, e, row, engine)
  })
  // Claude Code folds runs of calls into one line ("Called assay 3 times"); a run with a sql or python call is shown
  // call by call, so its rich rows are on screen without ctrl+o.
  on('ui.render', { component: 'ToolGroup' }, (_$, e, next) =>
    e.props.isExpanded || !e.props.calls.some(call => RUN_TOOLS.has(call.tool)) ? next(e) : next({ ...e, props: { ...e.props, isExpanded: true } }))
  // The ToolUse row draws Bash output it colours, so the result block after it draws nothing; output shows once.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => (bashKeyValues(e.props) ? h($.ui.resolve(e).Box, null) : next(e)))
}

async function copyTable($, file, surface) {
  try {
    const folder = await queryFolder($)
    if (!folder) throw new Error('The open analysis is unavailable')
    const path = `${folder}/${file}`
    const table = await $.fs.stat(path, { resolve: true })
    if (table.kind !== 'file' || table.realPath !== path) throw new Error('The table is outside the open analysis')
    const result = await $.ui.copy({ text: visidataCommand(path), surface })
    $.ui.toast(result.isCopied ? 'Copied VisiData command' : `Could not copy VisiData command: ${result.reason ?? 'clipboard unavailable'}`)
  } catch (error) {
    $.ui.toast(`Could not copy VisiData command: ${error instanceof Error ? error.message : 'clipboard unavailable'}`)
  }
}

