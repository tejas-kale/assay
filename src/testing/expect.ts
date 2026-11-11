// A small jest-style `expect` over node:assert, so the tests ported from the analysis mod (which used
// `claude-code/testing`) keep their shape. Only the matchers those tests use.
import assert from 'node:assert/strict'

type Matchers = {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toMatchObject(expected: object): void
  toContain(expected: unknown): void
  toContainEqual(expected: unknown): void
  toMatch(expected: RegExp | string): void
  toBeUndefined(): void
  toBeDefined(): void
  toHaveLength(length: number): void
  toBeGreaterThan(n: number): void
  toBeGreaterThanOrEqual(n: number): void
  toBeLessThan(n: number): void
  toBeLessThanOrEqual(n: number): void
}

/** Whether `actual` holds every field of `expected` (recursively; arrays element by element). */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected)
  if (actual === null || typeof actual !== 'object') return false
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e))
  return Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value))
}

const isEqual = (a: unknown, b: unknown) => {
  try {
    assert.deepStrictEqual(a, b)
    return true
  } catch {
    return false
  }
}

/** How a matcher set reports: `check` fails when the claim's truth is not the one wanted; `toBe` and `toEqual` may use assert's own diffs. */
type Mode = {
  check: (ok: boolean, message: string) => void
  toBe: (actual: unknown, expected: unknown, message: string) => void
  toEqual: (actual: unknown, expected: unknown, message: string) => void
}

const positive: Mode = {
  check: (ok, message) => {
    if (!ok) assert.fail(message)
  },
  toBe: (actual, expected) => {
    assert.equal(actual, expected)
  },
  toEqual: (actual, expected) => {
    assert.deepStrictEqual(actual, expected)
  },
}

const negated: Mode = {
  check: (ok, message) => {
    if (ok) assert.fail(`not: ${message}`)
  },
  toBe: (actual, expected, message) => {
    negated.check(Object.is(actual, expected), message)
  },
  toEqual: (actual, expected, message) => {
    negated.check(isEqual(actual, expected), message)
  },
}

const show = (v: unknown): string => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (_key: string, x: unknown) => (x instanceof Set ? [...x] : x))
  } catch {
    return String(v)
  }
}

function ordering(actual: unknown, check: Mode['check']): Pick<Matchers, 'toBeGreaterThan' | 'toBeGreaterThanOrEqual' | 'toBeLessThan' | 'toBeLessThanOrEqual'> {
  const compare = (op: string, test: (n: number) => boolean) => (n: number) => {
    check(test(n), `expected ${show(actual)} ${op} ${String(n)}`)
  }
  return {
    toBeGreaterThan: compare('>', n => (actual as number) > n),
    toBeGreaterThanOrEqual: compare('>=', n => (actual as number) >= n),
    toBeLessThan: compare('<', n => (actual as number) < n),
    toBeLessThanOrEqual: compare('<=', n => (actual as number) <= n),
  }
}

function matchers(actual: unknown, mode: Mode): Matchers {
  const { check } = mode
  return {
    ...ordering(actual, check),
    toBe: expected => {
      mode.toBe(actual, expected, `expected ${show(actual)} to be ${show(expected)}`)
    },
    toEqual: expected => {
      mode.toEqual(actual, expected, `expected ${show(actual)} to equal ${show(expected)}`)
    },
    toMatchObject: expected => {
      check(matches(actual, expected), `expected ${show(actual)} to match ${show(expected)}`)
    },
    toContain: expected => {
      const ok = typeof actual === 'string' ? actual.includes(String(expected)) : Array.isArray(actual) && actual.includes(expected)
      check(ok, `expected ${show(actual)} to contain ${show(expected)}`)
    },
    toContainEqual: expected => {
      check(Array.isArray(actual) && actual.some(each => isEqual(each, expected)), `expected ${show(actual)} to contain ${show(expected)}`)
    },
    toMatch: expected => {
      const text = String(actual)
      check(typeof expected === 'string' ? text.includes(expected) : expected.test(text), `expected ${show(actual)} to match ${String(expected)}`)
    },
    toBeUndefined: () => {
      check(actual === undefined, `expected ${show(actual)} to be undefined`)
    },
    toBeDefined: () => {
      check(actual !== undefined, 'expected a value, got undefined')
    },
    toHaveLength: length => {
      check((actual as { length?: unknown } | null)?.length === length, `expected ${show(actual)} to have length ${String(length)}`)
    },
  }
}

export function expect(actual: unknown): Matchers & { not: Matchers } {
  return { ...matchers(actual, positive), not: matchers(actual, negated) }
}
