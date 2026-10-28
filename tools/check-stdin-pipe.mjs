#!/usr/bin/env node
/**
 * Can this environment spawn a child with only its stdin piped?
 *
 * The sandbox forbids *capturing* a child's output through pipes; the question
 * here is whether writing to a child's stdin (needed to drive a test server's
 * console) is allowed. Prints the result and exits 0 when stdin pipes work.
 */
import { spawn } from 'node:child_process'

const childScript = 'process.stdin.once("data", d => process.exit(d.toString().trim() === "ping" ? 0 : 3))'
const child = spawn(process.execPath, ['-e', childScript], { stdio: ['pipe', 'ignore', 'ignore'] })

const result = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, why: 'timeout' }), 5000)
  child.once('error', (error) => {
    clearTimeout(timer)
    resolve({ ok: false, why: error.code ?? error.message })
  })
  child.once('exit', (code) => {
    clearTimeout(timer)
    resolve({ ok: code === 0, why: `exit ${code}` })
  })
  try {
    child.stdin.write('ping\n')
  } catch (error) {
    clearTimeout(timer)
    resolve({ ok: false, why: error.code ?? error.message })
  }
})

console.log(result.ok ? 'stdin pipe: allowed' : `stdin pipe: blocked (${result.why})`)
process.exitCode = result.ok ? 0 : 1
