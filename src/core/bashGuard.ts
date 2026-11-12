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
  private isTarget = false
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
      case '>':
        return this.stepOutput(i)
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
    this.isTarget = this.text[last + 1] !== '('
    return last
  }

  /** `>`, `>>`, `>|`, `>&`, with a leading file descriptor: the next word is the target, not part of the command. `>(...)` is left alone. */
  private stepOutput(i: number): number {
    if (this.text[i + 1] === '(') {
      this.word += '>'
      this.isWord = true
      return i
    }
    if (/^\d+$/.test(this.word)) {
      this.word = ''
      this.isWord = false
    }
    this.endWord()
    let last = i
    while (['>', '|', '&'].includes(this.text[last + 1] ?? '')) last++
    this.isTarget = true
    return last
  }

  private endWord() {
    if (this.isWord && this.isTarget) this.isTarget = false
    else if (this.isWord) this.words.push(this.word)
    this.word = ''
    this.isWord = false
  }

  private endSegment(nextPiped: boolean, last = this.text.length): number {
    this.endWord()
    if (this.words.length > 0) this.segments.push({ words: this.words, isPiped: this.isPiped, hasRedirect: this.hasRedirect })
    this.words = []
    this.isPiped = nextPiped
    this.hasRedirect = false
    this.isTarget = false
    return last
  }
}

/** A command line split at `;`, `&&`, `||`, `|`, `&` and newlines into segments of words (quotes honoured), with heredoc bodies dropped. */
const shellSegments = (command: string): Segment[] => new SegmentReader(withoutHeredocBodies(command)).read()

