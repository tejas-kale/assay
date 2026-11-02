// PreToolUse hook (plugin/hooks/hooks.json): see bashDecision in decide.ts.
import { bashDecision } from './decide.ts'
import { answer, readInput } from './io.ts'

answer(bashDecision(await readInput(), process.env))
