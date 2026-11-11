// Every hook event that changes what Claude is doing (plugin/hooks/hooks.json) records it for the analysis strip.
// Writes nothing back, so it never changes the prompt or the tool call. Outside an Assay session it does nothing.
import { readInput } from './io.ts'
import { recordState } from './recordState.ts'

await recordState(await readInput(), process.env.ASSAY_ANALYSIS, new Date())
