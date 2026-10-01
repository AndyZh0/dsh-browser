/** A managed script may navigate between its own agent-backed calls. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runBrowserScript } from '../src/client/script.ts'
import type { ActionContext } from '../src/client/actions.ts'
import { DialogTracker } from '../src/client/dialogs.ts'
import type { BrowserCommandLimits } from '../src/protocol.ts'
import type { WebviewElement } from '../src/client/webview.ts'

const LIMITS: BrowserCommandLimits = {
  lingerMs: 2_000,
  maxReadChars: 40_000,
  maxOutputChars: 50_000,
  codeTimeoutMs: 180_000,
  maxFullPageTiles: 8,
}

function recordingContext(evaluated: string[]): ActionContext {
  const webview = {
    clientWidth: 800,
    clientHeight: 600,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
    isLoading: () => false,
    executeJavaScript: (code: string) => {
      evaluated.push(code)
      if (code.includes('__dshBrowserAgent =') || code.includes('pageAgentMain')) return Promise.resolve(true)
      if (code.includes('.resolve(')) {
        return Promise.resolve({ ok: true, value: { tag: 'button', role: 'button', name: 'Go', selector: '#go', rect: { x: 1, y: 2, width: 3, height: 4 } } })
      }
      if (code.includes('.queryAll(')) return Promise.resolve({ ok: true, value: [] })
      if (code.includes('.read(')) {
        return Promise.resolve({ ok: true, value: { mode: 'text', content: 'body text', cursor: 0, truncated: false } })
      }
      return Promise.resolve({ ok: true, value: undefined })
    },
  } as unknown as WebviewElement
  return { webview, limits: LIMITS, dialogs: new DialogTracker() }
}

test('waitForSelector installs the page agent before resolving', async () => {
  const evaluated: string[] = []
  const outcome = await runBrowserScript(
    recordingContext(evaluated),
    "const element = await page.waitForSelector('#go'); return element.selector;",
    5_000,
    new AbortController().signal,
  )
  assert.equal(outcome.result, '#go')
  assert.equal(evaluated.length, 2)
  assert.match(evaluated[0] ?? '', /__dshBrowserAgent/)
  assert.match(evaluated[1] ?? '', /\.resolve\(/)
})

test('querySelector and textContent each install before they call', async () => {
  const evaluated: string[] = []
  await runBrowserScript(
    recordingContext(evaluated),
    "await page.querySelectorAll('button'); await page.textContent('body'); return 'done';",
    5_000,
    new AbortController().signal,
  )
  // install + queryAll, then install + read
  assert.equal(evaluated.length, 4)
  assert.match(evaluated[2] ?? '', /__dshBrowserAgent/)
  assert.match(evaluated[3] ?? '', /\.read\(/)
})