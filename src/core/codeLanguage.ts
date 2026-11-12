// What a code view needs to know about text, without the editor: its language from a file name, and where a
// search text first matches.

export type CodeLanguage = 'sql' | 'python' | 'markdown'

const LANGUAGE_OF_EXTENSION: Record<string, CodeLanguage | undefined> = { sql: 'sql', py: 'python', md: 'markdown' }

/** The highlighting a file gets, by its extension. */
export function languageOfPath(path: string): CodeLanguage | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return Object.hasOwn(LANGUAGE_OF_EXTENSION, ext) ? LANGUAGE_OF_EXTENSION[ext] : undefined
}

/** The first case-insensitive match of `find` in `text`, as a selection; undefined when `find` is empty or absent. */
export function firstMatch(text: string, find: string | undefined): { anchor: number; head: number } | undefined {
  if (!find) return undefined
  const at = text.toLowerCase().indexOf(find.toLowerCase())
  return at < 0 ? undefined : { anchor: at, head: at + find.length }
}

/** The hover text of a SQL view's formatted / original toggle; none for other languages. */
export function sqlToggleTitle(language: CodeLanguage | undefined, original: boolean): string | undefined {
  if (language !== 'sql') return undefined
  return original ? 'Original text (o: formatted)' : 'Formatted (o: original text)'
}
