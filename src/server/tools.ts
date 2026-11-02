// Claude's tools: their specs (as the mod registered them) and what each does. `callTool` is the whole of a call:
// the MCP layer in index.ts only passes the arguments in and the text out.
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { deriveLabel, fileNoteLine, findFact, noteLine, notesFrom, notesText, noteTag, parseFileNote, parseNote } from '../core/facts.ts'
import type { QueryFacts } from '../core/facts.ts'
import { baseName, titleOf } from '../core/linkedNotes.ts'
import { nextNoteNumber, NOTE_SLUG, noteCitations, noteFileName, noteFileText, noteLinks, parseNoteFileName, resolvesToNote } from '../core/noteFiles.ts'
import { queryLabel } from '../core/pythonRuns.ts'
import type { Engine } from '../core/runs.ts'
import { oneLine } from '../core/text.ts'
import { closeThread, focusThread, orderThreads, parkThread } from '../core/threads.ts'
import { ANALYSIS_FILE } from '../core/analyses.ts'
import { Assay, NOTE_FILES, NOTES } from './assay.ts'

export type ToolSpec = { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, object>; required: readonly string[] } }

export const TOOLS = [
  {
    name: 'sql',
    description:
      'Run one SQL statement on the Databricks SQL warehouse, or on the Postgres database with engine "postgres". Saves analyses/<slug>/queries/NNN_<slug>.sql and .csv (the folder of the open analysis, named in the rules), shows the full result in the app, and returns the query number, row count, columns and at most 50 rows. Use it for every query.',
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
      'Run a trusted calculation by name: SQL or Python the user has vetted and promoted, or a data dictionary definition as <catalog.schema.table>:<name>, listed in the analysis rules. Arguments are checked against its declared types and bound as parameters. Saved as the next query (its .sql records the calculation, its arguments and its commit), shown in the app, and returned like sql. A note citing it, read directly from its result, is labelled trusted.',
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
      'Append one line to analyses/<slug>/notes.md: a definition or a gotcha, no prose. Give the query number that verified it. The server labels the note from that query: trusted (a run of a trusted calculation, read directly), queried (any other query with a result) or unverified (no query, or no result). Do not write a label yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One terse line, without a label or query tag.' },
        query: { type: 'integer', description: 'The number of the query whose result shows it.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'revise_note',
    description:
      'Change one note in analyses/<slug>/notes.md: cite the query that now verifies it (the server labels it again), or delete it. Only when the user has said which, e.g. in assay:wrap-up.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The note: its line number in analyses/<slug>/notes.md, or its text.' },
        query: { type: 'integer', description: 'The number of the query that verifies it.' },
        delete: { type: 'boolean', description: 'Delete the note instead.' },
      },
      required: ['note'],
    },
  },
  {
    name: 'link_note',
    description:
      "List a note file in analyses/<slug>/notes.md, by the title at its top, so the app's Notes tab shows it and the user can open and edit it. When the user asks to save something as a note, write the file yourself first, choosing its folder and name (the user may name a repo, e.g. llm-wiki), with its title as the first line; then call this with its path. It needs no query.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The note file you wrote: an absolute path.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'new_note',
    description:
      "Write a prose finding as a note file, notes/NNN-<slug>.md, in the analysis: one idea per note, for explanations and anything longer than a fact. The server numbers it. Link related notes with [[slug]] in the text and cite every number with [q NNN] (the run that shows it). To change a note later, Read it and Edit it. A short fact still goes through note.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title: the first line of the file, as a # heading.' },
        slug: { type: 'string', description: 'Lower case letters, digits and -, starting with a letter or digit. Unique among the notes.' },
        text: { type: 'string', description: 'The note: Markdown, after the title.' },
      },
      required: ['title', 'slug', 'text'],
    },
  },
] as const satisfies readonly ToolSpec[]

export type ToolName = (typeof TOOLS)[number]['name']

const UNVERIFIED_WHY = (query: number | undefined, facts?: QueryFacts) =>
  query === undefined
    ? ' It cites no query.'
    : facts?.language === 'python'
      ? ` Run ${queryLabel(query)} did not finish ok (${facts.status ?? 'no result'}).`
      : ` Query ${queryLabel(query)} has no result (.csv).`

