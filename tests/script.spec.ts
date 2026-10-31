/** The renderer services what a page-hosted script cannot do for itself. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActionContext } from '../src/client/actions.ts'
import { DialogTracker } from '../src/client/dialogs.ts'
import { runBrowserScript } from '../src/client/script.ts'
import type { BrowserCommandLimits } from '../src/protocol.ts'
import type { WebviewElement } from '../src/client/webview.ts'

const ELEMENT = { tag: 'button', role: 'button', name: 'Clicked 0 times', selector: '#counter', rect: { x: 0, y: 0, width: 10, height: 10 } }

const LIMITS: BrowserCommandLimits = {
  lingerMs: 2_000,
  maxReadChars: 40_000,
  maxOutputChars: 50_000,
  operationTimeoutMs: 30_000,
  codeTimeoutMs: 180_000,
  maxFullPageTiles: 8,
  backgroundCaptureWidth: 1_024,
  backgroundCaptureHeight: 768,
}

interface Harness {
  readonly ctx: ActionContext
  readonly evaluated: string[]
  readonly settled: { id: number; ok: boolean }[]
  readonly captured: number
}

/**
 * Stand in for the page: the runtime installer, the request queue, and the run.
 * @param reply - envelope the wrapped script returns.
 * @param requests - requests the page records, handed out once each.
 */
function harness(reply: unknown, requests: readonly { id: number; method: string; args: readonly unknown[] }[] = []): Harness {
  const evaluated: string[] = []
  const settled: { id: number; ok: boolean }[] = []
  const queue = [...requests]
  const record = { captured: 0 }
  const webview = {
    clientWidth: 800,
    clientHeight: 600,
    // The stub stands for a guest whose Session is on screen.
    closest: () => null,
    executeJavaScript: (code: string) => {
      evaluated.push(code)
      // The installers are serialized, so whitespace may be minified away.
      if (/__dshBrowserAgent\s*=/.test(code)) return Promise.resolve(true)
      if (/__dshBrowserScript\s*=/.test(code)) return Promise.resolve(true)
      if (code.includes('__dshBrowserScript.reset()')) return Promise.resolve(undefined)
      if (code.includes('__dshBrowserScript.takeLogs()')) return Promise.resolve(['captured log'])
      if (code.includes('__dshBrowserScript.take()')) {
        const next = queue.shift()
        return Promise.resolve(next === undefined ? null : next)
      }
      if (code.includes('scrollIntoView(') || code.includes('.resolve(')) return Promise.resolve({ ok: true, value: ELEMENT })
      if (code.includes('.flatten(')) return Promise.resolve({ ok: true, value: 'data:image/png;base64,QUJD' })
      if (code.includes('__dshBrowserScript.settle(')) {
        const id = Number(/\.settle\((\d+)/.exec(code)?.[1] ?? '0')
        settled.push({ id, ok: code.includes(', true, ') })
        return Promise.resolve(undefined)
      }
      return Promise.resolve(reply)
    },
    sendInputEvent: () => Promise.resolve(),
    capturePage: () => {
      record.captured += 1
      return Promise.resolve({ toDataURL: () => 'data:image/png;base64,QUJD' })
    },
  } as unknown as WebviewElement
  return {
    ctx: { webview, limits: LIMITS, dialogs: new DialogTracker() },
    evaluated,
    settled,
    get captured() { return record.captured },
  }
}

test('a script runs in the page and reports its result and logs', async () => {
  const h = harness({ ok: true, value: { answer: 42 } })
  const outcome = await runBrowserScript(h.ctx, 'return page.title();', 5_000, new AbortController().signal)
  assert.deepEqual(outcome.result, { answer: 42 })
  assert.deepEqual(outcome.logs, ['captured log'])
  // The body must reach the page, not be compiled here.
  assert.ok(h.evaluated.some(code => code.includes('return page.title();')))
})

test('a script error carries its own code back', async () => {
  const h = harness({ ok: false, error: { code: 'browser/target-missing', message: 'no element matches' } })
  await assert.rejects(
    runBrowserScript(h.ctx, 'return 1;', 5_000, new AbortController().signal),
    (error: unknown) => error instanceof Error && error.message === 'no element matches',
  )
})

test('a page-requested screenshot is served and settled back', async () => {
  const h = harness({ ok: true, value: 'shot' }, [{ id: 1, method: 'screenshot', args: [{}] }])
  const outcome = await runBrowserScript(h.ctx, 'return page.screenshot();', 5_000, new AbortController().signal)
  assert.equal(outcome.result, 'shot')
  assert.equal(h.captured, 1)
  assert.equal(h.settled.length, 1)
  assert.equal(h.settled[0]?.ok, true)
})
test('a bare selector crosses the bridge as a selector target', async () => {
  const h = harness({ ok: true, value: 'clicked' }, [{ id: 1, method: 'click', args: ['#counter', {}] }])
  const outcome = await runBrowserScript(h.ctx, 'return page.click("#counter");', 5_000, new AbortController().signal)
  assert.equal(outcome.result, 'clicked')
  // The resolved-element payload also carries this selector, so look only at the call.
  // The installer source also mentions the method, so match the call prefix only.
  const scrolls = h.evaluated.filter(code => code.includes('__dshBrowserAgent.scrollIntoView('))
  assert.equal(scrolls.length, 1)
  assert.ok(scrolls[0]?.includes('"selector":"#counter"'))
  assert.equal(h.settled[0]?.ok, true)
})