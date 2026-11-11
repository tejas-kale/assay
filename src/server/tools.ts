// Claude's tools: their specs (as the mod registered them) and what each does. `callTool` is the whole of a call:
// the MCP layer in index.ts only passes the arguments in and the text out.
import type { Engine } from '../core/runs.ts'
import { oneLine } from '../core/text.ts'
import { closeThread, focusThread, orderThreads, parkThread } from '../core/threads.ts'
import { ANALYSIS_FILE } from '../core/analyses.ts'
import { Assay } from './assay.ts'
import { runPython } from './pythonRun.ts'
import { runClaudeSql } from './sqlRun.ts'
import { runTrusted } from './trustedRun.ts'
import { linkNotes, noteLabels, reviseNote, searchHint, writeNote } from './notes.ts'

export type ToolSpec = { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, object>; required: readonly string[] } }

export const TOOLS = [
  {
    name: 'sql',
    description:
      'Run one SQL statement on the Databricks SQL warehouse, or on the Postgres database with engine "postgres". Saves analyses/<slug>/queries/NNN_<slug>.sql and .csv (the folder of the open analysis, named in the rules), shows the full result in the app, and returns the query number, row count, columns and at most 50 rows. Use it for every query. ' +
      'A statement with WITH or JOIN must follow the SQL rules or it is not run: on the line directly above each CTE (`name AS (`) and above the final SELECT, `-- grain: <col>[, <col>...]`, the output columns that identify one row (`-- grain: none` for a single row); on the line directly above each JOIN, `-- join: <1:1|1:many|many:1|many:many> on <key>[, <key>...]`, left side first (a CROSS JOIN is `many:many on none`). ' +
      'Name CTEs for what they hold (orders_per_customer, not t1, cte2 or step_3); no subquery in FROM or JOIN, make it a CTE. Each CTE does one of filter, join, aggregate, and aggregates before joining a many side. ' +
      "Include trusted blocks and definitions by name, as the rules list them: a block as a CTE's whole body, x AS ({{ block(p => 'v') }}); a definition on a table's alias, {{ definition(alias) }}. The reply says what the run is built from.",
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SQL statement, in the dialect of the engine.' },
        slug: { type: 'string', description: 'Short kebab-case description, e.g. beta-params-by-panel.' },
        engine: {
          type: 'string',
          enum: ['databricks', 'postgres'],
          description:
            'Where to run it. "postgres" when the user asks for Postgres or pg: the Aurora database, read only. Otherwise "databricks", the default.',
        },
      },
      required: ['sql', 'slug'],
    },
  },
  {
    name: 'python',
    description:
      "Run Python in the analysis's kernel: one per session, shared with the user, which keeps its variables between runs. Saves analyses/<slug>/queries/NNN_<slug>.py and the run's result beside the SQL runs, shows it in the app, and returns the run number, stdout, any error's traceback, each table's columns and at most 50 rows, and each plot's file (Read it to check the chart). q(N) loads run N's saved result as a pandas DataFrame without querying again. Use it for all Python.",
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The Python code to run, in the kernel as it stands.' },
        slug: { type: 'string', description: 'Short kebab-case description, e.g. beta-params-by-panel.' },
      },
      required: ['code', 'slug'],
    },
  },
  {
    name: 'trusted',
    description:
      'Run a trusted calculation by name: SQL or Python the user has vetted and promoted, or a data dictionary definition as <catalog.schema.table>:<name>, listed in the analysis rules. Arguments are checked against its declared types and bound as parameters. Saved as the next query (its .sql records the calculation, its arguments and its commit), shown in the app, and returned like sql.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The calculation, e.g. completes_by_site.' },
        args: {
          type: 'object',
          description:
            'Its named arguments, e.g. {"start": "2026-01-01"}. Dates as YYYY-MM-DD. A definition takes by (columns), filters (filter definitions of its table) and, for a derived value, limit.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'park',
    description: 'Park a thread to come back to: one line, phrased as a question. Returns the open count.',
    inputSchema: {
      type: 'object',
      properties: { thread: { type: 'string', description: 'One line, phrased as a question.' } },
      required: ['thread'],
    },
  },
  {
    name: 'close',
    description: 'Close an open thread with its outcome. Returns the next open thread.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'The open thread, by its number or its text.' },
        outcome: { type: 'string', description: 'One line: what the answer was.' },
      },
      required: ['thread'],
    },
  },
  {
    name: 'focus',
    description:
      'Move an open thread to the top of the list: the one under discussion now. Call it before answering a parked thread.',
    inputSchema: {
      type: 'object',
      properties: { thread: { type: 'string', description: 'The open thread, by its number or its text.' } },
      required: ['thread'],
    },
  },
  {
    name: 'order',
    description:
      'Rearrange the open threads: the ones listed move to the top in that order, the rest keep their order below. Use it to put threads related to the current topic, or the most recent ones, first. Returns the new list.',
    inputSchema: {
      type: 'object',
      properties: {
        threads: {
          type: 'array',
          items: { type: 'string' },
          description: 'Open threads, by number or text, in the order wanted at the top. Numbers are as the list stands now.',
        },
      },
      required: ['threads'],
    },
  },
  {
    name: 'note',
    description:
      "Write a finding as a root note, notes/<ID>-<slug>.md, shared by every analysis: one idea per note, a short fact or a longer explanation. The server gives it its ID and file name. Cite every number as [<analysis> q N] (the run that shows it; a bare [q N] is qualified with the open analysis); link related notes with [[<ID>]]. The reply gives the ID and names unknown runs and unresolved links.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title: a short line, or the fact itself.' },
        text: { type: 'string', description: 'The note: Markdown, after the title.' },
      },
      required: ['title', 'text'],
    },
  },
  {
    name: 'revise_note',
    description:
      "Change a root note by its ID, after Reading it: replace exact text in its body (old must appear once; Read the note again when it is refused), or change its title, or delete it (only a note this analysis wrote). Never Write or Edit under notes/.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note ID, e.g. 20261102T181500.' },
        old: { type: 'string', description: 'Exact text in the note body to replace; appears once.' },
        new: { type: 'string', description: 'What replaces it.' },
        title: { type: 'string', description: 'A new title, instead of old and new.' },
        delete: { type: 'boolean', description: 'Delete the note instead.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'link_notes',
    description:
      "Record the existing root notes this analysis relies on, by ID, so analysis.yaml lists them as found. Search notes/ with Grep and Read first; link the relevant ones. Refuses an unknown ID.",
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Note IDs, e.g. 20261001T090000.' } },
      required: ['ids'],
    },
  },
  {
    name: 'note_labels',
    description:
      "The label of each citation in the root notes this analysis wrote: per note a line `<ID> <title>`, then one line `[<analysis> q N] <label>` per citation. Labels: trusted, queried, computed, unverified (no result), stale (a trusted run whose calculation has a newer commit), missing (no such run). Notes with a weak citation (unverified, stale, missing) come first, and weak citations first within a note. With weak: true only notes with a weak citation are listed. With id, that one note, which may be any root note. When the calculation's current commit cannot be found, the reply ends with a line saying stale was not checked.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One note ID, any root note; default: every note this analysis wrote.' },
        weak: { type: 'boolean', description: 'List only notes with an unverified, stale or missing citation.' },
      },
      required: [],
    },
  },
] as const satisfies readonly ToolSpec[]

