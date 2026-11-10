export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A word as sh reads it back unchanged: as it is when it is plain, else in single quotes. */
export const shellQuote = (word: string) => (/^[\w./:@%+=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)
