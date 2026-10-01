/** Build the Host module and the DSH Client module factory. */
import { mkdir } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const CLIENT_ID = 'dsh-browser'

/** Resolve esbuild from this directory, else from the adjacent checkout's pnpm store. */
async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
  const store = resolve(process.cwd(), '../../node_modules/.pnpm')
  const candidates = readdirSync(store)
    .filter(name => name.startsWith('esbuild@'))
    .map(name => ({ name, version: name.slice('esbuild@'.length).split('.').map(Number) }))
    .filter(entry => entry.version.every(part => Number.isFinite(part)))
    .sort((left, right) => compareVersions(right.version, left.version))
  for (const candidate of candidates) {
    const entry = resolve(store, candidate.name, 'node_modules/esbuild/lib/main.js')
    try {
      return await import(pathToFileURL(entry).href)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error('esbuild is unavailable: install it here or build the adjacent DSH checkout')
}

/** Compare two numeric version tuples, highest first. */
function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const { build } = await loadEsbuild()
await mkdir('lib', { recursive: true })
await build({
  entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, format: 'esm',
  platform: 'node', target: 'es2022', external: ['@deepseek-ai/*'], sourcemap: true,
})
await build({
  entryPoints: ['src/client.ts'], outfile: 'lib/client.js', bundle: true, format: 'cjs',
  platform: 'browser', target: 'es2022', external: ['@deepseek-ai/*'], sourcemap: true,
  banner: { js: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(CLIENT_ID) + ', factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})
console.log('Built the dsh-browser Host module and Client factory.')