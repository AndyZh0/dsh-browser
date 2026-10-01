/** Whole-document capture scrolls the page in viewport steps and stitches in the guest. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performAction, type ActionContext } from '../src/client/actions.ts'
import { DialogTracker } from '../src/client/dialogs.ts'
import type { BrowserCommandLimits } from '../src/protocol.ts'
import type { WebviewElement } from '../src/client/webview.ts'

function limits(maxFullPageTiles: number): BrowserCommandLimits {
  return { lingerMs: 2_000, maxReadChars: 40_000, maxOutputChars: 50_000, codeTimeoutMs: 180_000, maxFullPageTiles }
}

interface Recorded {
  readonly evaluated: string[]
  captures: number
}

function fullPageContext(recorded: Recorded, maxFullPageTiles: number): ActionContext {
  const webview = {
    clientWidth: 800,
    clientHeight: 600,
    executeJavaScript: (code: string) => {
      recorded.evaluated.push(code)
      if (code.includes('__dshBrowserAgent =') || code.includes('pageAgentMain')) return Promise.resolve(true)
      if (code.includes('.metrics(')) {
        return Promise.resolve({ ok: true, value: { scrollX: 0, scrollY: 0, scrollWidth: 800, scrollHeight: 1800, viewportWidth: 800, viewportHeight: 600 } })
      }
      if (code.includes('.composeTiles(')) return Promise.resolve({ ok: true, value: 'data:image/png;base64,QUJD' })
      return Promise.resolve({ ok: true, value: undefined })
    },
    capturePage: () => {
      recorded.captures += 1
      return Promise.resolve({ toDataURL: () => 'data:image/png;base64,QUJD' })
    },
  } as unknown as WebviewElement
  return { webview, limits: limits(maxFullPageTiles), dialogs: new DialogTracker() }
}

test('a whole-document capture scrolls once per viewport and restores the position', async () => {
  const recorded: Recorded = { evaluated: [], captures: 0 }
  const outcome = await performAction({ kind: 'screenshot', fullPage: true }, fullPageContext(recorded, 8), new AbortController().signal)
  // 1800px of document at 600px per viewport is three tiles.
  assert.equal(recorded.captures, 3)
  // The install source itself mentions window.scrollTo, so match the calls only.
  const scrolls = recorded.evaluated.filter(code => code.includes('__dshBrowserAgent.scrollTo('))
  assert.equal(scrolls.length, 4, 'three tile scrolls plus the restore')
  assert.match(scrolls[0] ?? '', /scrollTo\(0, 0\)/)
  assert.match(scrolls[1] ?? '', /scrollTo\(0, 600\)/)
  assert.match(scrolls[2] ?? '', /scrollTo\(0, 1200\)/)
  assert.match(scrolls[3] ?? '', /scrollTo\(0, 0\)/)
  assert.ok(recorded.evaluated.some(code => code.includes('.composeTiles(')))
  assert.equal(outcome.image?.width, 800)
  assert.equal(outcome.image?.height, 1800)
})

test('a document taller than the tile budget is refused before any capture', async () => {
  const recorded: Recorded = { evaluated: [], captures: 0 }
  await assert.rejects(
    performAction({ kind: 'screenshot', fullPage: true }, fullPageContext(recorded, 2), new AbortController().signal),
    (error: unknown) => error instanceof Error && error.message.includes('maxFullPageTiles'),
  )
  assert.equal(recorded.captures, 0)
})