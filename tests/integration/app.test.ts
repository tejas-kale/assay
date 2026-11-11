// The app smoke test: the built app, launched by playwright-core's Electron driver (under xvfb-run on Linux), on a
// scratch user data folder and root, with tests/integration/fixtures/stub-claude.mjs as Claude and the fake
// `databricks` first on PATH. It opens the analysis, runs SQL from the Code tab with Cmd+Enter, and checks that Data
// shows the rows, History lists the run and Steps draws it. Never the user's own settings or analyses.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { _electron } from 'playwright-core'
import type { ElectronApplication, Page } from 'playwright-core'

import { until } from '../../src/server/testing.ts'
import { expect } from '../../src/testing/expect.ts'
import { FAKE_BIN, FIXTURES } from './harness.ts'

const REPO = resolve('.')
const run = promisify(execFile)

// Follows the SQL rules, so the server runs it; one CTE gives Steps a step to draw.
const SQL = 'WITH\n-- grain: site\nbig_sites AS (SELECT site, n FROM sites WHERE n > 1)\n-- grain: site\nSELECT site, n FROM big_sites'

/** A scratch home, user data folder and root holding one analysis. On Linux, user data is $XDG_CONFIG_HOME/assay. */
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'assay-app-'))
  const home = join(dir, 'home')
  const userData = join(dir, 'config', 'assay')
  const root = join(dir, 'root')
  await mkdir(join(root, 'analyses/panel'), { recursive: true })
  await writeFile(join(root, 'analyses/panel/analysis.yaml'), 'title: Panel sites\nprofile: P1\n')
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, 'settings.json'), `${JSON.stringify({ root }, null, 2)}\n`)
  const path = `${FAKE_BIN}:${process.env.PATH ?? ''}`
  // The app finds programs through the login shell (`bash -lic`), which reads this home's profile.
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.bash_profile'), `export PATH='${path}'\n`)
  const env = {
    ...process.env,
    HOME: home,
    SHELL: '/bin/bash',
    PATH: path,
    XDG_CONFIG_HOME: join(dir, 'config'),
    ASSAY_CLAUDE_BIN: join(FIXTURES, 'stub-claude.mjs'),
  } as Record<string, string>
  return { dir, userData, root, env }
}

/**
 * Presses Cmd+<code> in the view showing `selector`, through main as a real key would: CDP's key events never reach
 * before-input-event. The view is found by its page, not by OS focus, which a virtual display may not give.
 */
async function cmdKey(app: ElectronApplication, selector: string, code: string) {
  const pressed = await app.evaluate(async ({ webContents }, key) => {
    for (const target of webContents.getAllWebContents()) {
      const shows = (await target.executeJavaScript(`document.querySelector(${JSON.stringify(key.selector)}) !== null`).catch(() => false)) as boolean
      if (!shows) continue
      for (const type of ['keyDown', 'keyUp']) {
        target.emit('before-input-event', { preventDefault: () => undefined }, { type, code: key.code, key: '', meta: true, control: false, shift: false, alt: false, isAutoRepeat: false })
      }
      return true
    }
    return false
  }, { selector, code })
  if (!pressed) throw new Error(`No view shows ${selector} to press Cmd+${code} in`)
}

/** The page showing `selector`: the analysis view among the window's views (the strip is another). */
async function pageWith(app: ElectronApplication, selector: string): Promise<Page> {
  let found: Page | undefined
  await until(async () => {
    for (const page of app.context().pages()) if ((await page.locator(selector).count().catch(() => 0)) > 0) found = page
    return found !== undefined
  }, 60_000)
  if (!found) throw new Error(`No page shows ${selector}`)
  return found
}

/** The dev venv's build, from the status file the app writes beside it. */
const venvBuild = async (userData: string) => {
  const text = await readFile(join(userData, 'venvs', 'dev.status.json'), 'utf8').catch(() => '{}')
  return JSON.parse(text) as { state?: string; error?: string }
}

