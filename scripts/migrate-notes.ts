// `npm run migrate:notes [root] [--apply]`: turns each analysis's notes.md facts and notes/ files into root notes (slice 7). A dry run
// unless --apply. Needs `migrate:root` to have run. The root defaults to the app's Settings folder. See src/migrate/migrateNotes.ts.
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { parseSettings, rootFor } from '../src/core/settings.ts'
import { applyPlan, nodeFsPort, NotMigratedError, planNotes, printReport } from '../src/migrate/migrateNotes.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const given = args.find(arg => !arg.startsWith('--'))

/** The Settings folder as the app saved it (Electron's user data folder is named Assay or, in dev, assay). */
async function settingsRoot(): Promise<string | undefined> {
  for (const app of ['Assay', 'assay']) {
    const text = await readFile(join(homedir(), 'Library/Application Support', app, 'settings.json'), 'utf8').catch(() => undefined)
    const { root } = parseSettings(text)
    if (root) return rootFor(root)
  }
  return undefined
}

const root = given ? resolve(given.replace(/^~(?=\/|$)/, homedir())) : await settingsRoot()
if (!root || !(await stat(root).then(info => info.isDirectory(), () => false))) {
  console.error(root ? `No such folder: ${root}` : 'No root: pass the folder as an argument (the one holding analyses/), or set it in the app first.')
  process.exit(2)
}
console.log(`${apply ? 'Migrating' : 'Dry run on'} ${root}\n`)
try {
  const plan = await planNotes(nodeFsPort, root)
  if (apply) await applyPlan(root, plan)
  process.stdout.write(printReport(plan, apply))
} catch (error) {
  if (!(error instanceof NotMigratedError)) throw error
  console.error(error.message)
  process.exit(2)
}
