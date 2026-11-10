// The Doctor in Settings: which of the runtime tools Assay needs are on the user's PATH, and the state of its venv.
// Nothing is bundled (docs/slice-11.md), so a missing tool is the user's to install; each check names the fix.
import type { VenvBuild } from './venv.ts'

/** What `command -v` and `--version` printed for one tool: no path when it is not found. */
export type Probe = { path?: string; version?: string }

const TOOLS = ['claude', 'node', 'uv', 'databricks', 'rds-psql'] as const
export type Tool = (typeof TOOLS)[number]
export type Probes = Record<Tool, Probe>

export type CheckStatus = 'ok' | 'missing' | 'too old' | 'optional' | 'building' | 'failed'
export type Check = { name: string; status: CheckStatus; detail: string; fix?: string }

export const VENV_CHECK = 'Python environment'
const MIN_NODE = 22
const NOT_FOUND = "Not on the login shell's PATH"
const FIXES: Record<Exclude<Tool, 'rds-psql'>, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  node: 'brew install node',
  uv: 'brew install uv',
  databricks: 'brew install databricks/tap/databricks',
}

/**
 * A POSIX sh script that prints one line per tool: its name, its path and the first line of its `--version`, split
 * by tabs. The path or version is empty when the tool is missing. Claude is `$ASSAY_CLAUDE_BIN` when that is set.
 */
export function probeScript(): string {
  return TOOLS.map(tool => {
    const command = tool === 'claude' ? '"${ASSAY_CLAUDE_BIN:-claude}"' : tool
    return `p=$(command -v ${command} 2>/dev/null); v=; [ -n "$p" ] && v=$("$p" --version 2>&1 | head -n 1); printf '%s\\t%s\\t%s\\n' ${tool} "$p" "$v"`
  }).join('\n')
}

/** The probe script's output as a probe per tool; a tool it printed nothing for is missing. */
export function parseProbes(stdout: string): Probes {
  const probes = Object.fromEntries(TOOLS.map(tool => [tool, {}])) as Probes
  for (const line of stdout.split('\n')) {
    const [name = '', path = '', version = ''] = line.split('\t')
    if (!(TOOLS as readonly string[]).includes(name) || !path) continue
    probes[name as Tool] = { path, version: version.trim() }
  }
  return probes
}

/** The first number in a version line (`v22.11.0` is 22); NaN when it has none. */
const majorOf = (version: string | undefined) => Number(/\d+/.exec(version ?? '')?.[0] ?? Number.NaN)
const found = (probe: Probe) => (probe.version ? `${probe.version} at ${probe.path ?? ''}` : (probe.path ?? ''))
const isTooOld = (version: string | undefined) => {
  const major = majorOf(version)
  return Number.isNaN(major) || major < MIN_NODE
}

function toolCheck(tool: Exclude<Tool, 'rds-psql'>, probe: Probe, name: string, fix: string): Check {
  if (!probe.path) return { name, status: 'missing', detail: NOT_FOUND, fix }
  if (tool === 'node' && isTooOld(probe.version)) {
    return { name, status: 'too old', detail: `${found(probe)}; Assay needs ${String(MIN_NODE)} or later`, fix }
  }
  return { name, status: 'ok', detail: found(probe) }
}

function rdsPsqlCheck(probe: Probe): Check {
  if (probe.path) return { name: 'rds-psql', status: 'ok', detail: found(probe) }
  return { name: 'rds-psql', status: 'optional', detail: 'Not found: Postgres runs need a launcher that provides it', fix: 'See docs/process/launch-contract.md' }
}

function venvCheck(venv: VenvBuild | undefined): Check {
  if (venv?.state === 'ready') return { name: VENV_CHECK, status: 'ok', detail: 'Built' }
  if (venv?.state === 'building') return { name: VENV_CHECK, status: 'building', detail: 'Building with uv' }
  if (venv?.state === 'failed') return { name: VENV_CHECK, status: 'failed', detail: venv.error, fix: 'Recheck builds it again' }
  return { name: VENV_CHECK, status: 'missing', detail: 'Not built yet' }
}

/** The Doctor's list, in a fixed order: the tools, then the venv. `claudeBin` is `$ASSAY_CLAUDE_BIN` when set. */
export function doctorChecks({ probes, venv, claudeBin }: { probes: Probes; venv: VenvBuild | undefined; claudeBin?: string }): Check[] {
  return [
    toolCheck('claude', probes.claude, claudeBin ?? 'claude', claudeBin ? 'Check ASSAY_CLAUDE_BIN' : FIXES.claude),
    toolCheck('node', probes.node, 'node', FIXES.node),
    toolCheck('uv', probes.uv, 'uv', FIXES.uv),
    toolCheck('databricks', probes.databricks, 'databricks', FIXES.databricks),
    rdsPsqlCheck(probes['rds-psql']),
    venvCheck(venv),
  ]
}

/** Only a missing Claude stops an analysis from opening: without the others some tools fail, with their reason. */
export const blocksOpening = (checks: readonly Check[]) => checks[0]?.status === 'missing'