// Linux only: there XDG_CONFIG_HOME moves user data to the scratch folder. On a Mac the app would start with the real
// settings, and could reopen real analyses, before the user data check below could stop it. Linux needs a display: CI
// gives one with xvfb-run; a container without one (Claude's sandbox) skips the test.
const SKIP = process.platform === 'linux' ? !process.env.DISPLAY && 'no display: run under xvfb-run' : 'Linux only: on a Mac the app would read the real settings'

test('the built app opens an analysis, runs SQL from the Code tab, and shows it in Data, History and Steps', { timeout: 600_000, skip: SKIP }, async (t) => {
  await run('npx', ['electron-vite', 'build'], { cwd: REPO })
  await run('npm', ['run', 'build:server'], { cwd: REPO })
  const s = await scratch()
  t.after(() => rm(s.dir, { recursive: true, force: true, maxRetries: 3 }))
  // --no-sandbox: CI's runners cannot give Chromium's sandbox helper its setuid bit.
  const app = await _electron.launch({ args: [REPO, '--no-sandbox'], cwd: REPO, env: s.env })
  // The close flow waits for each Claude to exit; a stuck one must not hang the run.
  t.after(async () => {
    await Promise.race([app.close(), new Promise(done => setTimeout(done, 15_000))])
    app.process().kill('SIGKILL')
  })

  // Nothing is pressed until the app is known to use the scratch folder.
  expect(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))).toBe(s.userData)

  const page = await pageWith(app, '.picker')
  await page.locator('.picker').getByText('Panel sites').waitFor()
  await page.keyboard.press('Enter')
  await page.getByRole('tab', { name: 'Code' }).waitFor({ timeout: 60_000 })

  // SQL runs pass the SQL rules, which need Assay's venv: the app builds it with uv at launch.
  await until(async () => ['ready', 'failed'].includes((await venvBuild(s.userData)).state ?? ''), 300_000)
  expect(await venvBuild(s.userData)).toEqual({ state: 'ready' })

  await page.getByRole('tab', { name: 'Code' }).click()
  await page.getByText('No runs yet. n: new SQL query.').click()
  await page.keyboard.press('n')
  await page.locator('.code-view.editing .cm-content').waitFor()
  await page.keyboard.press('i')
  await page.keyboard.type(SQL)
  await cmdKey(app, '.code-view.editing', 'Enter')

  // A new query opens in Data, with the fake's rows.
  await page.getByText('south', { exact: true }).first().waitFor({ timeout: 60_000 })
  expect(await page.getByText('north', { exact: true }).count()).toBeGreaterThan(0)

  await page.getByRole('tab', { name: 'History' }).click()
  await page.getByRole('listbox', { name: 'Runs' }).locator('.run-number', { hasText: '001' }).waitFor()

  await page.getByRole('tab', { name: 'Steps' }).click()
  await page
    .locator('.step-detail')
    .getByText('big_sites')
    .waitFor({ timeout: 60_000 })
    .catch(async (error: unknown) => {
      console.error(await whatStepsShows(page, join(s.root, 'analyses/panel')))
      throw error
    })
})

/** What the Steps tab shows and the files behind it, for a failed run's log: CI has no screen to look at. */
async function whatStepsShows(page: Page, analysis: string): Promise<string> {
  const shown = await page.locator('.run').first().innerText().catch((error: unknown) => `(no .run: ${String(error)})`)
  const parts = [`Steps tab shows:\n${shown}`]
  for (const folder of ['queries', '.assay', '.assay/replies']) {
    const names = await readdir(join(analysis, folder)).catch(() => [])
    parts.push(`${folder}/: ${names.join(' ')}`)
    for (const name of names.filter(each => /\.(json|sql)$/.test(each))) {
      parts.push(`--- ${folder}/${name}\n${await readFile(join(analysis, folder, name), 'utf8').catch(() => '(unreadable)')}`)
    }
  }
  return parts.join('\n')
}
