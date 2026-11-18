import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ACCEPTED, type AuditReport, auditProblems } from './audit-gate.ts'

const picomatch = { url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf', severity: 'high', title: 'ReDoS' }
const accepted = (fixAvailable: unknown = { name: 'vite', version: '6.2.7', isSemVerMajor: true }): AuditReport => ({
  vulnerabilities: {
    picomatch: { via: [picomatch], fixAvailable },
    vite: { via: ['picomatch', 'fdir'], fixAvailable },
  },
})

test('the picomatch advisory is the only one accepted, under its accepted-risk entry', () => {
  assert.deepEqual(ACCEPTED, { 'GHSA-fc5q-39xc-vjpf': { pkg: 'picomatch', entry: 'L-11' } })
})

test('an accepted advisory with only a breaking fix, and the packages that reach it by name, pass', () => {
  assert.deepEqual(auditProblems(accepted()), [])
})

test('moderate and low advisories are below the gate', () => {
  const report: AuditReport = { vulnerabilities: {
    ...accepted().vulnerabilities,
    minimatch: { via: [{ url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249', severity: 'moderate' }], fixAvailable: false },
  } }
  assert.deepEqual(auditProblems(report), [])
})

test('any other high or critical advisory fails, with or without a title', () => {
  const report: AuditReport = { vulnerabilities: {
    ...accepted().vulnerabilities,
    tar: { via: [{ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'critical', title: 'Path traversal' }], fixAvailable: true },
    ws: { via: [{ url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'high' }], fixAvailable: true },
  } }
  assert.deepEqual(auditProblems(report), ['tar: critical GHSA-aaaa-bbbb-cccc Path traversal', 'ws: high GHSA-dddd-eeee-ffff'])
})

test('the accepted advisory fails in any package but the one it is accepted in', () => {
  const report: AuditReport = { vulnerabilities: { ...accepted().vulnerabilities, micromatch: { via: [picomatch], fixAvailable: false } } }
  assert.deepEqual(auditProblems(report), ['micromatch: high GHSA-fc5q-39xc-vjpf ReDoS'])
})

test('an accepted advisory that npm audit fix can now fix fails, so the exception is dropped', () => {
  assert.deepEqual(auditProblems(accepted(true)), [
    'picomatch: GHSA-fc5q-39xc-vjpf (L-11) now has a fix: run npm audit fix and drop the exception',
  ])
})

test('an accepted advisory npm no longer reports fails, so the exception is dropped', () => {
  const stale = ['picomatch: GHSA-fc5q-39xc-vjpf (L-11) is no longer reported: drop the exception and its entry']
  assert.deepEqual(auditProblems({ vulnerabilities: {} }), stale)
  assert.deepEqual(auditProblems({}), stale)
})
