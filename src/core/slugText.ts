// Text trimming for slugs and paths, in loops: a regex like /-+$/ backtracks quadratically on a long run.

/** `text` without the `char`s at its end. */
export function trimEndChar(text: string, char: string): string {
  let end = text.length
  while (end > 0 && text[end - 1] === char) end--
  return text.slice(0, end)
}

/** Lower case, each run of characters other than a-z and 0-9 as one dash, no dash at either end, at most `maxLength` characters. */
export function kebabCase(text: string, maxLength: number): string {
  const dashed = text.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  // Runs collapse to one dash, so at most one leads.
  const withoutLeading = dashed.startsWith('-') ? dashed.slice(1) : dashed
  return trimEndChar(trimEndChar(withoutLeading, '-').slice(0, maxLength), '-')
}
