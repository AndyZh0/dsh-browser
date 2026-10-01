/** Serve the browser-tool fixture, including pages that fail, on loopback. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const page = await readFile(resolve(import.meta.dirname, 'index.html'))
const boom = '<!doctype html><html><head><meta charset="utf-8"><title>boom</title></head><body>'
  + '<h1 id="heading">boom page</h1><p id="note">this page threw while parsing</p>'
  + '<script>throw new Error("deliberate parse-time failure")<\/script></body></html>'
const partial = '<!doctype html><html><head><meta charset="utf-8"><title>partial</title></head><body>'
  + '<h1 id="heading">partial page</h1>'
  + '<script>setTimeout(() => { throw new Error("deliberate deferred failure") }, 0)<\/script></body></html>'
const port = Number(process.argv[2] ?? 17873)

createServer((request, response) => {
  const url = request.url ?? '/'
  if (url === '/' || url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page)
    return
  }
  if (url === '/boom') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(boom)
    return
  }
  if (url === '/partial') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(partial)
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found')
}).listen(port, '127.0.0.1', () => { console.log('fixture listening on http://127.0.0.1:' + String(port) + '/') })