// Ignoring case: macOS finds `Python` as `python`. `t` is the free-threaded build (python3.13t); py and pypy run code too.
const PYTHON_NAMES = [/^i?python[23]?(?:\.\d+)?t?$/i, /^(?:pypy[23]?(?:\.\d+)?|py)$/i]
const PYTHON_PROGRAM = { test: (word: string) => PYTHON_NAMES.some(name => name.test(word.split('/').at(-1) ?? '')) }
// Each wrapper that runs the command after it, with its options that take a value as the next word.
const WRAPPERS = new Map<string, ReadonlySet<string>>([
  ['env', new Set(['-u', '--unset', '-C', '--chdir'])],
  ['time', new Set(['-f', '--format', '-o', '--output'])],
  ['nohup', new Set()],
  ['exec', new Set(['-a'])],
  ['sudo', new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'])],
  ['command', new Set()],
  ['builtin', new Set()],
  ['nice', new Set(['-n', '--adjustment'])],
  ['stdbuf', new Set(['-i', '--input', '-o', '--output', '-e', '--error'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['caffeinate', new Set(['-t', '-w'])],
  ['flock', new Set(['-w', '--timeout', '-E', '--conflict-exit-code'])],
  ['arch', new Set()],
  ['watch', new Set(['-n', '--interval', '-d', '-q', '--equexit'])],
  ['xargs', new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'])],
])
// Wrappers whose first word after the options is theirs (a duration), not the command's.
const TAKES_OPERAND = new Set(['timeout', 'flock'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
// Words that start a compound command or negate one: what follows is the command.
const KEYWORDS = new Set(['!', '{', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])
// Standard modules that run the code they are given (`python -m runpy x.py`, `-m code`, `-m timeit 'stmt'`).
const CODE_MODULES = new Set(['runpy', 'code', 'IPython', 'idlelib', 'pdb', 'trace', 'cProfile', 'profile', 'timeit', 'ipykernel'])
// Programs whose subcommand runs a Python script or notebook.
const SCRIPT_RUNNERS = new Map([
  ['jupyter', new Set(['execute', 'run', 'nbconvert', 'console'])],
  ['streamlit', new Set(['run'])],
  ['marimo', new Set(['run', 'edit'])],
])

const INFO_FLAGS = new Set(['--version', '-V', '-VV', '--help', '-h'])

/** `-m` or `-mpytest`, but not a long option. */
const isModuleFlag = (arg: string) => arg === '-m' || (arg.startsWith('-m') && !arg.startsWith('--'))

/** `-c`, `-cCODE`, or short flags holding a `c` (`-Bc`). */
const isCodeFlag = (arg: string) =>
  arg === '-c' || (arg.startsWith('-c') && arg.length > 2 && !arg.startsWith('--')) || (/^-[A-Za-z]+$/.test(arg) && arg.includes('c'))

/** Whether python with these arguments (after the program) runs code: a script, `-c`, `-`, stdin. `-m`, `--version` and the like do not. */
function pythonRunsCode(args: readonly string[], isFed: boolean): boolean {
  for (const [i, arg] of args.entries()) {
    if (isModuleFlag(arg)) return CODE_MODULES.has(arg === '-m' ? (args[i + 1] ?? '') : arg.slice(2))
    if (INFO_FLAGS.has(arg)) return false
    if (isCodeFlag(arg) || arg === '-' || !arg.startsWith('-')) return true
  }
  return isFed
}

const basename = (path: string) => path.split('/').at(-1) ?? ''

/** The string of `--split-string=...` or `-S...`, or undefined. */
function attachedSplitString(option: string): string | undefined {
  if (option.startsWith('--split-string=')) return option.slice('--split-string='.length)
  return /^-S./.test(option) ? option.slice(2) : undefined
}

/** `env -S 'python x.py'` runs the words of its string: the words to look at then, or undefined for another option. */
function splitStringAt(words: readonly string[], at: number): readonly string[] | undefined {
  const option = words[at] ?? ''
  const separate = option === '-S' || option === '--split-string'
  const attached = attachedSplitString(option)
  if (!separate && attached === undefined) return undefined
  const text = separate ? (words[at + 1] ?? '') : (attached ?? '')
  return [...(shellSegments(text)[0]?.words ?? []), ...words.slice(separate ? at + 2 : at + 1)]
}

/** How many words an option takes: two when it, or the last of its combined short options (`-iu`), takes a value as the next word. */
function optionWidth(option: string, takesValue: ReadonlySet<string>): number {
  if (takesValue.has(option)) return 2
  if (option.startsWith('--')) return 1
  const letters = option.slice(1)
  const at = Array.from({ length: letters.length }, (_, k) => k).findIndex(k => takesValue.has(`-${letters.charAt(k)}`))
  return at === letters.length - 1 ? 2 : 1
}

/** The words after a wrapper's own options (and its operand, for `timeout`). */
function afterWrapper(wrapper: string, words: readonly string[]): readonly string[] {
  const takesValue = WRAPPERS.get(wrapper) ?? new Set<string>()
  let at = 0
  while (words[at]?.startsWith('-')) {
    const option = words[at] ?? ''
    if (option === '--') {
      at++
      break
    }
    const split = wrapper === 'env' ? splitStringAt(words, at) : undefined
    if (split) return split
    at += optionWidth(option, takesValue)
  }
  return words.slice(TAKES_OPERAND.has(wrapper) ? at + 1 : at)
}

/** The words after leading VAR=value words and wrappers (env, time, sudo, nice, timeout, ...) and their options. */
function withoutPrefixes(all: readonly string[]): readonly string[] {
  let words = all
  for (;;) {
    const first = words[0] ?? ''
    const wrapper = basename(first)
    if (/^[A-Za-z_]\w*=/.test(first) || KEYWORDS.has(first)) words = words.slice(1)
    else if (first.startsWith('(') || first.startsWith('{')) words = [first.slice(1), ...words.slice(1)].filter(Boolean)
    else if (WRAPPERS.has(wrapper)) words = afterWrapper(wrapper, words.slice(1))
    else return words
  }
}

// Nesting the parser follows; anything deeper counts as Python, so the guard fails closed.
const MAX_DEPTH = 8
// A script the parser reads as Python, standing for a construct it cannot follow.
const TOO_DEEP = 'python -c 1'

/** Whether a script given as text runs Python; a script nested deeper than the parser follows counts as running it. */
const scriptRunsPython = (script: string, depth: number) =>
  depth >= MAX_DEPTH || shellSegments(script).some(inner => segmentRunsPython(inner, depth + 1))

/**
 * The script of `bash -c '<script>'` (`-lc`, `-c --` too) or `eval ...`, or of a quoted command a wrapper runs through
 * a shell (`watch 'python x.py'`); undefined when the words are not that.
 */
function scriptOf(program: string, args: readonly string[]): string | undefined {
  const name = basename(program)
  if (name === 'eval') return args.join(' ')
  if (/\s/.test(program)) return [program, ...args].join(' ')
  if (!SHELLS.has(name)) return undefined
  const flag = args.findIndex(arg => /^-[A-Za-z]+$/.test(arg) && arg.includes('c'))
  if (flag < 0) return undefined
  const rest = args.slice(flag + 1)
  return rest[0] === '--' ? rest[1] : rest[0]
}

/** Whether `uv run` or `uvx` runs Python code: python given code, or a `.py` script. Undefined when the words are not that. */
function uvRunsPython(program: string, args: readonly string[], isFed: boolean): boolean | undefined {
  const name = basename(program)
  if (name !== 'uvx' && !(name === 'uv' && (args.includes('run') || args.includes('tool')))) return undefined
  const subcommand = args.includes('run') ? 'run' : 'tool'
  const rest = name === 'uvx' ? args : args.slice(args.indexOf(subcommand) + 1)
  if (rest.some(word => word.endsWith('.py'))) return true
  const at = rest.findIndex(word => PYTHON_PROGRAM.test(word))
  return at >= 0 && pythonRunsCode(rest.slice(at + 1), isFed)
}

/** Whether a program's subcommand runs a script or notebook (`jupyter execute`, `streamlit run`). */
const runnerRunsScript = (program: string, args: readonly string[]) => SCRIPT_RUNNERS.get(basename(program))?.has(args[0] ?? '') ?? false

/** The command `find ... -exec <command> ;` runs, or undefined when the words are not that. */
function findExecWords(program: string, args: readonly string[]): string[] | undefined {
  if (basename(program) !== 'find') return undefined
  const at = args.findIndex(arg => arg === '-exec' || arg === '-execdir' || arg === '-ok' || arg === '-okdir')
  return at < 0 ? undefined : args.slice(at + 1)
}

function segmentRunsPython(segment: Segment, depth = 0): boolean {
  const [program = '', ...args] = withoutPrefixes(segment.words)
  // xargs hands the program its input as arguments.
  const isFed = segment.isPiped || segment.hasRedirect || segment.words.some(word => basename(word) === 'xargs')
  const script = scriptOf(program, args)
  if (script !== undefined) return scriptRunsPython(script, depth)
  const executed = findExecWords(program, args)
  if (executed && depth >= MAX_DEPTH) return true
  if (executed) return segmentRunsPython({ words: executed, isPiped: false, hasRedirect: false }, depth + 1)
  const viaUv = uvRunsPython(program, args, isFed)
  if (viaUv !== undefined) return viaUv
  return runnerRunsScript(program, args) || (PYTHON_PROGRAM.test(program) && pythonRunsCode(args, isFed))
}

/** The commands inside `$(...)`, `<(...)`, `>(...)` and backticks, innermost first, as text. */
function substitutions(command: string): string[] {
  const found: string[] = []
  let text = command
  for (let pass = 0; pass < MAX_DEPTH; pass++) {
    const inner = [...text.matchAll(/[$<>]\(([^()]*)\)|`([^`]*)`/g)]
    if (inner.length === 0) break
    for (const match of inner) found.push(match[1] ?? match[2] ?? '')
    text = text.replace(/[$<>]\(([^()]*)\)|`([^`]*)`/g, ' x ')
  }
  // Still nested after the last pass: the guard cannot follow it, so it counts as Python.
  if (/[$<>]\([^()]*\)|`[^`]*`/.test(text)) found.push(TOO_DEEP)
  return found
}

/** A program named by a variable or a substitution, in a command that mentions Python: `p=python; $p x.py`. */
const runsNamedPython = (command: string) =>
  /python|pypy/i.test(command) && shellSegments(command).some(segment => /^[$`]/.test(withoutPrefixes(segment.words)[0] ?? ''))

/**
 * Whether a Bash command runs Python code: `python`, `python3`, `python3.N`, `ipython`, a path ending in
 * `/python` or `/python3`, or `uv run python`, given a script, `-c`, `-`, a heredoc or a redirect, or fed by a pipe.
 * `python -m ...` (pytest, pip), `python --version`, `pytest` and package commands are not.
 */
export const bashRunsPython = (command: string): boolean =>
  shellSegments(command).some(segment => segmentRunsPython(segment)) || substitutions(command).some(inner => scriptRunsPython(inner, 0)) || runsNamedPython(command)
