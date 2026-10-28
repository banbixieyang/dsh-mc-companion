/**
 * Scenario runner: `npm run eval`, `node test/eval/run.mjs --filter=memory`.
 *
 * Prints one line per scenario, writes test/eval/last-run.json (handy as a
 * regression record when tuning prompts or tools), exits non-zero on failure.
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scenarios } from './scenarios.mjs'

const filterArg = process.argv.find((arg) => arg.startsWith('--filter='))
const filter = filterArg?.slice('--filter='.length) ?? null
const list = filter ? scenarios.filter((scenario) => scenario.id.includes(filter)) : scenarios

if (list.length === 0) {
  console.error(`no scenario matches "${filter}"`)
  process.exit(2)
}

const results = []
for (const [index, scenario] of list.entries()) {
  const started = Date.now()
  const label = String(index + 1).padStart(2, '0')
  try {
    await scenario.run()
    results.push({ id: scenario.id, title: scenario.title, ok: true, ms: Date.now() - started })
    console.log(`${label} PASS  ${scenario.id.padEnd(20)} ${scenario.title}`)
  } catch (error) {
    results.push({
      id: scenario.id,
      title: scenario.title,
      ok: false,
      ms: Date.now() - started,
      error: error?.message ?? String(error),
    })
    console.log(`${label} FAIL  ${scenario.id.padEnd(20)} ${scenario.title}`)
    console.log(`         ${error?.message ?? error}`)
  }
}

const passed = results.filter((result) => result.ok).length
const failed = results.length - passed
const totalMs = results.reduce((sum, result) => sum + result.ms, 0)
console.log(`\n${passed}/${results.length} passed, ${failed} failed, ${totalMs}ms`)

const reportFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'last-run.json')
await writeFile(
  reportFile,
  `${JSON.stringify({ at: new Date().toISOString(), passed, failed, total: results.length, results }, null, 2)}\n`,
)
console.log(`report: ${reportFile}`)

if (failed > 0) process.exitCode = 1
