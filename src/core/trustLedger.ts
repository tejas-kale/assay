// The trust ledger: which files of a root's trusted/ and dictionaries/ the user approved, by hash (specs/trust-ledger.md).
// Pure: main reads and writes the file (main/trustLedger.ts); this module only decides what a ledger's text means.

import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** The root-specific ledger path shared by the app and terminal launcher. */
export const ledgerPath = (userData: string, realRoot: string): string =>
  join(userData, 'trust-ledger', `${createHash('sha256').update(realRoot).digest('hex')}.json`)

export type LedgerEntry = {
  kind: 'calculation' | 'dictionary'
  /** Root-relative path (trusted/calc.sql) to the sha256 hex of the approved bytes. */
  files: Record<string, string>
  approvedAt: string
  /** The git commit the approval made, or empty. Display only. */
  commit: string
}

export type Ledger = {
  version: 1
  entries: Record<string, LedgerEntry>
  /** Replaced entries, oldest first. */
  history: (LedgerEntry & { name: string })[]
}

export type ParsedLedger = { ledger: Ledger; problem: string | undefined }

export const emptyLedger = (): Ledger => ({ version: 1, entries: {}, history: [] })

const SHA256 = /^[0-9a-f]{64}$/
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function entryOf(value: unknown): LedgerEntry | undefined {
  if (!isRecord(value)) return undefined
  const { kind, files, approvedAt, commit } = value
  if ((kind !== 'calculation' && kind !== 'dictionary') || typeof approvedAt !== 'string' || typeof commit !== 'string' || !isRecord(files)) return undefined
  const clean: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [path, hash] of Object.entries(files)) {
    if (FORBIDDEN_KEYS.has(path) || typeof hash !== 'string' || !SHA256.test(hash)) return undefined
    clean[path] = hash
  }
  return { kind, files: { ...clean }, approvedAt, commit }
}

function shapeOf(value: unknown): Ledger | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries) || !Array.isArray(value.history)) return undefined
  const entries: Record<string, LedgerEntry> = {}
  for (const [name, raw] of Object.entries(value.entries)) {
    const entry = entryOf(raw)
    if (!entry || FORBIDDEN_KEYS.has(name)) return undefined
    Object.defineProperty(entries, name, { value: entry, enumerable: true, writable: true, configurable: true })
  }
  const history: Ledger['history'] = []
  for (const raw of value.history as unknown[]) {
    const entry = entryOf(raw)
    if (!entry || !isRecord(raw) || typeof raw.name !== 'string') return undefined
    history.push({ name: raw.name, ...entry })
  }
  return { version: 1, entries, history }
}

/** Strict: any wrong shape gives the empty ledger and a problem to show, so a damaged file trusts nothing. Never throws. */
export function parseLedger(text: string): ParsedLedger {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ledger: emptyLedger(), problem: 'The trust ledger is not valid JSON.' }
  }
  const ledger = shapeOf(raw)
  if (!ledger) return { ledger: emptyLedger(), problem: 'The trust ledger is not in the expected shape (version 1).' }
  return { ledger, problem: undefined }
}

export const serializeLedger = (ledger: Ledger): string => `${JSON.stringify(ledger, null, 2)}\n`

/** The key an entry is stored under: its kind and name, so a calculation and a dictionary entry of one name never collide. */
export const entryKey = (kind: LedgerEntry['kind'], name: string): string => `${kind}:${name}`

/** A new ledger with the entry under its kind and name; the entry it replaces moves to history. */
export function addEntry(ledger: Ledger, name: string, entry: LedgerEntry): Ledger {
  const key = entryKey(entry.kind, name)
  const old = Object.hasOwn(ledger.entries, key) ? ledger.entries[key] : undefined
  const history = old ? [...ledger.history, { name, ...old }] : ledger.history
  const entries: Record<string, LedgerEntry> = { ...ledger.entries }
  Object.defineProperty(entries, key, { value: entry, enumerable: true, writable: true, configurable: true })
  return { version: 1, entries, history }
}

/** True when some entry lists this root-relative path with exactly this sha256. */
export function isTrustedFile(ledger: Ledger, relPath: string, sha256: string): boolean {
  return Object.values(ledger.entries).some(entry => Object.hasOwn(entry.files, relPath) && entry.files[relPath] === sha256)
}
