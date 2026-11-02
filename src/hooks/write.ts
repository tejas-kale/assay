// PreToolUse hook (plugin/hooks/hooks.json): see writeDecision in decide.ts.
import { writeDecision } from './decide.ts'
import { answer, readInput } from './io.ts'

answer(writeDecision(await readInput(), process.env))
