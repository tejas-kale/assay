// The rules on each of the user's prompts, ported from the analysis mod's hooks/model.ts (analysisRules,
// runNotice) and hooks/trust.ts (trustRules, calculationRules). The UserPromptSubmit hook sends them.
import type { CalculationList } from './calculations.ts'
import { blockSignature, DICTIONARIES, PROPOSE_SKILL, TRUST_TAB, TRUSTED, signature } from './calculations.ts'
import { queryLabel } from './pythonRuns.ts'

/**
 * The name Claude sees for one of the server's tools. Claude Code names a plugin's MCP tools
 * `mcp__plugin_<plugin>_<server>__<tool>`; plugin and server are both `assay`.
 */
export const toolName = (tool: string) => `mcp__plugin_assay_assay__${tool}`

/** The one line every tool answers when Assay did not start the session (no ASSAY_ANALYSIS or ASSAY_ROOT). */
export const NOT_ASSAY = 'Assay did not start this session: there is no analysis to work in. Open the analysis in the Assay app.'

/** The venv the tools run with: a Podman volume built on the Mac. */
export const VENV_ASSAY = '/opt/venv-assay'
export const VENV_ASSAY_COMMAND = 'claude-pkg venv-assay'
export const VENV_ASSAY_HINT = `venv-assay is not built. On the Mac, run: ${VENV_ASSAY_COMMAND}`

/** The open analysis as the prompt names it: its title and its folder from the root (`analyses/<slug>`). */
export type OpenAnalysis = { title: string; folder: string }

/** The rules for a prompt in an analysis; `python` is the kernel's, when found, `folder` the open analysis's. */
export const analysisRules = (python: string | undefined, folder: string) =>
  [
    'Analysis reply rules: answer one concept per reply, in a few short lines.',
    'If this prompt asks several questions, answer only the first and name the others in one line at the end of the reply.',
    `Park a thread with ${toolName('park')} only for a ruling a person must make, saying who must rule; questions about understanding go to the overview or the reply.`,
    `Before answering an open thread, ${toolName('focus')} it so it sits at the top of the list.`,
    `When the topic shifts, ${toolName('order')} the open threads so those related to it, or raised most recently, come first.`,
    'End the reply by asking whether that answer is clear. Take up the next question only after the user confirms.',
    `Run all Python with ${toolName('python')}, never through Bash. It runs in one kernel shared with the user, which keeps its variables between runs; every run is saved in queries/ and shown in the app.`,
    "In the kernel, q(N) loads run N's saved result (a SQL run's rows, or table k of a Python run with q(N, k), or step k of a SQL run's Steps with q(N, step=k)) as a pandas DataFrame, without querying again. Use it instead of re-running a query.",
    `Write findings as root notes with ${toolName('note')}, one idea per note: cite every number [<slug> q N] (the run that shows it; <slug> is the analysis's folder name), and link related notes [[ID]]. Change a note with ${toolName('revise_note')} after you Read it; never Write or Edit under notes/ (the user edits notes too). Search notes/ with Grep and Read, and ${toolName('link_notes')} the ones this analysis relies on.`,
    'Keep it lean: show summaries, .head(), counts or charts. Never full frames or long prints.',
    'Plot with matplotlib: each figure is saved as a PNG that you can Read to check the chart. Altair charts are not captured.',
    'Move reusable or long code to lib/<name>.py with docstrings and type hints, and pytest tests in tests/test_<name>.py. In the kernel: from lib.<name> import ... Edit lib/ and tests/ only when this prompt asks for it.',
    `Run the tests from the analysis folder: cd ${folder} && ${python ?? 'python'} -m pytest tests`,
    `venv-assay is the only Python for the tools. If a package is missing, add it to the Assay repo's python/pyproject.toml and run ${VENV_ASSAY_COMMAND} on the Mac: never a Bash pip install and never another venv.`,
  ].join('\n')

export type UserRun = { number: number; language: 'sql' | 'python'; from?: number; replay?: number }

/**
 * The notice added to the rules: the user's runs since the last prompt, and the step checks (docs/slice-9.md) that failed
 * since then, one line each. Undefined when there is neither.
 */
