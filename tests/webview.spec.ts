/** A blank error page must explain itself through the page state. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageStateOf, type BrowserTabHandle, type WebviewElement } from '../src/client/webview.ts'

type Listener = (event: unknown) => void

function stubTab(): { handle: BrowserTabHandle; fire(type: string, event: unknown): void } {
  const listeners = new Map<string, Listener[]>()
  const element = {
    addEventListener: (type: string, listener: Listener) => {
      const existing = listeners.get(type) ?? []
      existing.push(listener)
      listeners.set(type, existing)
    },
    getURL: () => 'http://127.0.0.1:17874/',
    getTitle: () => '127.0.0.1:17874',
    isLoading: () => false,
  } as unknown as WebviewElement
  return {
    handle: { tabId: 'tab1', element },
    fire: (type, event) => { for (const listener of listeners.get(type) ?? []) listener(event) },
  }
}

test('a main-frame load failure is reported in the page state', () => {
  const tab = stubTab()
  assert.equal(pageStateOf(tab.handle).error, undefined)
  tab.fire('did-fail-load', { isMainFrame: true, errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED' })
  assert.equal(pageStateOf(tab.handle).error, 'ERR_CONNECTION_REFUSED (-102)')
  tab.fire('did-start-navigation', { isMainFrame: true })
  assert.equal(pageStateOf(tab.handle).error, undefined)
})

test('an aborted or subframe failure is not reported', () => {
  const tab = stubTab()
  pageStateOf(tab.handle)
  tab.fire('did-fail-load', { isMainFrame: true, errorCode: -3, errorDescription: 'ERR_ABORTED' })
  assert.equal(pageStateOf(tab.handle).error, undefined)
  tab.fire('did-fail-load', { isMainFrame: false, errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED' })
  assert.equal(pageStateOf(tab.handle).error, undefined)
  tab.fire('did-fail-load', { isMainFrame: true, errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED' })
  assert.equal(pageStateOf(tab.handle).error, 'ERR_CONNECTION_REFUSED (-102)')
})
