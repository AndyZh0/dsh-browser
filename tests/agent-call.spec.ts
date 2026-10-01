/** The page-agent calls the controller makes must tolerate a document with no agent. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drainDialogs, ensurePageAgent } from '../src/client/agent-call.ts'
import type { WebviewElement } from '../src/client/webview.ts'

function stubWebview(evaluate: (code: string) => unknown): WebviewElement {
  return { executeJavaScript: (code: string) => Promise.resolve(evaluate(code)) } as unknown as WebviewElement
}

test('draining dialogs without an installed agent reports none', async () => {
  const webview = stubWebview(() => {
    throw new Error('Script failed to execute')
  })
  // The expression itself guards on the agent, so the stub never throws in
  // practice; the tolerant read still refuses a non-array answer.
  const guarded = stubWebview(() => [])
  assert.deepEqual(await drainDialogs(guarded), [])
  assert.deepEqual(await drainDialogs(stubWebview(() => ({ not: 'an array' }))), [])
  assert.deepEqual(await drainDialogs(stubWebview(() => [{ id: 'd1', type: 'alert', message: 'hi' }])), [
    { id: 'd1', type: 'alert', message: 'hi' },
  ])
  await assert.rejects(drainDialogs(webview))
})

test('installing the page agent requires the install marker', async () => {
  await ensurePageAgent(stubWebview(() => true))
  await assert.rejects(ensurePageAgent(stubWebview(() => undefined)), /did not install/)
})
