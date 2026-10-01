/** Behavior of the model-control ring around a Browser tab. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { ModelControlBorder } from '../src/client/border.ts'

function assignGlobals(values: Record<string, unknown>): void {
  Object.assign(globalThis, values)
}

function installDocument(): void {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"><div id="view"></div></div></body></html>', { pretendToBeVisual: true })
  class StubResizeObserver {
    observe(): void {}
    disconnect(): void {}
  }
  assignGlobals({
    window: dom.window,
    document: dom.window.document,
    ResizeObserver: StubResizeObserver,
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

test('showing the ring injects one stylesheet and one ring element', () => {
  installDocument()
  const border = new ModelControlBorder()
  const target = document.getElementById('view') as HTMLElement
  border.show(target, 10_000)
  border.show(target, 10_000)
  assert.equal(document.querySelectorAll('.dsh-browser-model-control-ring').length, 1)
  assert.equal(document.querySelectorAll('#dsh-browser-model-control-style').length, 1)
  border.dispose()
  assert.equal(document.querySelectorAll('.dsh-browser-model-control-ring').length, 0)
  assert.equal(document.querySelectorAll('#dsh-browser-model-control-style').length, 0)
})

test('the ring follows the target it was lit over', () => {
  installDocument()
  const border = new ModelControlBorder()
  const first = document.getElementById('view') as HTMLElement
  border.show(first, 10_000)
  const ring = document.querySelector('.dsh-browser-model-control-ring') as HTMLElement
  assert.equal(ring.parentElement?.id, 'host')
  border.dispose()
})

test('the ring goes out after the linger window', async () => {
  installDocument()
  const border = new ModelControlBorder()
  border.show(document.getElementById('view') as HTMLElement, 5)
  await delay(30)
  assert.equal(document.querySelectorAll('.dsh-browser-model-control-ring').length, 0)
  border.dispose()
})
