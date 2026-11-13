// `npm run install-cli`: the `assay` launcher for the app in /Applications, as the app itself writes at launch.
import { homedir } from 'node:os'

import { installLauncher } from '../src/main/cliLauncher.ts'

const { target } = await installLauncher({
  entry: '/Applications/Assay.app/Contents/Resources/backend/out/cli/assay.mjs',
  path: process.env.PATH ?? '',
  home: homedir(),
})
console.log(`Installed ${target}`)
