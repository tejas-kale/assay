// The Bash guard, ported from the analysis mod's hooks/model.ts: Claude runs Python with the python tool, not
// through Bash.
import { toolName } from './rules.ts'

export const BASH_PYTHON_DENY =
  `Run Python with ${toolName('python')}: it runs in the kernel the user sees, and every run is saved. pytest and package commands stay allowed.`

type Segment = { words: string[]; isPiped: boolean; hasRedirect: boolean }

/** A command line split at `;`, `&&`, `||`, `|`, `&` and newlines into segments of words (quotes honoured), with heredoc bodies dropped. */
function shellSegments(command: string): Segment[] {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    kept.push(line)
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/.exec(line)
    if (heredoc && !line.includes('<<<')) {
      while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() !== heredoc[2]) i++
      i++
    }
  }
  const segments: Segment[] = []
  let words: string[] = []
  let word = ''
  let isWord = false
  let isPiped = false
  let hasRedirect = false
  let quote = ''
  const endWord = () => {
    if (isWord) words.push(word)
    word = ''
    isWord = false
  }
  const endSegment = (nextPiped: boolean) => {
    endWord()
    if (words.length > 0) segments.push({ words, isPiped, hasRedirect })
    words = []
    isPiped = nextPiped
    hasRedirect = false
  }
  const text = kept.join('\n')
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    if (quote) {
      if (char === quote) quote = ''
      else if (char === '\\' && quote === '"') word += text[++i] ?? ''
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      isWord = true
    } else if (char === '\\') {
      word += text[++i] ?? ''
      isWord = true
    } else if (char === '|') {
      if (text[i + 1] === '|') i++
      endSegment(text[i] === '|' && text[i - 1] !== '|')
    } else if (char === '&' && text[i + 1] === '&') {
      i++
      endSegment(false)
    } else if (char === ';' || char === '\n' || char === '&') endSegment(false)
    else if (char === ' ' || char === '\t') endWord()
    else if (char === '<') {
      // `< file` and `<<` feed the program: a redirect; `<(...)` is left alone.
      endWord()
      hasRedirect = true
      while (text[i + 1] === '<') i++
    } else {
      word += char
      isWord = true
    }
  }
  endSegment(false)
  return segments
}

const PYTHON_PROGRAM = /^(?:.*\/)?(?:python|python3(?:\.\d+)?|python2(?:\.\d+)?|ipython3?)$/
const WRAPPERS = new Set(['env', 'time', 'nohup', 'exec', 'sudo', 'command', 'nice', 'builtin', 'stdbuf'])
const SHELLS = new Set(['sh', 'bash', 'zsh'])

/** Whether python with these arguments (after the program) runs code: a script, `-c`, `-`, stdin. `-m`, `--version` and the like do not. */
function pythonRunsCode(args: readonly string[], isFed: boolean): boolean {
  for (const arg of args) {
    if (arg === '-m' || (arg.startsWith('-m') && !arg.startsWith('--'))) return false
    if (arg === '--version' || arg === '-V' || arg === '-VV' || arg === '--help' || arg === '-h') return false
    if (arg === '-c' || (arg.startsWith('-c') && arg.length > 2 && !arg.startsWith('--'))) return true
    if (arg === '-') return true
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return true
    if (!arg.startsWith('-')) return true
  }
  return isFed
}

function segmentRunsPython(segment: Segment, depth = 0): boolean {
  let words = segment.words
  // Leading VAR=value words and wrappers (env, time, sudo, ...).
  for (;;) {
    const first = words[0] ?? ''
    if (/^[A-Za-z_]\w*=/.test(first)) words = words.slice(1)
    else if (WRAPPERS.has(first.split('/').at(-1) ?? '')) {
      words = words.slice(1)
      while (words[0]?.startsWith('-')) words = words.slice(1)
    }
    else if (first === 'timeout' || first.endsWith('/timeout')) words = words.slice(2)
    else break
  }
  const [program = '', ...args] = words
  if (SHELLS.has(program.split('/').at(-1) ?? '') && depth < 3) {
    const at = args.indexOf('-c')
    if (at >= 0 && args[at + 1] !== undefined) return shellSegments(args[at + 1] ?? '').some(inner => segmentRunsPython(inner, depth + 1))
  }
  if ((program === 'uv' || program.endsWith('/uv')) && args.includes('run')) {
    const rest = args.slice(args.indexOf('run') + 1)
    const at = rest.findIndex(word => PYTHON_PROGRAM.test(word))
    return at >= 0 && pythonRunsCode(rest.slice(at + 1), segment.isPiped || segment.hasRedirect)
  }
  if (PYTHON_PROGRAM.test(program)) return pythonRunsCode(args, segment.isPiped || segment.hasRedirect)
  return false
}

/**
 * Whether a Bash command runs Python code: `python`, `python3`, `python3.N`, `ipython`, a path ending in
 * `/python` or `/python3`, or `uv run python`, given a script, `-c`, `-`, a heredoc or a redirect, or fed by a pipe.
 * `python -m ...` (pytest, pip), `python --version`, `pytest` and package commands are not.
 */
export const bashRunsPython = (command: string) => shellSegments(command).some(segment => segmentRunsPython(segment))
