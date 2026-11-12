// A trust review as the server keeps it: what it is, what the helper's events add to it, and the `.assay/trust/<name>.json`
// the app's Trust tab reads. The class in trust.ts owns the one review that is open.
import { DICTIONARIES, DRAFT_DICTIONARIES, DRAFT_TRUSTED, TRUSTED } from '../core/calculations.ts'
import type { CheckAnswer, CheckEvent, TrustFile } from '../core/calculations.ts'
import type { Proposal } from '../core/requests.ts'
import type { TrustState } from '../core/trust.ts'

export type Review = {
  name: string
  kind: Proposal['kind']
  /** The proposal's folder, and where approving copies it, both absolute. */
  folder: string
  dest: string
  what: TrustFile['what']
  language: TrustFile['language']
  /** Whether approving replaces a version in the shared folder. */
  replaces: boolean
  startedAt: number
  state: TrustState
  endedAt?: number
  message?: string
  /** What the checks found so far, kept up to date as the helper streams. */
  answer?: CheckAnswer
}

/** The analysis folder a proposal of this kind is drafted in (relative to the analysis). */
export const draftOf = (kind: Proposal['kind']) => (kind === 'calculation' ? DRAFT_TRUSTED : DRAFT_DICTIONARIES)

/** The shared folder approving copies a proposal of this kind into (relative to the root). */
export const sharedOf = (kind: Proposal['kind']) => (kind === 'calculation' ? TRUSTED : DICTIONARIES)

/** What a proposal is, from its kind and the extension of its file. */
export function describeProposal(kind: Proposal['kind'], ext: string): Pick<Review, 'what' | 'language'> {
  if (kind !== 'calculation') return { what: 'dictionary entry', language: 'yaml' }
  return ext === 'py' ? { what: 'Python function', language: 'python' } : { what: 'SQL template', language: 'sql' }
}

/** The review as the Trust tab reads it. */
export function trustFile(review: Review): TrustFile {
  const answer = review.answer
  return {
    name: review.name,
    kind: review.kind,
    what: review.what,
    language: review.language,
    replaces: review.replaces,
    state: review.state,
    startedAt: review.startedAt,
    ...(review.endedAt === undefined ? {} : { endedAt: review.endedAt }),
    ...(answer?.description ? { description: answer.description } : {}),
    ...(answer?.code === undefined ? {} : { code: answer.code }),
    steps: answer?.steps ?? [],
    ...(answer?.sample ? { sample: answer.sample } : {}),
    ...(review.message ? { message: review.message } : {}),
  }
}

type StartEvent = Extract<CheckEvent, { event: 'start' }>

/** What the checks know when the helper says `start`: nothing passed yet. */
function startedAnswer(event: StartEvent): CheckAnswer {
  return {
    name: event.name,
    ok: false,
    steps: [],
    ...(event.kind ? { kind: event.kind } : {}),
    ...(event.file ? { file: event.file } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(event.code === undefined ? {} : { code: event.code }),
    ...(event.files ? { files: event.files } : {}),
  }
}

/** The helper knows more than the file's extension: a SQL block is not a template. */
function learnKind(review: Review, event: StartEvent) {
  if (event.kind === 'python') {
    review.what = 'Python function'
    review.language = 'python'
  } else if (event.kind === 'sql') {
    review.what = event.block ? 'SQL block' : 'SQL template'
    review.language = 'sql'
  }
}

/** Takes one streamed event into the review. Returns the helper's error when it ended with one. */
export function applyEvent(review: Review, event: CheckEvent): string | undefined {
  if (event.event === 'start') {
    review.answer = startedAnswer(event)
    learnKind(review, event)
  } else if (event.event === 'step') {
    review.answer ??= { name: review.name, ok: false, steps: [] }
    review.answer.steps = [...review.answer.steps, event.step]
  } else if ('error' in event.answer) {
    return event.answer.error
  } else {
    review.answer = event.answer
  }
  return undefined
}
