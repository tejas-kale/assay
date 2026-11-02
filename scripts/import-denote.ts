// `npm run import:denote <from> <root> [--apply]`: copies denote notes (e.g. ~/Code/notes/claude) into <root>/notes/ as
// root notes, keeping their IDs. A dry run unless --apply. See src/migrate/importDenote.ts.
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { applyImport, planImport, printImportReport } from '../src/migrate/importDenote.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const [from, root] = args.filter(arg => !arg.startsWith('--')).map(arg => resolve(arg.replace(/^~(?=\/|$)/, homedir())))
const isDir = (path: string | undefined) => (path ? stat(path).then(info => info.isDirectory(), () => false) : Promise.resolve(false))

if (!(await isDir(from)) || !(await isDir(root))) {
  console.error('Usage: npm run import:denote <denote folder> <root> [--apply]  (both folders must exist)')
  process.exit(2)
}
console.log(`${apply ? 'Importing' : 'Dry run of'} ${from} into ${root}/notes\n`)
const plan = await planImport(from as string, root as string)
if (apply) await applyImport(root as string, plan)
process.stdout.write(printImportReport(plan, apply))