type Args = Record<string, unknown>
const field = (args: Args, key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
const integer = (args: Args, key: string) => (typeof args[key] === 'number' && Number.isInteger(args[key]) ? (args[key] as number) : undefined)

/** One tool call: its reply text. */
export async function callTool(assay: Assay, name: string, args: Args): Promise<string> {
  if (!assay.hasMarker()) return `${assay.shown('')} has no ${ANALYSIS_FILE}. Run "npm run migrate:root" in the Assay repo, then open the analysis again.`
  switch (name) {
    case 'sql': {
      const sql = field(args, 'sql')
      const engine: Engine = field(args, 'engine') === 'postgres' ? 'postgres' : 'databricks'
      return sql.trim() ? assay.runSql(sql, field(args, 'slug'), engine) : 'Give the SQL to run.'
    }
    case 'python': {
      const code = field(args, 'code')
      if (!code.trim()) return 'Give the Python code to run.'
      return (await assay.runPython(code, field(args, 'slug'), '')).text
    }
    case 'trusted': {
      const calc = field(args, 'name').trim()
      if (!calc) return 'Give the trusted calculation by name.'
      return assay.runTrusted(calc, args.args)
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
    case 'note': {
      const text = oneLine(field(args, 'text'))
      if (!text) return 'Give the note as one line.'
      const query = integer(args, 'query')
      const note = await assay.labelled(parseNote(text).text, query)
      await assay.editNotes(lines => [...lines, note.line])
      return `Noted as ${noteTag(note.label, query)}.${note.label === 'unverified' ? UNVERIFIED_WHY(query, note.facts) : ''}`
    }
    case 'revise_note': {
      const ref = oneLine(field(args, 'note'))
      const query = integer(args, 'query')
      const isDelete = args.delete === true
      if (!ref) return `Give the note: its line number in ${assay.shown(NOTES)}, or its text.`
      if (!isDelete && query === undefined) return 'Give the query that verifies it, or delete: true.'
      const facts = query === undefined ? undefined : await assay.queryFacts(query)
      return assay.serially(async () => {
        const lines = notesFrom(await assay.readText(NOTES))
        const index = findFact(lines, ref, assay.shown(NOTES))
        if (typeof index === 'string') return index
        const note = parseNote(lines[index] ?? '')
        if (isDelete) {
          await assay.write(NOTES, notesText(lines.filter((_, i) => i !== index)))
          return `Deleted note ${index + 1}: ${note.text}`
        }
        const label = deriveLabel(facts)
        lines[index] = noteLine(note.text, label, query)
        await assay.write(NOTES, notesText(lines))
        return `Note ${index + 1} is now ${noteTag(label, query)}.${label === 'unverified' ? UNVERIFIED_WHY(query, facts) : ''}`
      })
    }
    case 'new_note': {
      const title = field(args, 'title').replace(/\s+/g, ' ').trim()
      const slug = field(args, 'slug').trim()
      const body = field(args, 'text')
      if (!title) return 'Give the note a title.'
      if (!NOTE_SLUG.test(slug)) return 'The slug is lower case letters, digits and -, starting with a letter or digit.'
      return assay.serially(async () => {
        const names = await assay.names(NOTE_FILES)
        const taken = names.find(each => parseNoteFileName(each)?.slug === slug)
        if (taken) return `A note ${slug} exists: ${assay.shown(`${NOTE_FILES}/${taken}`)}. Edit it with Edit.`
        const file = noteFileName(nextNoteNumber(names), slug)
        await assay.write(`${NOTE_FILES}/${file}`, noteFileText(title, body))
        const known = new Set((await assay.listQueries()).map(query => query.number))
        const unknown = noteCitations(body).filter(number => !known.has(number))
        const unresolved = noteLinks(body).filter(target => target !== slug && !resolvesToNote(target, [...names, file]))
        return [
          `Wrote ${assay.shown(`${NOTE_FILES}/${file}`)}. Link it from other notes with [[${slug}]].`,
          ...(unknown.length > 0 ? [`Unknown runs: ${unknown.map(queryLabel).join(', ')}.`] : []),
          ...(unresolved.length > 0 ? [`Unresolved links: ${unresolved.map(target => `[[${target}]]`).join(', ')}.`] : []),
        ].join('\n')
      })
    }
    case 'link_note': {
      const given = field(args, 'path').trim()
      if (!given || given.startsWith('~')) return 'Give the note file as an absolute path.'
      // A linked note's path is absolute, or relative to the root (where Claude works) or to the analysis folder; both is ambiguous.
      let path = given
      if (!isAbsolute(given)) {
        const underRoot = join(assay.config.root, given)
        const inAnalysis = join(assay.config.analysis, given)
        const [isInRoot, isInAnalysis] = await Promise.all([assay.exists(underRoot), assay.exists(inAnalysis)])
        if (isInRoot && isInAnalysis && underRoot !== inAnalysis) return `${given} exists under the root (${underRoot}) and in the analysis (${inAnalysis}). Give an absolute path.`
        path = isInRoot ? underRoot : inAnalysis
      }
      const text = await readFile(path, 'utf8').catch(() => undefined)
      if (text === undefined) return `Cannot read ${path}. Write the note there first.`
      const title = titleOf(text) ?? baseName(path)
      const isNew = await assay.serially(async () => {
        const lines = notesFrom(await assay.readText(NOTES))
        if (lines.some(line => parseFileNote(line)?.path === path)) return false
        await assay.write(NOTES, notesText([...lines, fileNoteLine(title, path)]))
        return true
      })
      return isNew ? `Listed "${title}" in ${assay.shown(NOTES)}; the app's Notes tab shows it.` : `"${title}" is already listed; the app shows its file as it is now.`
    }
    default:
      return `Unknown tool: ${name}.`
  }
}
