// UserPromptSubmit hook (plugin/hooks/hooks.json): see promptDecision in decide.ts.
import { realProc } from '../server/proc.ts'
import { promptDecision } from './decide.ts'
import { answer, readInput } from './io.ts'

await readInput()
answer(await promptDecision(process.env, realProc))
