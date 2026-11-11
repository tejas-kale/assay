// The Bash guard, ported from the analysis mod's hooks/model.ts: Claude runs Python with the python tool, not
// through Bash.
import { toolName } from './rules.ts'

export const BASH_PYTHON_DENY =
  `Run Python with ${toolName('python')}: it runs in the kernel the user sees, and every run is saved. pytest and package commands stay allowed.`

type Segment = { words: string[]; isPiped: boolean; hasRedirect: boolean }

const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/

/** The command's lines without heredoc bodies: after a `<<WORD` line, everything up to the line that is WORD. */
function withoutHeredocBodies(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    kept.push(line)
    const heredoc = HEREDOC_START.exec(line)
    if (heredoc && !line.includes('<<<')) {
      while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() !== heredoc[2]) i++
      i++
    }
  }
  return kept.join('\n')
}

/** Reads the text one character at a time; `step` returns the index of the last character it consumed. */
class SegmentReader {
  private readonly segments: Segment[] = []
  private words: string[] = []
  private word = ''
  private isWord = false
  private isPiped = false
  private hasRedirect = false
  private quote = ''
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  read(): Segment[] {
    for (let i = 0; i < this.text.length; i++) i = this.step(i)
    this.endSegment(false)
    return this.segments
  }

  private step(i: number): number {
    const char = this.text[i] ?? ''
    return this.quote ? this.stepQuoted(i, char) : this.stepBare(i, char)
  }

  private stepQuoted(i: number, char: string): number {
    if (char === this.quote) this.quote = ''
    else if (char === '\\' && this.quote === '"') return this.addEscaped(i)
    else this.word += char
    return i
  }

  private addEscaped(i: number): number {
    this.word += this.text[i + 1] ?? ''
    return i + 1
  }

  private stepBare(i: number, char: string): number {
    switch (char) {
      case "'":
      case '"':
        this.quote = char
        this.isWord = true
        return i
      case '\\':
        this.isWord = true
        return this.addEscaped(i)
      case '|':
        return this.stepPipe(i)
      case '&':
        if (this.text[i + 1] !== '&') return this.endSegment(false, i)
        return this.endSegment(false, i + 1)
      case ';':
      case '\n':
        return this.endSegment(false, i)
      case ' ':
      case '\t':
        this.endWord()
        return i
      case '<':
        return this.stepRedirect(i)
      default:
        this.word += char
        this.isWord = true
        return i
    }
  }

  /** `|` feeds the next segment; `||` does not. */
  private stepPipe(i: number): number {
    const last = this.text[i + 1] === '|' ? i + 1 : i
    return this.endSegment(this.text[last] === '|' && this.text[last - 1] !== '|', last)
  }

  /** `< file` and `<<` feed the program: a redirect; `<(...)` is left alone. */
  private stepRedirect(i: number): number {
    this.endWord()
    this.hasRedirect = true
    let last = i
    while (this.text[last + 1] === '<') last++
    return last
  }

  private endWord() {
    if (this.isWord) this.words.push(this.word)
    this.word = ''
    this.isWord = false
  }

  private endSegment(nextPiped: boolean, last = this.text.length): number {
    this.endWord()
    if (this.words.length > 0) this.segments.push({ words: this.words, isPiped: this.isPiped, hasRedirect: this.hasRedirect })
    this.words = []
    this.isPiped = nextPiped
    this.hasRedirect = false
    return last
  }
}

/** A command line split at `;`, `&&`, `||`, `|`, `&` and newlines into segments of words (quotes honoured), with heredoc bodies dropped. */
const shellSegments = (command: string): Segment[] => new SegmentReader(withoutHeredocBodies(command)).read()

const PYTHON_PROGRAM = /^(?:.*\/)?(?:python|python3(?:\.\d+)?|python2(?:\.\d+)?|ipython3?)$/
const WRAPPERS = new Set(['env', 'time', 'nohup', 'exec', 'sudo', 'command', 'nice', 'builtin', 'stdbuf'])
const SHELLS = new Set(['sh', 'bash', 'zsh'])

const INFO_FLAGS = new Set(['--version', '-V', '-VV', '--help', '-h'])

/** `-m` or `-mpytest`, but not a long option. */
const isModuleFlag = (arg: string) => arg === '-m' || (arg.startsWith('-m') && !arg.startsWith('--'))

/** `-c`, `-cCODE`, or short flags holding a `c` (`-Bc`). */
const isCodeFlag = (arg: string) =>
  arg === '-c' || (arg.startsWith('-c') && arg.length > 2 && !arg.startsWith('--')) || (/^-[A-Za-z]+$/.test(arg) && arg.includes('c'))

/** Whether python with these arguments (after the program) runs code: a script, `-c`, `-`, stdin. `-m`, `--version` and the like do not. */
function pythonRunsCode(args: readonly string[], isFed: boolean): boolean {
  for (const arg of args) {
    if (isModuleFlag(arg) || INFO_FLAGS.has(arg)) return false
    if (isCodeFlag(arg) || arg === '-' || !arg.startsWith('-')) return true
  }
  return isFed
}

const basename = (path: string) => path.split('/').at(-1) ?? ''

/** The words after leading VAR=value words and wrappers (env, time, sudo, ...) and their flags. */
function withoutPrefixes(all: readonly string[]): readonly string[] {
  let words = all
  for (;;) {
    const first = words[0] ?? ''
    if (/^[A-Za-z_]\w*=/.test(first)) words = words.slice(1)
    else if (WRAPPERS.has(basename(first))) {
      words = words.slice(1)
      while (words[0]?.startsWith('-')) words = words.slice(1)
    } else if (first === 'timeout' || first.endsWith('/timeout')) words = words.slice(2)
    else return words
  }
}

/** Whether `bash -c '<script>'` (up to three shells deep) runs Python; undefined when the words are not that. */
function shellScriptRunsPython(program: string, args: readonly string[], depth: number): boolean | undefined {
  if (!SHELLS.has(basename(program)) || depth >= 3) return undefined
  const script = args[args.indexOf('-c') + 1]
  if (!args.includes('-c') || script === undefined) return undefined
  return shellSegments(script).some(inner => segmentRunsPython(inner, depth + 1))
}

function segmentRunsPython(segment: Segment, depth = 0): boolean {
  const [program = '', ...args] = withoutPrefixes(segment.words)
  const isFed = segment.isPiped || segment.hasRedirect
  const viaShell = shellScriptRunsPython(program, args, depth)
  if (viaShell !== undefined) return viaShell
  if ((program === 'uv' || program.endsWith('/uv')) && args.includes('run')) {
    const rest = args.slice(args.indexOf('run') + 1)
    const at = rest.findIndex(word => PYTHON_PROGRAM.test(word))
    return at >= 0 && pythonRunsCode(rest.slice(at + 1), isFed)
  }
  return PYTHON_PROGRAM.test(program) && pythonRunsCode(args, isFed)
}

/**
 * Whether a Bash command runs Python code: `python`, `python3`, `python3.N`, `ipython`, a path ending in
 * `/python` or `/python3`, or `uv run python`, given a script, `-c`, `-`, a heredoc or a redirect, or fed by a pipe.
 * `python -m ...` (pytest, pip), `python --version`, `pytest` and package commands are not.
 */
export const bashRunsPython = (command: string) => shellSegments(command).some(segment => segmentRunsPython(segment))
