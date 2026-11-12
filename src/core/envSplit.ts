// The string of `env -S`, split the way env splits it: not by the shell. `;`, `|` and `&` are plain characters there.

const ESCAPES = new Map([['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'], ['\\', '\\'], ['#', '#'], ['$', '$'], ['"', '"'], ["'", "'"]])

/** Reads the string one character at a time; `step` returns the index of the last character it consumed, or -1 to stop. */
class EnvSplitter {
  readonly words: string[] = []
  isBroken = false
  private word = ''
  private isWord = false
  private quote = ''

  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  run(): void {
    let at = 0
    while (at >= 0 && at < this.text.length && !this.isBroken) {
      const last = this.quote ? this.stepQuoted(at) : this.stepBare(at)
      at = last < 0 ? last : last + 1
    }
    if (this.quote) this.isBroken = true
    this.endWord()
  }

  private endWord() {
    if (this.isWord) this.words.push(this.word)
    this.word = ''
    this.isWord = false
  }

  private add(text: string) {
    this.word += text
    this.isWord = true
  }

  private stepBare(i: number): number {
    const char = this.text[i] ?? ''
    if (char === "'" || char === '"') {
      this.quote = char
      this.isWord = true
    } else if (char === '\\') return this.stepEscape(i, false)
    else if (char === '$') this.isBroken = true
    else if (char === '#' && !this.isWord) return -1
    else if (/\s/.test(char)) this.endWord()
    else this.add(char)
    return i
  }

  private stepQuoted(i: number): number {
    const char = this.text[i] ?? ''
    if (char === this.quote) this.quote = ''
    else if (char === '\\') return this.stepEscape(i, true)
    else if (char === '$' && this.quote === '"') this.isBroken = true
    else this.add(char)
    return i
  }

  /** `\c` ends the string; `\_` is a space in double quotes and ends the word outside quotes; other escapes are listed; the rest cannot be followed. */
  private stepEscape(i: number, isQuoted: boolean): number {
    const next = this.text[i + 1] ?? ''
    const plain = ESCAPES.get(next)
    if (this.quote === "'" && next !== '\\' && next !== "'") {
      this.add('\\')
      return i
    }
    if (next === 'c' && !isQuoted) return -1
    if (next === '_') {
      if (isQuoted) this.add(' ')
      else this.endWord()
    } else if (plain !== undefined) this.add(plain)
    else this.isBroken = true
    return i + 1
  }
}

/** The words of an `env -S` string, or undefined when it cannot be followed (a `${VAR}` expansion, a bad escape, an open quote). */
export function envSplitWords(text: string): string[] | undefined {
  const splitter = new EnvSplitter(text)
  splitter.run()
  return splitter.isBroken ? undefined : splitter.words
}