export type ToolName = (typeof TOOLS)[number]['name']

type Args = Record<string, unknown>
const field = (args: Args, key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')

/** One tool call: its reply text. */
export async function callTool(assay: Assay, name: string, args: Args): Promise<string> {
  const before = assay.runsClaimed
  const reply = await dispatch(assay, name, args)
  if (!['sql', 'python', 'trusted'].includes(name) || assay.runsClaimed === before) return reply
  const hint = await searchHint(assay)
  return hint ? `${reply}\n${hint}` : reply
}

async function dispatch(assay: Assay, name: string, args: Args): Promise<string> {
  if (!assay.hasMarker()) return `${assay.shown('')} has no ${ANALYSIS_FILE}. Run "npm run migrate:root" in the Assay repo, then open the analysis again.`
  switch (name) {
    case 'sql': {
      const sql = field(args, 'sql')
      const engine: Engine = field(args, 'engine') === 'postgres' ? 'postgres' : 'databricks'
      return sql.trim() ? runClaudeSql(assay, sql, field(args, 'slug'), engine) : 'Give the SQL to run.'
    }
    case 'python': {
      const code = field(args, 'code')
      if (!code.trim()) return 'Give the Python code to run.'
      return (await runPython(assay, code, field(args, 'slug'), '')).text
    }
    case 'trusted': {
      const calc = field(args, 'name').trim()
      if (!calc) return 'Give the trusted calculation by name.'
      return runTrusted(assay, calc, args.args)
    }
    case 'park': {
      const thread = oneLine(field(args, 'thread'))
      if (!thread) return 'Give the thread as one line.'
      const open = await assay.editThreads(threads => {
        const parked = parkThread(threads, thread)
        return { threads: parked, answer: parked.open.length }
      })
      return `Parked. ${open} open ${open === 1 ? 'thread' : 'threads'}.`
    }
    case 'close':
      return assay.editThreads(threads => {
        const closed = closeThread(threads, field(args, 'thread'), field(args, 'outcome'))
        if (closed.error || !closed.closed) return { threads, answer: closed.error ?? '' }
        const nextOpen = closed.threads.open[0]
        const after = nextOpen ? `Next open thread: 1. ${nextOpen}` : 'No open threads left.'
        return { threads: closed.threads, answer: `Closed "${closed.closed.thread}". ${after}` }
      })
    case 'focus':
      return assay.editThreads(threads => {
        const focused = focusThread(threads, field(args, 'thread'))
        if (focused.error || !focused.focused) return { threads, answer: focused.error ?? '' }
        return { threads: focused.threads, answer: `Focused: 1. ${focused.focused}` }
      })
    case 'order': {
      const given = args.threads
      const refs = Array.isArray(given) ? given.filter((ref): ref is string => typeof ref === 'string') : []
      if (refs.length === 0) return 'Give the threads to move to the top, in order.'
      return assay.editThreads(threads => {
        const ordered = orderThreads(threads, refs)
        if (ordered.error) return { threads, answer: ordered.error }
        const list = ordered.threads.open.map((thread, i) => `${i + 1}. ${thread}`).join('\n')
        return { threads: ordered.threads, answer: `Open threads now:\n${list}` }
      })
    }
    case 'note':
      return writeNote(assay, args)
    case 'revise_note':
      return reviseNote(assay, args)
    case 'link_notes':
      return linkNotes(assay, args)
    case 'note_labels':
      return noteLabels(assay, args)
    default:
      return `Unknown tool: ${name}.`
  }
}
