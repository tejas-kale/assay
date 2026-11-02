// The note tools: `note`, `revise_note` and `link_notes` work on the root notes (`<root>/notes/<ID>-<slug>.md`) and
// on the `notes:` lists of the open analysis's analysis.yaml. Each returns its reply text.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ANALYSIS_FILE, folderName } from '../core/analyses.ts'
import { citationLabels } from '../core/citationLabels.ts'
import { queryLabel } from '../core/pythonRuns.ts'
import {
  addFound,
  fileOf,
  isNoteId,
  noteIds,
  noteCitations,
  noteSegments,
  noteTitle,
  oneTitle,
  NOTES_DIR,
  parseNoteLists,
  qualifyCitations,
  removeWritten,
  retitle,
  reviseBody,
  writeRootNote,
} from '../core/rootNotes.ts'
import type { Assay } from './assay.ts'

type Args = Record<string, unknown>
const text = (args: Args, key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined)

const dir = (assay: Assay) => join(assay.config.root, NOTES_DIR)
const shown = (file: string) => `${NOTES_DIR}/${file}`
const names = (assay: Assay) => readdir(dir(assay)).catch(() => [] as string[])

/** The open analysis's slug: its folder name, which its citations carry. */
export const slugOf = (assay: Assay) => folderName(assay.config.analysis)

/** Changes the `notes:` lists in analysis.yaml, one change at a time. */
const editYaml = (assay: Assay, change: (yaml: string) => string) =>
  assay.serially(async () => {
    const yaml = await assay.readText(ANALYSIS_FILE)
    await assay.write(ANALYSIS_FILE, change(yaml))
  })

/** The warnings for a note's text: runs that do not exist and links to no note. Neither refuses the write. */
async function warnings(assay: Assay, own: string, noteBody: string): Promise<string[]> {
  const segments = noteSegments(noteBody)
  const cited = noteCitations(noteBody)
  const labels = await citationLabels({ fs: { readdir: path => readdir(path), readFile: path => readFile(path, 'utf8') }, root: assay.config.root }, cited)
  const unknown = [...new Set(cited.filter(c => labels.get(`${c.analysis} q ${c.number}`) === 'missing').map(c => `${c.analysis} q ${queryLabel(c.number)}`))]
  const known = new Set(noteIds(await names(assay)))
  const unresolved = [...new Set(segments.flatMap(segment => (segment.type === 'link' && segment.id !== own && !known.has(segment.id) ? [segment.id] : [])))]
  return [
    ...(unknown.length > 0 ? [`Unknown runs: ${unknown.join(', ')}.`] : []),
    ...(unresolved.length > 0 ? [`Unresolved links: ${unresolved.map(id => `[[${id}]]`).join(', ')}.`] : []),
  ]
}

/** `note { title, text }`: a new root note, qualified, listed under `written`. */
export async function writeNote(assay: Assay, args: Args): Promise<string> {
  // One note at a time, folder listing included, so two notes in one second (different titles, so different file names) get two IDs.
  const written = await assay.serially(() =>
    writeRootNote(
      {
        readdir: path => readdir(path),
        mkdir: async path => void (await mkdir(path, { recursive: true })),
        createFile: (path, content) => writeFile(path, content, { encoding: 'utf8', flag: 'wx' }),
        editYaml: async change => assay.write(ANALYSIS_FILE, change(await assay.readText(ANALYSIS_FILE))),
      },
      { dir: dir(assay), slug: slugOf(assay), title: text(args, 'title') ?? '', body: text(args, 'text') ?? '' },
    ),
  )
  if (!written.ok) return written.reason === 'title' ? 'Give the note a title.' : 'Could not find a free note ID.'
  if (written.listed !== true) throw new Error(written.listed)
  return [`Wrote ${shown(written.file)}. Link it with [[${written.id}]].`, ...(await warnings(assay, written.id, written.text))].join('\n')
}

/** `revise_note`: an exact replacement in the body, a new title, or delete (only a note this analysis wrote). */
export async function reviseNote(assay: Assay, args: Args): Promise<string> {
  const id = (text(args, 'id') ?? '').trim()
  if (!id) return 'Give the note by its ID.'
  const file = fileOf(id, await names(assay))
  if (!file) return `No note ${id} in ${NOTES_DIR}/.`
  const path = join(dir(assay), file)
  if (args.delete === true) {
    if (!parseNoteLists(await assay.readText(ANALYSIS_FILE)).written.includes(id)) return `Note ${id} was not written by this analysis, so it is not deleted. Only the analysis that wrote a note deletes it.`
    await rm(path, { force: true })
    await editYaml(assay, yaml => removeWritten(yaml, id))
    return `Deleted ${shown(file)}.`
  }
  const current = await readFile(path, 'utf8')
  const old = text(args, 'old')
  const next = text(args, 'new')
  const title = text(args, 'title')
  let revised: string
  if (old !== undefined && next !== undefined) {
    try {
      revised = reviseBody(current, old, qualifyCitations(next, slugOf(assay)))
    } catch (error) {
      if (error instanceof Error) return error.message
      throw error
    }
  } else if (title !== undefined) {
    if (!oneTitle(title)) return 'Give the note a title.'
    revised = retitle(current, title)
  } else return 'Give old and new, or title, or delete: true.'
  await writeFile(path, revised, 'utf8')
  return [`Revised ${shown(file)}.`, ...(await warnings(assay, id, revised))].join('\n')
}

/** `link_notes { ids }`: records the notes this analysis relied on under `found`. */
export async function linkNotes(assay: Assay, args: Args): Promise<string> {
  const given = Array.isArray(args.ids) ? args.ids.filter((each): each is string => typeof each === 'string').map(each => each.trim()) : []
  if (given.length === 0) return 'Give the IDs of the notes to link.'
  const files = await names(assay)
  const unknown = given.filter(id => !isNoteId(id) || !fileOf(id, files))
  if (unknown.length > 0) return `Unknown notes: ${unknown.join(', ')}. Nothing was linked; use the IDs in the file names in ${NOTES_DIR}/.`
  const own = parseNoteLists(await assay.readText(ANALYSIS_FILE)).written
  const unique = [...new Set(given)]
  const ids = unique.filter(id => !own.includes(id))
  if (ids.length > 0) await editYaml(assay, yaml => addFound(yaml, ids))
  const titled = await Promise.all(ids.map(async id => `${id} ${noteTitle(await readFile(join(dir(assay), fileOf(id, files) ?? ''), 'utf8').catch(() => '')) ?? ''}`.trim()))
  const skipped = unique.length - ids.length
  return [ids.length > 0 ? `Linked ${titled.join('; ')}.` : 'Nothing new to link.', ...(skipped > 0 ? [`Skipped ${skipped} written by this analysis.`] : [])].join(' ')
}

export const SEARCH_LINE = `This analysis has no notes yet. Search ${NOTES_DIR}/ (Grep, Read) for notes about the tables and topics of this run, and call link_notes with the IDs of the relevant ones.`

/** The line ending the reply of a session's first run in an analysis with no notes; once per session. */
export async function searchHint(assay: Assay): Promise<string | undefined> {
  if (assay.searchHinted) return undefined
  assay.searchHinted = true
  const lists = parseNoteLists(await assay.readText(ANALYSIS_FILE))
  return lists.found.length === 0 && lists.written.length === 0 ? SEARCH_LINE : undefined
}
