import { parseCsv } from './conversation-model.js'

export function codeElements({ Code, Button, row, expansion, expand }) {
  const lines = row.code.split('\n')
  const full = expansion.code === true
  const source = full ? row.code : lines.slice(0, 40).join('\n')
  const pieces = []
  // The surface limits Code source to 10,000 characters per element.
  for (let offset = 0; offset < source.length; offset += 10000) {
    pieces.push(h(Code, { source: source.slice(offset, offset + 10000), language: row.language, wrap: 'wrap' }))
  }
  if (!full && lines.length > 40) pieces.push(h(Button, { key: 'full-code', label: 'full code', onPress: () => expand('code') }))
  return pieces
}

function tableMarkdown(table) {
  const clean = text => text.replaceAll('|', '\\|').replaceAll('\n', ' ')
  const line = cells => `| ${cells.map(clean).join(' | ')} |`
  return [line(table.columns), line(table.columns.map(() => '---')), ...table.rows.map(line)].join('\n')
}

export function tableElements({ Text, Markdown, Button, row, files, expansion, expand }) {
  const pieces = []
  for (const table of row.tables) {
    const saved = parseCsv(files[table.file] ?? '', Number.MAX_SAFE_INTEGER)
    const full = expansion[table.file] === true
    const shown = full ? { ...table, rows: saved.rows } : table
    pieces.push(h(Text, {}, `${table.rowCount} rows · ${table.columnCount} columns`))
    pieces.push(h(Markdown, { text: tableMarkdown(shown) }))
    if (!full && saved.rows.length > 10) {
      pieces.push(h(Button, { key: `all-rows:${table.file}`, label: 'all rows', onPress: () => expand(table.file) }))
    }
    if (saved.rows.length < table.rowCount) pieces.push(h(Text, {}, `${saved.rows.length} rows saved of ${table.rowCount}`))
  }
  return pieces
}

export function plotElements({ Text, Image, row, files, surface, columns }) {
  return row.plots.map(file => surface === 'terminal' && file.endsWith('.png')
    ? h(Image, { key: file, source: { file: files[file], format: 'png' }, columns: Math.max(1, Math.min(columns, 255)), rows: 20, alt: file })
    : h(Text, { wrap: 'wrap' }, file))
}

export function quietText(call) {
  const input = call.input && typeof call.input === 'object' ? call.input : {}
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.path ?? ''
  return `${call.tool} ${typeof detail === 'string' ? detail : ''}`.replace(/\s+/g, ' ').trim()
}
