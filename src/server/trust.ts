// The trust review, ported from the analysis mod's `/an trust` (hooks/register.tsx). The app starts it with a
// `trust-check` request and answers it with `trust-answer`; the server writes `.assay/trust/<name>.json` after every
// step. No tool of Claude's reaches here, so Claude can never promote.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DICTIONARIES, DRAFT_DICTIONARIES, DRAFT_TRUSTED, PROPOSAL_NAME, splitCheckEvents, TRUST_TAB, TRUSTED } from '../core/calculations.ts'
import type { CheckAnswer, CheckEvent, TrustFile } from '../core/calculations.ts'
import type { Proposal, TrustAnswer } from '../core/requests.ts'
import type { TrustState } from '../core/trust.ts'
import { Assay } from './assay.ts'
import { QUERY_TIMEOUT_MS } from './sqlRun.ts'

const TRUST_DIR = '.assay/trust'

type Review = {
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

const draftOf = (kind: Proposal['kind']) => (kind === 'calculation' ? DRAFT_TRUSTED : DRAFT_DICTIONARIES)

export class TrustReviews {
  private readonly assay: Assay
  /** The review that is checking or waiting for its answer: only one at a time. */
  private open: Review | undefined
  /** The name of a review being set up: claimed before the first await so two requests cannot both start. */
  private starting: string | undefined
  private writes: Promise<unknown> = Promise.resolve()
  /** Settles when the current review's checks are over; tests wait on it. */
  checked: Promise<void> = Promise.resolve()

  constructor(assay: Assay) {
    this.assay = assay
  }

  /** The proposals in this analysis: calculations in lib/trusted/, drafted entries in lib/dictionaries/. */
  async proposals(): Promise<(Proposal & { ext: string })[]> {
    const found: (Proposal & { ext: string })[] = []
    for (const name of (await this.assay.names(DRAFT_TRUSTED)).sort()) {
      const match = /^([a-z][a-z0-9_]*)\.(sql|py)$/.exec(name)
      if (match?.[1] && !match[1].startsWith('test_')) found.push({ name: match[1], kind: 'calculation', folder: DRAFT_TRUSTED, ext: match[2] ?? 'sql' })
    }
    for (const name of (await this.assay.names(DRAFT_DICTIONARIES)).sort()) {
      const match = /^([^.]+\.[^.]+\.[^.]+)\.yaml$/.exec(name)
      if (match?.[1]) found.push({ name: match[1].toLowerCase(), kind: 'dictionary', folder: DRAFT_DICTIONARIES, ext: 'yaml' })
    }
    return found
  }

  /** Starts checking one proposal; why not, if it cannot. The checks go on after this returns. */
  async check(name: string): Promise<string | undefined> {
    const busy = this.open?.name ?? this.starting
    if (busy) return `A review of ${busy} is in progress: answer it first.`
    this.starting = name
    try {
      const found = await this.proposals()
      const proposal = PROPOSAL_NAME.test(name) ? found.find(each => each.name === name) : undefined
      if (!proposal) return `No proposal ${name} in ${DRAFT_TRUSTED}/ or ${DRAFT_DICTIONARIES}/.`
      const isCalc = proposal.kind === 'calculation'
      const dest = join(this.assay.config.root, isCalc ? TRUSTED : DICTIONARIES)
      const kept = await readdir(dest).catch(() => [] as string[])
      const review: Review = {
        name,
        kind: proposal.kind,
        folder: this.assay.at(draftOf(proposal.kind)),
        dest,
        what: !isCalc ? 'dictionary entry' : proposal.ext === 'py' ? 'Python function' : 'SQL template',
        language: !isCalc ? 'yaml' : proposal.ext === 'py' ? 'python' : 'sql',
        replaces: kept.some(file => file === `${name}.sql` || file === `${name}.py` || file === `${name}.yaml`),
        startedAt: Date.now(),
        state: 'checking',
      }
      this.open = review
      this.checked = this.runChecks(review)
      return undefined
    } finally {
      this.starting = undefined
    }
  }

  /** The user's answer to a review whose checks all passed; why not, if it is not waiting for one. */
  async answer(name: string, said: TrustAnswer): Promise<string | undefined> {
    const review = this.open
    if (!review || review.name !== name || review.state !== 'asking') {
      return review?.name === name ? `The review of ${name} is ${review.state}, not waiting for an answer.` : `No review of ${name} is waiting for an answer.`
    }
    const answer = review.answer
    if (said !== 'trust' || !answer) {
      this.finish(review, 'rejected', `Rejected ${name}; the proposal stays in ${draftOf(review.kind)}/.`)
      await this.writes
      return undefined
    }
    // Taken now, so a second answer while this one commits is refused.
    review.state = 'approved'
    const promoted = await this.promote(review, answer)
    if ('failed' in promoted) {
      this.finish(review, 'error', promoted.failed)
      await this.writes
      return promoted.failed
    }
    this.assay.forgetCalculations()
    const kept = await this.removeDraft(review, promoted.written)
    const keptNote = kept.length === 0 ? '' : ` Kept the draft ${kept.join(', ')}: it changed after the check.`
    const message = `${promoted.isUnchanged ? 'Already trusted: no changes.' : `Trusted ${name}: committed in ${review.kind === 'calculation' ? TRUSTED : DICTIONARIES}/.`}${keptNote}`
    this.finish(review, promoted.isUnchanged ? 'unchanged' : 'approved', message)
    await this.writes
    return undefined
  }

  private trustFile(review: Review): TrustFile {
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

  /** `.assay/trust/<name>.json`, written to a temp file and renamed into place; writes go in order, so the last state wins. */
  private changed(review: Review) {
    const text = `${JSON.stringify(this.trustFile(review), null, 2)}\n`
    this.writes = this.writes.then(() => this.assay.writeAtomic(`${TRUST_DIR}/${review.name}.json`, text)).catch(() => undefined)
  }

  private finish(review: Review, state: TrustState, message: string) {
    review.state = state
    review.message = message
    review.endedAt = Date.now()
    if (this.open === review) this.open = undefined
    this.changed(review)
  }

  /** Takes one streamed event into the review. Returns the helper's error when it ended with one. */
  private take(review: Review, event: CheckEvent): string | undefined {
    if (event.event === 'start') {
      review.answer = {
        name: event.name,
        ok: false,
        steps: [],
        ...(event.kind ? { kind: event.kind } : {}),
        ...(event.file ? { file: event.file } : {}),
        ...(event.description ? { description: event.description } : {}),
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.files ? { files: event.files } : {}),
      }
      if (event.kind === 'python') [review.what, review.language] = ['Python function', 'python']
      else if (event.kind === 'sql') [review.what, review.language] = [event.block ? 'SQL block' : 'SQL template', 'sql']
    } else if (event.event === 'step') {
      review.answer ??= { name: review.name, ok: false, steps: [] }
      review.answer.steps = [...review.answer.steps, event.step]
    } else if ('error' in event.answer) {
      this.changed(review)
      return event.answer.error
    } else {
      review.answer = event.answer
    }
    this.changed(review)
    return undefined
  }

  /** Runs the helper's checks, streamed, into the review. Returns why it could not, or undefined when it finished. */
  private async stream(review: Review): Promise<string | undefined> {
    const python = await this.assay.toolsPython()
    if (!python) return this.assay.venvHint()
    const analysis = this.assay.config.analysis
    const args =
      review.kind === 'calculation' ? ['check', review.folder, review.name, analysis, '--stream'] : ['check-entry', `${review.folder}/${review.name}.yaml`, analysis, '--stream']
    let buffer = ''
    let stderr = ''
    let failure: string | undefined
    let isDone = false
    let isTimedOut = false
    const child = this.assay.config.proc.spawn([python, '-m', 'analysis_trust', ...args], { cwd: analysis })
    const timer = setTimeout(() => {
      isTimedOut = true
      child.kill()
    }, QUERY_TIMEOUT_MS)
    // The timer alone never keeps the server alive.
    timer.unref?.()
    child.onOutput((stream, text) => {
      if (isDone) return
      if (stream === 'stderr') {
        stderr = (stderr + text).slice(-2000)
        return
      }
      const parsed = splitCheckEvents(buffer + text)
      buffer = parsed.rest
      for (const event of parsed.events) {
        if (isDone) break
        if (event.event === 'done') isDone = true
        failure = this.take(review, event) ?? failure
      }
      // `done` is the last line: the process is over for this review, however it ends.
      if (isDone) child.kill()
    })
    const code = await child.exited
    clearTimeout(timer)
    if (!isDone && buffer.trim()) {
      for (const event of splitCheckEvents(`${buffer}\n`).events) {
        if (event.event === 'done') isDone = true
        failure = this.take(review, event) ?? failure
      }
    }
    if (failure) return failure
    if (isDone) return undefined
    if (isTimedOut) return `The checks took more than ${QUERY_TIMEOUT_MS / 60_000} minutes and were stopped.`
    return (stderr.trim() || `analysis_trust exited with ${code}`).split('\n').slice(-3).join(' ')
  }

  /** The checks, then `asking` when every check passed (the app shows Trust and Reject), else `failed` or `error`. */
  private async runChecks(review: Review) {
    this.changed(review)
    const failure = await this.stream(review).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    if (failure !== undefined) this.finish(review, 'error', failure)
    else if (!review.answer?.ok) this.finish(review, 'failed', `Not approvable: fix the proposal, then check ${review.name} again in ${TRUST_TAB}.`)
    else {
      review.state = 'asking'
      this.changed(review)
    }
    await this.writes
  }

  /**
   * Approving: the files as checked go into the shared folder's trusted/ or dictionaries/, committed there alone.
   * Says why it could not, or whether the files equalled the trusted version (nothing to commit).
   */
  private async promote(review: Review, answer: CheckAnswer): Promise<{ failed: string } | { isUnchanged: boolean; written: { file: string; text: string }[] }> {
    const home = this.assay.config.root
    const git = (args: readonly string[]) =>
      this.assay.config.proc
        .run(['git', '-C', home, ...args], { cwd: this.assay.config.analysis })
        .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
    const top = await git(['rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) return { failed: `${home} is not in a git repository: approving commits there.` }
    const made = await mkdir(review.dest, { recursive: true }).then(
      () => true,
      () => false,
    )
    if (!made) return { failed: `Cannot make ${review.dest}.` }
    const paths: string[] = []
    const written: { file: string; text: string }[] = []
    for (const file of answer.files ?? []) {
      // The main file is written as it was checked, whatever happened to it since.
      const text = file === answer.file && answer.code !== undefined ? answer.code : await readFile(`${review.folder}/${file}`, 'utf8').catch(() => undefined)
      if (text === undefined) return { failed: `Cannot read ${review.folder}/${file}.` }
      await writeFile(`${review.dest}/${file}`, text, 'utf8')
      paths.push(`${review.dest}/${file}`)
      written.push({ file, text })
    }
    const added = await git(['add', '--', ...paths])
    if (added.exitCode !== 0) return { failed: `git add failed: ${added.stderr.trim()}` }
    // Nothing staged for these paths: they equal the trusted version.
    const staged = await git(['diff', '--cached', '--quiet', '--', ...paths])
    if (staged.exitCode === 0) return { isUnchanged: true, written }
    const committed = await git(['commit', '-q', '-m', `trusted: approve ${review.name}`, '-m', "Approved by the user in Assay's Trust tab.", '--', ...paths])
    if (committed.exitCode !== 0) return { failed: `git commit failed: ${(committed.stderr.trim() || committed.stdout.trim()).split('\n').at(-1)}` }
    return { isUnchanged: false, written }
  }

  /**
   * After approving: each draft file that still holds what was approved is removed, so the only copy is the trusted
   * one. One changed since the check is kept, so no edit is lost; its path (from the analysis) comes back.
   */
  private async removeDraft(review: Review, written: readonly { file: string; text: string }[]): Promise<string[]> {
    if (review.folder === review.dest) return []
    const kept: string[] = []
    for (const { file, text } of written) {
      const path = `${review.folder}/${file}`
      const now = await readFile(path, 'utf8').catch(() => undefined)
      if (now === undefined) continue
      if (now === text) await this.assay.remove(path)
      else kept.push(`${draftOf(review.kind)}/${file}`)
    }
    return kept
  }
}
