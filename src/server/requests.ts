// The app's requests, ported from the analysis mod (hooks/register.tsx): `.assay/requests/<id>.json` in,
// `.assay/replies/<id>.json` out, polled every 500 ms. Interrupt, restart and the trust requests are taken at once,
// even while a run is in progress; the rest go oldest first, one at a time.
import { readFile } from 'node:fs/promises'

import { queryLabel } from '../core/pythonRuns.ts'
import { parseRequestFile, isUrgent } from '../core/requests.ts'
import type { Proposal, ServerRequest } from '../core/requests.ts'
import { pythonBody, pythonHeader } from '../core/pythonRuns.ts'
import { Assay } from './assay.ts'
import { TrustReviews } from './trust.ts'

const REQUESTS = '.assay/requests'
const REPLIES = '.assay/replies'
export const POLL_MS = 500

export type ReplyBody = { number: number } | { ok: true } | { error: string } | { proposals: Proposal[] }

export class Requests {
  private readonly assay: Assay
  readonly trust: TrustReviews
  private readonly taking = new Set<string>()
  private polling = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(assay: Assay) {
    this.assay = assay
    this.trust = new TrustReviews(assay)
  }

  start() {
    this.stop()
    this.timer = setInterval(() => void this.poll().catch(() => undefined), POLL_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async reply(id: string, body: ReplyBody) {
    await this.assay.writeAtomic(`${REPLIES}/${id}.json`, `${JSON.stringify({ id, ...body })}\n`).catch(() => undefined)
  }

  /** The names of the waiting request files, oldest first. A name starting with `.` is a file being written. */
  private async waiting(): Promise<string[]> {
    return (await this.assay.names(REQUESTS)).filter(name => !name.startsWith('.') && name.endsWith('.json')).sort()
  }

  private async handle(name: string) {
    if (this.taking.has(name)) return
    this.taking.add(name)
    try {
      const path = this.assay.at(`${REQUESTS}/${name}`)
      const text = await readFile(path, 'utf8').catch(() => undefined)
      if (text === undefined) return
      // Gone before it runs, so a crash never runs it twice.
      await this.assay.remove(path)
      const id = name.slice(0, -'.json'.length)
      const request = parseRequestFile(text)
      await this.reply(id, 'error' in request ? request : await this.perform(request))
    } finally {
      this.taking.delete(name)
    }
  }

  /** One poll. A poll during another's run takes only the urgent requests. */
  async poll() {
    const names = await this.waiting()
    for (const name of names) {
      const request = parseRequestFile(await readFile(this.assay.at(`${REQUESTS}/${name}`), 'utf8').catch(() => ''))
      if (!('error' in request) && isUrgent(request)) await this.handle(name)
    }
    if (this.polling) return
    this.polling = true
    try {
      for (const name of names) await this.handle(name)
    } finally {
      this.polling = false
    }
  }

  /** What one request does, and its reply. */
  async perform(request: ServerRequest): Promise<ReplyBody> {
    const assay = this.assay
    switch (request.kind) {
      case 'sql': {
        let number: number | undefined
        const header = `-- author: user\n${request.from ? `-- from: ${queryLabel(request.from)}\n` : ''}`
        await assay.runSql(request.sql, request.slug, request.engine, header, claimed => (number = claimed)).catch(() => undefined)
        if (number === undefined) return { error: 'The run could not start.' }
        await assay.recordUserRun({ number, language: 'sql', ...(request.from ? { from: request.from } : {}) })
        return { number }
      }
      case 'python': {
        const header = pythonHeader({ author: 'user', ...(request.from ? { from: request.from } : {}) })
        const ran = await assay.runPython(request.code, request.slug, header).catch(() => undefined)
        if (ran?.number === undefined) return { error: ran?.text ?? 'The run could not start.' }
        await assay.recordUserRun({ number: ran.number, language: 'python', ...(request.from ? { from: request.from } : {}) })
        return { number: ran.number }
      }
      case 'interrupt': {
        const failed = await assay.interruptKernel()
        return failed ? { error: failed } : { ok: true }
      }
      case 'restart': {
        const failed = await assay.restartKernel()
        return failed ? { error: failed } : { ok: true }
      }
      case 'replay':
        return this.replay(request.runs)
      case 'trust-list':
        return { proposals: (await this.trust.proposals()).map(({ name, kind, folder }) => ({ name, kind, folder })) }
      case 'trust-check': {
        const failed = await this.trust.check(request.name)
        return failed ? { error: failed } : { ok: true }
      }
      case 'trust-answer': {
        const failed = await this.trust.answer(request.name, request.answer)
        return failed ? { error: failed } : { ok: true }
      }
    }
  }

  /**
   * Replays Python runs in a new kernel, each as a new run marked `# replay: NNN`, stopping at the first that does
   * not end ok. Nothing runs when a listed number is not a Python run.
   */
  private async replay(numbers: readonly number[]): Promise<{ ok: true } | { error: string }> {
    const assay = this.assay
    const queries = await assay.listQueries()
    const chosen: Awaited<ReturnType<Assay['listQueries']>> = []
    for (const number of numbers) {
      const query = queries.find(each => each.number === number)
      if (query?.language !== 'python') return { error: `Run ${queryLabel(number)} is not a Python run.` }
      chosen.push(query)
    }
    return assay.inKernel(async () => {
      const failed = await assay.restartKernel()
      if (failed) return { error: failed }
      for (const query of chosen) {
        const code = pythonBody(await assay.readText(Assay.codeFile(query)))
        const ran = await assay.runPythonNow(code, query.slug, pythonHeader({ author: 'user', replay: query.number }))
        if (ran.number !== undefined) await assay.recordUserRun({ number: ran.number, language: 'python', replay: query.number })
        if (ran.status !== 'ok') {
          const made = ran.number === undefined ? 'a new run' : `run ${queryLabel(ran.number)}`
          return { error: `Replay stopped at ${made} (replay of ${queryLabel(query.number)}): ${ran.status ?? 'error'}` }
        }
      }
      return { ok: true as const }
    })
  }
}
