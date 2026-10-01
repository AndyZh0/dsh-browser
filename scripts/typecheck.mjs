/** Typecheck the Host and Client faces against the adjacent checkout's built declarations. */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('../..')
const tsc = resolve(root, 'node_modules/typescript/bin/tsc')
try {
  await access(tsc)
} catch (error) {
  throw new Error('Build the adjacent DSH checkout before typechecking: ' + tsc, { cause: error })
}

for (const face of ['host', 'client']) {
  const child = spawn(process.execPath, [tsc, '-p', 'tsconfig.' + face + '.json', '--pretty', 'false'], { stdio: 'inherit' })
  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject)
    child.once('exit', (status, signal) => { signal === null ? resolveCode(status) : reject(new Error('typechecker terminated: ' + signal)) })
  })
  if (code !== 0) {
    process.exitCode = Number(code ?? 1)
    break
  }
}
