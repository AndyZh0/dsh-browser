/** The in-page runtime: the facade, the request queue, and navigation refusal. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { pageScriptMain } from '../src/client/page-script.ts'

const ELEMENT = { tag: 'button', role: 'button', name: 'Go', selector: '#go', rect: { x: 0, y: 0, width: 10, height: 10 } }

/** Install the runtime in a page-like global with a stubbed agent. */
function install(): void {
  const dom = new JSDOM('<!doctype html><html><head><title>Fixture</title></head><body><button id="go">Go</button></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location })
  Object.assign(globalThis, {
    __dshBrowserAgent: {
      version: 1,
      resolve: () => ({ ok: true, value: ELEMENT }),
      queryAll: () => ({ ok: true, value: [ELEMENT] }),
      read: () => ({ ok: true, value: { mode: 'text', content: 'body text', cursor: 0, truncated: false } }),
      fill: () => ({ ok: true, value: ELEMENT }),
      typeText: () => ({ ok: true, value: ELEMENT }),
      dragSynthetic: () => ({ ok: true, value: { source: ELEMENT, target: ELEMENT } }),
    },
  })
  globalThis.__dshBrowserScript = undefined
  assert.equal(pageScriptMain(), true)
}

test('navigation rejects instead of silently ending the script', async () => {
  install()
  const page = globalThis.__dshBrowserScript!.page as Record<string, () => Promise<unknown>>
  for (const name of ['goto', 'reload', 'goBack', 'goForward']) {
    await assert.rejects(page[name]!(), (error: unknown) => (error as { code?: string }).code === 'browser/not-in-script')
  }
})

test('reads and fills go straight through the page agent', async () => {
  install()
  const page = globalThis.__dshBrowserScript!.page as Record<string, (...args: readonly unknown[]) => Promise<unknown>>
  assert.deepEqual(await page.querySelector!('#go'), ELEMENT)
  assert.deepEqual(await page.querySelectorAll!('#go'), [ELEMENT])
  assert.equal(await page.textContent!(), 'body text')
  assert.deepEqual(await page.fill!('#go', 'x'), ELEMENT)
  // Nothing above needed the renderer.
  assert.equal(globalThis.__dshBrowserScript!.take(), null)
})

test('an embedder-only call is recorded and settled by the renderer', async () => {
  install()
  const runtime = globalThis.__dshBrowserScript!
  const page = runtime.page as Record<string, (...args: readonly unknown[]) => Promise<unknown>>
  const pending = page.screenshot!({ fullPage: true })
  const request = runtime.take()
  assert.equal(request?.method, 'screenshot')
  assert.deepEqual(request?.args, [{ fullPage: true }])
  runtime.settle(request!.id, true, { mediaType: 'image/png' })
  assert.deepEqual(await pending, { mediaType: 'image/png' })
})

test('a function evaluate stays in the page; a string one is delegated', async () => {
  install()
  const runtime = globalThis.__dshBrowserScript!
  const page = runtime.page as Record<string, (...args: readonly unknown[]) => Promise<unknown>>
  assert.equal(await page.evaluate!((value: unknown) => Number(value) + 1, 1), 2)
  assert.equal(runtime.take(), null)
  const pending = page.evaluate!('1 + 1')
  const request = runtime.take()
  assert.equal(request?.method, 'evaluate')
  runtime.settle(request!.id, true, 2)
  assert.equal(await pending, 2)
})

test('the console facade buffers lines until they are taken', () => {
  install()
  const runtime = globalThis.__dshBrowserScript!
  const log = runtime.console as Record<string, (...values: readonly unknown[]) => void>
  log.log!('hello', 1)
  assert.deepEqual(runtime.takeLogs(), ['hello 1'])
  assert.deepEqual(runtime.takeLogs(), [])
})
