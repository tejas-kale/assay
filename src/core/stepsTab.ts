// What the Steps tab says about a step and what its keys mean; the component only draws and sends.
import type { Step, StepCheck } from './steps.ts'

export const STATUS_TEXT: Record<Step['status'], string> = { pending: 'waiting', running: 'running', ok: 'ok', error: 'failed', skipped: 'skipped' }

/** A check line: `unchecked` is dimmed with a dot; the others are marked passed or failed. */
export function checkLine(check: Pick<StepCheck, 'kind' | 'ok'>): { className: string; mark: string } {
  if (check.kind === 'unchecked') return { className: 'dim', mark: '·' }
  return check.ok ? { className: 'check-ok', mark: '✓' } : { className: 'check-bad', mark: '✗' }
}

export const rowsLabel = (rows: number): string => `${String(rows)} ${rows === 1 ? 'row' : 'rows'}`

export type StepsKey = 'code' | 'pin' | 'previousRun' | 'nextRun' | 'down' | 'up' | 'rerun'

const STEPS_KEYS: Record<string, StepsKey> = { c: 'code', p: 'pin', ',': 'previousRun', '.': 'nextRun', j: 'down', k: 'up', r: 'rerun' }

export function stepsKey(key: string): StepsKey | undefined {
  return Object.hasOwn(STEPS_KEYS, key) ? STEPS_KEYS[key] : undefined
}
