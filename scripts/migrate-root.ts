// `npm run migrate:root [root] [--apply]`: converts the old layout to `analyses/<slug>/analysis.yaml`. A dry run unless
// --apply. The root defaults to the app's Settings folder. See src/migrate/migrateRoot.ts.
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { parseSettings, rootFor } from '../src/core/settings.ts'
import { migrateRoot, printReport } from '../src/migrate/migrateRoot.ts'

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
process.stdout.write(printReport(await migrateRoot(root, apply), apply))
