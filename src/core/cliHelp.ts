// What `assay --help` says, and which command the arguments ask for. The CLI adapter (src/cli) prints it.

export type CliVerb = 'help' | 'version' | 'open' | 'new' | 'usage'

export const USAGE = 'Usage: assay open [name] | assay new <title>\nRun assay --help for what each does.'

/** A help or version flag wins wherever it appears; no arguments at all ask for help. */
export function cliVerb(args: readonly string[]): CliVerb {
  if (args.length === 0 || args.some(arg => ['help', '--help', '-h'].includes(arg))) return 'help'
  if (args.some(arg => ['version', '--version', '-v'].includes(arg))) return 'version'
  const [verb, ...rest] = args
  if (verb === 'open' && rest.length <= 1) return 'open'
  if (verb === 'new' && rest.length > 0) return 'new'
  return 'usage'
}

export function helpText({ version, root }: { version: string; root?: string }): string {
  return `assay ${version}: work on an Assay analysis with Claude Code in this terminal.

Usage:
  assay open [name]   Start Claude in an analysis
  assay new <title>   Create an analysis, then start Claude in it
  assay --help        Show this help (also: assay help, -h)
  assay --version     Print the Assay version this command runs (also: -v)

assay open [name]
  name is the analysis's folder (quarantine-checks) or its title in any case
  ("Quarantine Checks"). With no name, or one that matches nothing, it opens
  a picker: the analyses, most recently changed first, searched fuzzily from
  the name as you type. Up/Down move, Enter opens, Esc cancels; the last row
  creates a new analysis titled what you typed. When output is not a
  terminal, it prints the folder names instead, or fails naming them.

assay new <title>
  Creates analyses/<slug>/analysis.yaml under your root, as the app's picker
  does, then opens it. Words need no quotes: assay new Panel churn Q4.
  Nothing is written when the launch could not follow.

What a launch does
  Claude replaces this command in this terminal, in the analysis folder,
  with the same tools, hooks and recorded runs as the app. The first launch
  after an app update installs that version's backend and builds its Python
  environment with uv (about a minute). The app need not be open.

Before you start
  - Choose your Assay root once, in the app's Settings (Cmd+,).
  - Close the app's session of an analysis before opening it here: one
    server owns an analysis at a time.
  - Trust review happens only in the app.
  - Needs Node 22.15 or later, and uv, on PATH.

Environment
  ASSAY_CLAUDE_BIN   The command that starts Claude (default: claude), such
                     as a sandbox wrapper
  ASSAY_THEME        light-ansi for a light terminal; otherwise dark-ansi

Root: ${root ?? "not set: choose one in the app's Settings"}

Examples
  assay open
  assay open "Quarantine Checks"
  assay new Panel churn Q4
  ASSAY_THEME=light-ansi assay open increase-rpi`
}
