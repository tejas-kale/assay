// Validation can return exit zero with success:false; check the result before trusting mounted tests.
import { execFileSync } from 'node:child_process'

execFileSync(process.execPath, ['scripts/build-server.mjs'], { stdio: 'inherit' })
const validation = JSON.parse(execFileSync('claude', ['plugin', 'validate', 'plugin', '--json'], { encoding: 'utf8' }))
if (validation.success !== true) {
  console.error(JSON.stringify(validation, null, 2))
  process.exit(1)
}
execFileSync('claude', ['plugin', 'test', 'plugin'], { stdio: 'inherit' })
