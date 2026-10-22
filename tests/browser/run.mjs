#!/usr/bin/env node
/**
 * Headless-browser check for the Web settings page.
 *
 * `npm test` covers the host half and the page's wiring with doubles; this
 * script renders the real component with the real React in headless Chrome and
 * drives it (add a user, toggle, save, remove) the way a person would.
 *
 * It is deliberately outside `npm run check`: it needs `google-chrome` on the
 * machine and the two React development builds (webpack-style UMD files under
 * `node_modules/react/umd`), which are devDependencies. Missing prerequisites
 * exit 0 with a note instead of failing a build on a machine without Chrome.
 *
 *   npm run test:browser
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const harness = join(here, 'settings-harness.html')

const CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
const chrome = process.env.CHROME_PATH ?? CANDIDATES.find((candidate) => {
  const found = spawnSync('sh', ['-c', `command -v ${candidate}`], { encoding: 'utf8' })
  return found.status === 0
})

if (!chrome) {
  console.log('test:browser — skipped: no Chrome/Chromium found (set CHROME_PATH to run it)')
  process.exit(0)
}
for (const build of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
  if (!existsSync(join(root, 'node_modules', build))) {
    console.log(`test:browser — skipped: node_modules/${build} is missing (npm install)`)
    process.exit(0)
  }
}

const run = spawnSync(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=900,1600',
    '--virtual-time-budget=8000',
    '--dump-dom',
    `file://${harness}`,
  ],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
)

if (run.error) {
  console.error(`test:browser — could not run ${chrome}: ${run.error.message}`)
  process.exit(1)
}
const dom = run.stdout ?? ''
const lines = [...dom.matchAll(/<div class="(pass|fail)">([\s\S]*?)<\/div>/g)]
  .map((match) => ({ ok: match[1] === 'pass', text: match[2].replace(/<[^>]+>/g, '').trim() }))
const failed = lines.filter((line) => !line.ok)
for (const line of lines) console.log(`${line.ok ? 'ok  ' : 'FAIL'} ${line.text}`)
const verdict = /data-harness="ok"/.test(dom)
if (!verdict || failed.length > 0) {
  if (lines.length === 0) console.error(dom.slice(0, 4000))
  console.error(`test:browser — ${failed.length} failed check(s)`)
  process.exit(1)
}
console.log(`test:browser — ${lines.length} checks passed in ${chrome}`)
