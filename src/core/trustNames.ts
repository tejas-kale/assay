// The only file names a proposal may have, for approving (main/trustApprove.ts) and for the server's check.
import type { Proposal } from './requests.ts'

/** A file name that is one plain path segment: no folders, no dots-only, no NUL, no backslash. */
const isPlainSegment = (file: string): boolean => file !== '' && file !== '.' && file !== '..' && !/[/\\\0]/.test(file)

/** The file names a proposal of this kind and name may have. */
export function allowedNames(kind: Proposal['kind'], name: string): string[] {
  return kind === 'calculation' ? [`${name}.sql`, `${name}.py`, `test_${name}.py`, `${name}.test.yaml`, `${name}.rebuild.sql`] : [`${name}.yaml`, `${name}.test.yaml`]
}

/** Whether `file` is one of the proposal's own names, and nothing that could leave its folder. */
export const isProposalFile = (kind: Proposal['kind'], name: string, file: string): boolean => isPlainSegment(file) && allowedNames(kind, name).includes(file)
