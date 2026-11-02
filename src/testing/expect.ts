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

function matchers(actual: unknown, negate: boolean): Matchers {
  const check = (ok: boolean, message: string) => {
    if (ok === negate) assert.fail(`${negate ? 'not: ' : ''}${message}`)
  }
  const show = (v: unknown) => {
    try {
      return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (_, x) => (x instanceof Set ? [...x] : x))
    } catch {
      return String(v)
    }
  }
  return {
    toBe: expected => {
      if (!negate) assert.equal(actual, expected)
      else check(Object.is(actual, expected), `expected ${show(actual)} to be ${show(expected)}`)
    },
    toEqual: expected => {
      if (!negate) assert.deepStrictEqual(actual, expected)
      else check(isEqual(actual, expected), `expected ${show(actual)} to equal ${show(expected)}`)
    },
    toMatchObject: expected => check(matches(actual, expected), `expected ${show(actual)} to match ${show(expected)}`),
    toContain: expected => {
      const ok = typeof actual === 'string' ? actual.includes(String(expected)) : Array.isArray(actual) && actual.includes(expected)
      check(ok, `expected ${show(actual)} to contain ${show(expected)}`)
    },
    toContainEqual: expected => check(Array.isArray(actual) && actual.some(each => isEqual(each, expected)), `expected ${show(actual)} to contain ${show(expected)}`),
    toMatch: expected => {
      const text = String(actual)
      check(typeof expected === 'string' ? text.includes(expected) : expected.test(text), `expected ${show(actual)} to match ${String(expected)}`)
    },
    toBeUndefined: () => check(actual === undefined, `expected ${show(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, 'expected a value, got undefined'),
    toHaveLength: length => check((actual as { length?: unknown } | null)?.length === length, `expected ${show(actual)} to have length ${length}`),
    toBeGreaterThan: n => check((actual as number) > n, `expected ${show(actual)} > ${n}`),
    toBeGreaterThanOrEqual: n => check((actual as number) >= n, `expected ${show(actual)} >= ${n}`),
    toBeLessThan: n => check((actual as number) < n, `expected ${show(actual)} < ${n}`),
    toBeLessThanOrEqual: n => check((actual as number) <= n, `expected ${show(actual)} <= ${n}`),
  }
}

export function expect(actual: unknown): Matchers & { not: Matchers } {
  return { ...matchers(actual, false), not: matchers(actual, true) }
}
