/** Assert the built Host and Client artifacts keep their loader contracts. */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const host = await import(pathToFileURL(resolve('lib/index.js')).href)
if (typeof host.apply !== 'function') throw new Error('lib/index.js must export apply')
if (typeof host.name !== 'string') throw new Error('lib/index.js must export name')
if (!Array.isArray(host.inject)) throw new Error('lib/index.js must export inject')
if (typeof host.Config !== 'function' && typeof host.Config !== 'object') throw new Error('lib/index.js must export Config')
if (Object.hasOwn(host, 'default')) throw new Error('lib/index.js must not default-export; the Loader discards the namespace')

const client = await readFile('lib/client.js', 'utf8')
const banner = 'window.__ModuleLoader__.load({ id: "dsh-browser", factory: (require) =>'
if (!client.includes(banner)) throw new Error('lib/client.js must register through window.__ModuleLoader__.load with id "dsh-browser"')
if (!client.includes('return module.exports; } });')) throw new Error('lib/client.js must return the module exports from its factory')
if (/^\s*import\s/m.test(client)) throw new Error('lib/client.js must not contain ESM import statements')
console.log('Artifact contracts hold.')
