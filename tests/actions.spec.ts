/** Every agent-backed action installs the page agent before calling it. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performAction, type ActionContext } from '../src/client/actions.ts'
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

function contextRecording(evaluated: string[]): ActionContext {
  const webview = {
    clientWidth: 800,
    clientHeight: 600,
    executeJavaScript: (code: string) => {
      evaluated.push(code)
      if (code.includes('pageAgentMain') || code.includes('__dshBrowserAgent =')) return Promise.resolve(true)
      if (code.includes('.read(')) {
        return Promise.resolve({ ok: true, value: { mode: 'text', content: 'hello', cursor: 0, truncated: false } })
      }
      return Promise.resolve({ ok: true, value: {} })
    },
  } as unknown as WebviewElement
  return { webview, limits: LIMITS, dialogs: new DialogTracker() }
}

test('a read installs the page agent before it reads', async () => {
  const evaluated: string[] = []
  const outcome = await performAction({ kind: 'read', mode: 'text' }, contextRecording(evaluated), new AbortController().signal)
  assert.equal(evaluated.length, 2)
  assert.match(evaluated[0] ?? '', /__dshBrowserAgent/)
  assert.match(evaluated[1] ?? '', /\.read\(/)
  assert.equal(outcome.read?.content, 'hello')
})

test('navigating does not install the page agent into the old document', async () => {
  const evaluated: string[] = []
  const ctx = contextRecording(evaluated)
  const webview = ctx.webview as unknown as { loadURL: (url: string) => Promise<void>; isLoading: () => boolean; getURL: () => string }
  webview.loadURL = () => Promise.resolve()
  webview.isLoading = () => false
  webview.getURL = () => 'https://example.com/'
  await performAction({ kind: 'navigate', direction: 'goto', url: 'https://example.com/' }, ctx, new AbortController().signal)
  assert.deepEqual(evaluated, [])
})