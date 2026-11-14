import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COVERAGE_FILE, analysisCoverage, parseCoverage, runCoverage, sqlTokens } from './coverage.ts'

test('sqlTokens lexes SQL tokens and ignores comments and whitespace', () => {
  const sql = [
    '-- leading comment with words',
    'SELECT s.buyer_id, /* block',
    "   comment */ 'it''s ok' AS label, \"quoted\"\"id\", `back``tick`, 3.14",
    'FROM cint.mkt.sessions AS s',
    "WHERE s.created >= '2026-11-01'::date AND s.status <> 0 AND s.tag != 'x' OR a <= b OR c || d => e",
  ].join('\n')
  assert.deepEqual(sqlTokens(sql), [
    'SELECT', 's', '.', 'buyer_id', ',', "'it''s ok'", 'AS', 'label', ',', '"quoted""id"', ',', '`back``tick`', ',', '3.14',
    'FROM', 'cint', '.', 'mkt', '.', 'sessions', 'AS', 's',
    'WHERE', 's', '.', 'created', '>=', "'2026-11-01'", '::', 'date',
    'AND', 's', '.', 'status', '<>', '0', 'AND', 's', '.', 'tag', '!=', "'x'",
    'OR', 'a', '<=', 'b', 'OR', 'c', '||', 'd', '=>', 'e',
  ])
})

test('a trusted SQL run counts as 100% trusted, and Python runs (including trusted Python) are excluded', () => {
  const trustedSql = '-- trusted: completes_by_site\n-- args: {"start":"2026-01-01"}\n-- commit: abc123\nSELECT site_id, count(*) AS completes FROM surveys GROUP BY site_id\n'
  const trustedPy = '-- trusted: top_sites\n-- args: {}\n-- commit: 012345\n-- python: trusted/top_sites.py\n'
  const plainPy = '# author: claude\nimport pandas as pd\nprint(1)\n'

  assert.deepEqual(runCoverage({ language: 'sql', code: trustedSql }), { trustedTokens: 14, totalTokens: 14 })
  assert.deepEqual(runCoverage({ language: 'sql', code: trustedPy }), { trustedTokens: 0, totalTokens: 0 })
  assert.deepEqual(runCoverage({ language: 'python', code: plainPy }), { trustedTokens: 0, totalTokens: 0 })

  assert.deepEqual(
    analysisCoverage([
      { language: 'sql', code: trustedSql },
      { language: 'sql', code: trustedPy },
      { language: 'python', code: plainPy },
    ]),
    { trustedTokens: 14, totalTokens: 14, coverage: 1 },
  )
})

test('a partial include counts the expanded tokens from approved blocks and definitions over the expanded SQL', () => {
  const written = [
    '-- built from: client_entry_sessions@1a2b3c, cint.mkt.sessions:active@abcdef',
    'WITH',
    '-- grain: session_id',
    "sessions AS ({{ client_entry_sessions(start => '2026-11-01') }})",
    '-- grain: none',
    'SELECT count(*) AS n FROM sessions AS s WHERE {{ active(s) }}',
  ].join('\n')
  const blockExpanded = "SELECT session_id, status FROM cint.mkt.sessions WHERE day >= CAST('2026-11-01' AS DATE)"
  const defExpanded = '(s.status = 3)'
  const expanded = [
    '-- blocks: sessions=client_entry_sessions',
    'WITH',
    '-- grain: session_id',
    `sessions AS (${blockExpanded})`,
    '-- grain: none',
    `SELECT count(*) AS n FROM sessions AS s WHERE ${defExpanded}`,
  ].join('\n')

  assert.equal(sqlTokens(blockExpanded).length, 19)
  assert.equal(sqlTokens(defExpanded).length, 7)
  assert.deepEqual(runCoverage({ code: written, expanded }), {
    trustedTokens: 26,
    totalTokens: 17 + 26,
  })
})

test('analysisCoverage sums across plain, partial-include, and trusted SQL runs, and returns null when no SQL tokens exist', () => {
  assert.deepEqual(analysisCoverage([]), { trustedTokens: 0, totalTokens: 0, coverage: null })
  assert.deepEqual(analysisCoverage([{ language: 'python', code: 'x = 1' }]), { trustedTokens: 0, totalTokens: 0, coverage: null })

  const plain = 'SELECT 1 AS a, 2 AS b'
  const trusted = '-- trusted: t\nSELECT 1 AS a'
  assert.deepEqual(analysisCoverage([{ code: plain }, { code: trusted }]), {
    trustedTokens: 4,
    totalTokens: 12,
    coverage: 4 / 12,
  })
})

test('parseCoverage reads .assay/coverage.json safely', () => {
  assert.equal(COVERAGE_FILE, '.assay/coverage.json')
  assert.deepEqual(parseCoverage('{"trustedTokens":6,"totalTokens":10,"coverage":0.6}\n'), {
    trustedTokens: 6,
    totalTokens: 10,
    coverage: 0.6,
  })
  assert.deepEqual(parseCoverage('{"trustedTokens":0,"totalTokens":0,"coverage":null}'), {
    trustedTokens: 0,
    totalTokens: 0,
    coverage: null,
  })
  assert.equal(parseCoverage(''), undefined)
  assert.equal(parseCoverage('{bad'), undefined)
  assert.equal(parseCoverage('null'), undefined)
  assert.equal(parseCoverage('{"trustedTokens":"6","totalTokens":10,"coverage":0.6}'), undefined)
  assert.equal(parseCoverage('{"trustedTokens":6,"totalTokens":10,"coverage":"0.6"}'), undefined)
})
