/** Revealing a hidden guest for one capture, and putting the Sidebar back. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { guestCaptureSize, rememberGuestSize, withPaintedGuest } from '../src/client/guest-surface.ts'
import type { WebviewElement } from '../src/client/webview.ts'

const REVEAL_ATTRIBUTE = 'data-dsh-browser-reveal'
const STYLE_ID = 'dsh-browser-reveal-style'

interface Harness {
  readonly guest: WebviewElement
  readonly mine: HTMLElement
  readonly other: HTMLElement
  readonly setSize: (width: number, height: number) => void
  readonly style: () => string
}

/** One visible Session and one hidden Session, each owning a Browser guest. */
function installTwoSessions(): Harness {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div data-sidebar-right-session="sessionA">
      <div data-dockkit-content="tab1"><webview data-sidebar-browser-frame="webview"></webview></div>
    </div>
    <div data-sidebar-right-session="sessionB" hidden>
      <div data-dockkit-content="tab2" hidden><webview data-sidebar-browser-frame="webview"></webview></div>
    </div>
  </body></html>`)
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement })
  const guest = document.querySelector('[data-sidebar-right-session="sessionB"] webview') as unknown as WebviewElement
  const size = { width: 0, height: 0 }
  Object.defineProperty(guest, 'clientWidth', { get: () => size.width, configurable: true })
  Object.defineProperty(guest, 'clientHeight', { get: () => size.height, configurable: true })
  return {
    guest,
    mine: document.querySelector('[data-sidebar-right-session="sessionB"]') as HTMLElement,
    other: document.querySelector('[data-sidebar-right-session="sessionA"]') as HTMLElement,
    setSize: (width, height) => { size.width = width; size.height = height },
    style: () => document.getElementById(STYLE_ID)?.textContent ?? '',
  }
}

/** A probe that answers the placements in the given order, recording the stylesheet it saw. */
function probeSequence(answers: readonly boolean[], seen: string[], style: () => string): () => Promise<{ width: number; height: number }> {
  return async () => {
    const verdict = answers[seen.length] ?? false
    seen.push(style())
    if (!verdict) throw new Error('no frame')
    return { width: 800, height: 600 }
  }
}

/** A probe that answers with the given frames, so a clipped one can be rejected. */
function probeFrames(frames: ReadonlyArray<{ width: number; height: number } | 'none'>, seen: string[], style: () => string): () => Promise<{ width: number; height: number }> {
  return async () => {
    const verdict = frames[seen.length] ?? 'none'
    seen.push(style())
    if (verdict === 'none') throw new Error('no frame')
    return verdict
  }
}

test('the first placement that produces a frame is the one used', async () => {
  const h = installTwoSessions()
  const seen: string[] = []
  const outcome = await withPaintedGuest(
    h.guest,
    { width: 800, height: 600 },
    probeSequence([true], seen, h.style),
    async () => {
      assert.equal(h.mine.hasAttribute(REVEAL_ATTRIBUTE), true)
      assert.equal(h.other.hasAttribute(REVEAL_ATTRIBUTE), false)
      return 'captured'
    },
  )
  assert.equal(outcome, 'captured')
  assert.equal(seen.length, 1)
  assert.ok(seen[0]?.includes('clip-path: inset(0 0 calc(100% - 1px) calc(100% - 1px)) !important'))
  assert.ok(seen[0]?.includes('width: 800px !important'))
  assert.ok(seen[0]?.includes('height: 600px !important'))
  assert.ok(seen[0]?.includes('visibility: visible !important'))
  assert.equal(h.mine.hasAttribute(REVEAL_ATTRIBUTE), false)
  assert.equal(document.getElementById(STYLE_ID), null)
})

test('a placement that produces no frame escalates to the next one', async () => {
  const h = installTwoSessions()
  const seen: string[] = []
  const outcome = await withPaintedGuest(
    h.guest,
    { width: 800, height: 600 },
    probeSequence([false, true], seen, h.style),
    async () => 'captured',
  )
  assert.equal(outcome, 'captured')
  assert.equal(seen.length, 2)
  assert.ok(seen[1]?.includes('opacity: 0.01 !important'))
})

test('a placement that clips the captured frame is rejected', async () => {
  const h = installTwoSessions()
  const seen: string[] = []
  const outcome = await withPaintedGuest(
    h.guest,
    { width: 800, height: 600 },
    probeFrames([{ width: 1, height: 1 }, { width: 800, height: 600 }], seen, h.style),
    async () => 'captured',
  )
  assert.equal(outcome, 'captured')
  assert.equal(seen.length, 2)
  assert.ok(seen[1]?.includes('opacity: 0.01 !important'))
})

test('no placement producing a frame reports the page as uncapturable', async () => {
  const h = installTwoSessions()
  const seen: string[] = []
  await assert.rejects(
    withPaintedGuest(h.guest, { width: 800, height: 600 }, probeSequence([false, false, false, false, false], seen, h.style), async () => 'never'),
    (error: unknown) => (error as { code?: string }).code === 'browser/page-not-visible',
  )
  assert.equal(seen.length, 5)
  assert.equal(h.mine.hasAttribute(REVEAL_ATTRIBUTE), false)
  assert.equal(document.getElementById(STYLE_ID), null)
})

test('a failed capture still restores the Sidebar', async () => {
  const h = installTwoSessions()
  const seen: string[] = []
  await assert.rejects(
    withPaintedGuest(h.guest, { width: 800, height: 600 }, probeSequence([true], seen, h.style), async () => { throw new Error('capture failed') }),
    (error: unknown) => error instanceof Error && error.message === 'capture failed',
  )
  assert.equal(h.mine.hasAttribute(REVEAL_ATTRIBUTE), false)
  assert.equal(document.getElementById(STYLE_ID), null)
})

test('the placement that worked is tried first for the same guest', async () => {
  const h = installTwoSessions()
  const first: string[] = []
  await withPaintedGuest(h.guest, { width: 800, height: 600 }, probeSequence([false, true], first, h.style), async () => 'captured')
  assert.equal(first.length, 2)
  assert.ok(first[1]?.includes('opacity: 0.01 !important'))
  const second: string[] = []
  await withPaintedGuest(h.guest, { width: 800, height: 600 }, probeSequence([true], second, h.style), async () => 'captured')
  assert.equal(second.length, 1)
  assert.ok(second[0]?.includes('opacity: 0.01 !important'))
})

test('the guest parent carries the host marker only while revealed', async () => {
  const h = installTwoSessions()
  const parent = h.guest.parentElement as HTMLElement
  const seen: string[] = []
  await withPaintedGuest(h.guest, { width: 800, height: 600 }, async () => {
    seen.push(String(parent.getAttribute('data-dsh-browser-reveal-host')))
    return { width: 800, height: 600 }
  }, async () => 'captured')
  assert.deepEqual(seen, [''])
  assert.equal(parent.hasAttribute('data-dsh-browser-reveal-host'), false)
})

test('hidden ancestors are lifted for the capture and restored afterwards', async () => {
  const h = installTwoSessions()
  const ancestor = h.guest.parentElement as HTMLElement
  const seen: string[] = []
  await withPaintedGuest(h.guest, { width: 800, height: 600 }, async () => {
    seen.push(ancestor.style.display)
    return { width: 800, height: 600 }
  }, async () => 'captured')
  assert.deepEqual(seen, ['contents'])
  assert.equal(ancestor.style.display, '')
  assert.equal(ancestor.hasAttribute('hidden'), true)
})

test('one guest is not revealed twice at once', async () => {
  const h = installTwoSessions()
  const seen: string[] = []
  const first = withPaintedGuest(h.guest, { width: 800, height: 600 }, probeSequence([true], seen, h.style), async () => 'first')
  await assert.rejects(
    withPaintedGuest(h.guest, { width: 800, height: 600 }, probeSequence([true], [], h.style), async () => 'second'),
    (error: unknown) => (error as { code?: string }).code === 'browser/capture-busy',
  )
  assert.equal(await first, 'first')
})

test('a guest outside the document reports its own failure', async () => {
  const h = installTwoSessions()
  const detached = h.guest.cloneNode(false) as unknown as WebviewElement
  await assert.rejects(
    withPaintedGuest(detached, { width: 800, height: 600 }, async () => ({ width: 800, height: 600 }), async () => 'never'),
    (error: unknown) => (error as { code?: string }).code === 'browser/page-not-visible',
  )
})

test('a captured size is remembered and preferred over the configured fallback', () => {
  const h = installTwoSessions()
  const fallback = { width: 1_024, height: 768 }
  assert.deepEqual(guestCaptureSize(h.guest, fallback), fallback)
  // A hidden guest reports zero and must not overwrite the fallback.
  rememberGuestSize(h.guest)
  assert.deepEqual(guestCaptureSize(h.guest, fallback), fallback)
  h.setSize(900, 640)
  rememberGuestSize(h.guest)
  assert.deepEqual(guestCaptureSize(h.guest, fallback), { width: 900, height: 640 })
})