// How a shell command's `key: value` output is coloured in Claude's transcript (plugin/hooks/conversation.js draws it).
// Only the display changes: Claude reads the command's plain output.

export type Tone = 'heading' | 'key' | 'type' | 'number' | 'literal' | 'time' | 'muted'
/** A run of a line's text; no tone draws it as plain text. */
export type Span = { text: string; tone?: Tone }

const HEADING = /^\s*(?:[A-Z][A-Z0-9 _-]*|Row \d+):$/
const KEY_VALUE = /^(\s*)([A-Za-z_][\w.-]*):(?: (.*))?$/
const SQL_TYPES = new Set(['string', 'int', 'integer', 'bigint', 'smallint', 'tinyint', 'boolean', 'double', 'float', 'date', 'timestamp', 'timestamp_ntz', 'binary', 'void'])
const NESTED_TYPE = /^(?:struct|array|map)<.*>$/
const DECIMAL_TYPE = /^decimal\(\d+, ?\d+\)$/
const NUMBER = /^-?\d+(?:\.\d+)?$/
const LITERAL = /^(?:true|false|null|NULL|None)$/
const TIME = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?$/

/** The tone of a value; undefined draws it plain. */
export function valueTone(value: string): Tone | undefined {
  if (SQL_TYPES.has(value) || NESTED_TYPE.test(value) || DECIMAL_TYPE.test(value)) return 'type'
  if (NUMBER.test(value)) return 'number'
  if (LITERAL.test(value)) return 'literal'
  if (TIME.test(value)) return 'time'
  return value.startsWith('{') || value.startsWith('[') ? 'muted' : undefined
}

type Line = { spans: Span[]; isKeyValue: boolean }

function lineSpans(line: string): Line {
  if (HEADING.test(line)) return { spans: [{ text: line, tone: 'heading' }], isKeyValue: false }
  const found = KEY_VALUE.exec(line)
  if (!found) return { spans: line === '' ? [] : [{ text: line }], isKeyValue: false }
  const [, indent = '', key = '', value = ''] = found
  const spans: Span[] = [{ text: indent }, { text: key, tone: 'key' }, { text: ':' }]
  if (value !== '') spans.push({ text: ' ' }, { text: value, tone: valueTone(value) })
  return { spans: spans.filter(span => span.text !== '' || span.tone !== undefined), isKeyValue: true }
}

/**
 * The output's lines as coloured spans when it reads as `key: value` lines (a schema, a record, YAML-like settings):
 * at least three of them, and at least three in five of its non-blank lines. Undefined otherwise, so other output
 * keeps its usual look.
 */
export function keyValueLines(output: string): Span[][] | undefined {
  const lines = output.trimEnd().split('\n').map(lineSpans)
  const keyValues = lines.filter(line => line.isKeyValue).length
  const nonBlank = lines.filter(line => line.spans.length > 0).length
  return keyValues >= 3 && keyValues * 5 >= nonBlank * 3 ? lines.map(line => line.spans) : undefined
}

/** The lines a collapsed result shows, and how many it leaves for the expanded view. */
export function collapsed<T>(lines: readonly T[], limit: number): { shown: T[]; hidden: number } {
  return lines.length <= limit ? { shown: [...lines], hidden: 0 } : { shown: lines.slice(0, limit), hidden: lines.length - limit }
}
