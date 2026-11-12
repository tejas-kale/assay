// The note tools' replies to the arguments the other tests leave out.
import { test } from 'node:test'

import { expect } from '../testing/expect.ts'
import { fake } from './testing.ts'

const NOTES_AT = '/work/notes'
const ID = '20260101T000000'

test('revise_note asks for the note by its ID, and for a title that is not blank', async () => {
  const ws = await fake()
  await ws.put(`${NOTES_AT}/${ID}-alpha.md`, '# Alpha\n\nBody.\n')
  expect(await ws.call('revise_note', {})).toBe('Give the note by its ID.')
  expect(await ws.call('revise_note', { id: '  ' })).toBe('Give the note by its ID.')
  expect(await ws.call('revise_note', { id: ID, title: '   ' })).toBe('Give the note a title.')
  expect(await ws.call('revise_note', { id: ID, old: 'Body.' })).toBe('Give old and new, or title, or delete: true.')
  expect(await ws.file(`${NOTES_AT}/${ID}-alpha.md`)).toBe('# Alpha\n\nBody.\n')
  await ws.done()
})

test('note without a title or text is refused, and an analysis.yaml that cannot be changed is reported', async () => {
  const ws = await fake()
  expect(await ws.call('note', {})).toBe('Give the note a title.')
  await ws.done()
  const blocked = await fake({ 'analysis.yaml/inside': 'a directory where the file should be' })
  const outcome = await blocked.call('note', { title: 'T', text: 'x' }).then(
    reply => reply,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  expect(outcome).toMatch(/EISDIR/)
  await blocked.done()
})

test('link_notes keeps only the IDs that are strings', async () => {
  const ws = await fake()
  await ws.put(`${NOTES_AT}/${ID}-alpha.md`, '# Alpha\n')
  expect(await ws.call('link_notes', { ids: [7, null] })).toBe('Give the IDs of the notes to link.')
  expect(await ws.call('link_notes', { ids: 'nope' })).toBe('Give the IDs of the notes to link.')
  expect(await ws.call('link_notes', { ids: [7, ` ${ID} `] })).toBe(`Linked ${ID} Alpha.`)
  await ws.done()
})