export function runNotice(runs: readonly UserRun[], folder: string, stepLines: readonly string[] = []): string | undefined {
  const lines: string[] = []
  if (runs.length > 0) {
    const items = runs.map(run => {
      const origin = run.replay ? ` (replay of ${queryLabel(run.replay)})` : run.from ? ` (from ${queryLabel(run.from)})` : ''
      return `${queryLabel(run.number)} ${run.language}${origin}`
    })
    const kernel = runs.some(run => run.language === 'python') ? ' Their Python ran in your kernel, so its variables may have changed;' : ''
    lines.push(`Since your last turn the user ran: ${items.join(', ')}.${kernel} read ${folder}/queries/<file> when it matters.`.replace(/\. read/, '. Read'))
  }
  if (stepLines.length > 0) lines.push('Step checks failed since your last turn:', ...stepLines.map(line => `- ${line}`))
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** The line that says which analysis is open and where its files are, for a session that works from the root. */
export const openAnalysisRule = ({ title, folder }: OpenAnalysis) =>
  `Open analysis: "${title}", in ${folder}/. You work from the root: give paths from it. Its runs (queries/), ${folder}/lib/, ${folder}/tests/, ${folder}/lib/trusted/ and ${folder}/lib/dictionaries/ are there: write drafts, lib/ and tests/ only there.`

/** The rule on the dictionary and trusted calculations, in the shared folder `home`. */
export const trustRules = (home: string) =>
  `The data dictionary (${home}/${DICTIONARIES}) and trusted calculations (${home}/${TRUSTED}) change only through the user's approval: never write there.`

/** The rule listing the trusted calculations, and how to propose one. */
export function calculationRules(list: CalculationList | undefined): string {
  const usable = (list?.calculations ?? []).filter(calc => !calc.dirty)
  const blocks = usable.flatMap(calc => (calc.block ? [{ ...calc, block: calc.block }] : []))
  const definitions = usable.filter(calc => calc.kind === 'definition')
  const calculations = usable.filter(calc => !calc.block && calc.kind !== 'definition')
  const lines: string[] = []
  if (blocks.length > 0 || definitions.length > 0) {
    lines.push(
      "Trusted pieces: include blocks and definitions by name in your SQL, and Assay expands them and lists what the run is built from. A block is the whole body of a CTE: sessions AS ({{ client_entry_sessions(start => '2026-11-01', end => '2026-11-08') }}), with its -- grain: line above as usual. A definition goes where its expression fits, on the alias of its table: WHERE {{ client_entry(s) }}, or {{ <table>:<name>(s) }} when the short name is on several tables. Never retype their logic by hand; if you must, put -- retype: <piece>: <why> above the statement.",
      'When you are about to write the same cross-table logic a second time, propose a block.',
    )
  }
  if (blocks.length > 0) lines.push('Trusted blocks (params -> grain: columns):', ...blocks.map(calc => `- ${blockSignature(calc)}: ${calc.description}`))
  if (definitions.length > 0) lines.push('Dictionary definitions (<table>:<name>):', ...definitions.map(calc => `- ${calc.name}: ${calc.description}`))
  if (calculations.length > 0) {
    lines.push(
      `Trusted calculations answer one question whole: run one with ${toolName('trusted')} when it is exactly the question; they cannot be included. A <table>:<name> definition also runs with ${toolName('trusted')}: by lists columns to group (or show) by, filters names filter definitions of the same table.`,
      ...calculations.map(calc => `- ${signature(calc)}: ${calc.description}`),
    )
  }
  lines.push(`Propose a trusted block, calculation or dictionary entry with the ${PROPOSE_SKILL} skill; only the user promotes it, in ${TRUST_TAB}.`)
  return lines.join('\n')
}

/** The whole context one prompt carries: the rules, the notice of the user's runs, and the trust rules. */
export function promptContext(input: { python: string | undefined; notice?: string; home: string; list: CalculationList | undefined; open: OpenAnalysis }): string {
  return [[openAnalysisRule(input.open), analysisRules(input.python, input.open.folder), ...(input.notice ? [input.notice] : [])].join('\n'), trustRules(input.home), calculationRules(input.list)].join('\n')
}
