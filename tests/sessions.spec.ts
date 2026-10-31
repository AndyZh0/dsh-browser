/** A browser command reaches only the pages its own Session owns. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import type { BrowserSidebarRight, BrowserTabRecord } from '../src/client/ports.ts'
import { browserTabsOf, findSessionTab, isGuestVisible, listPageStates, sessionOwnsPage } from '../src/client/webview.ts'

interface Harness {
  readonly sidebar: BrowserSidebarRight
}

/**
 * Two Sessions whose Browser tabs share the id `tab2`.
 *
 * The Sidebar mints tab ids per Session, so the same id names a different page
 * in each one and only the owning Sidebar root tells them apart. Session B's
 * root comes first in the document, so an id-only lookup always answers with B.
 */
function installTwoSessions(): Harness {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div data-sidebar-right-session="sessionB" hidden>
      <div data-dockkit-content="tab2"><webview data-sidebar-browser-frame="webview"></webview></div>
    </div>
    <div data-sidebar-right-session="sessionA">
      <div data-dockkit-content="tab2"><webview data-sidebar-browser-frame="webview"></webview></div>
      <div data-dockkit-content="notesA"><webview data-sidebar-browser-frame="webview"></webview></div>
    </div>
  </body></html>`)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  })
  for (const [sessionId, tabId, url, title] of [
    ['sessionA', 'tab2', 'https://a.example/', 'A'],
    ['sessionB', 'tab2', 'https://b.example/', 'B'],
  ]) {
    const element = document.querySelector(
      '[data-sidebar-right-session="' + String(sessionId) + '"] [data-dockkit-content="' + String(tabId) + '"] webview',
    )
    Object.assign(element as object, { getURL: () => url, getTitle: () => title, isLoading: () => false })
  }
  const tabs: BrowserTabRecord[] = [
    { sessionId: 'sessionB', tabId: 'tab2', kind: 'browser' },
    { sessionId: 'sessionA', tabId: 'tab2', kind: 'browser' },
    { sessionId: 'sessionA', tabId: 'notesA', kind: 'notes' },
  ]
  return {
    sidebar: {
      openTab: () => {},
      openTabIn: () => {},
      closeIn: () => {},
      focus: () => {},
      openTabs: { getSnapshot: () => tabs },
      mounted: { getSnapshot: () => 'sessionA' },
    },
  }
}

test('a Session sees only its own Browser tabs', () => {
  const { sidebar } = installTwoSessions()
  assert.deepEqual(browserTabsOf('sessionA', sidebar).map(tab => tab.tabId), ['tab2'])
  assert.deepEqual(browserTabsOf('sessionC', sidebar), [])
})

test('a tab id shared with another Session resolves to the owning Session page', () => {
  const { sidebar } = installTwoSessions()
  const mine = findSessionTab('sessionA', undefined, sidebar)
  const theirs = findSessionTab('sessionB', undefined, sidebar)
  assert.equal(mine?.element.getURL(), 'https://a.example/')
  assert.equal(theirs?.element.getURL(), 'https://b.example/')
  assert.notEqual(mine?.element, theirs?.element)
})

test('a Session with no Sidebar root resolves to nothing', () => {
  const { sidebar } = installTwoSessions()
  assert.equal(findSessionTab('sessionC', 'tab2', sidebar), undefined)
})

test('a page id from another Session is not owned', () => {
  const { sidebar } = installTwoSessions()
  assert.equal(sessionOwnsPage('sessionA', 'tab2', sidebar), true)
  assert.equal(sessionOwnsPage('sessionC', 'tab2', sidebar), false)
})

test('page states are scoped to one Session', () => {
  const { sidebar } = installTwoSessions()
  assert.deepEqual(listPageStates('sessionA', sidebar).map(state => state.url), ['https://a.example/'])
  assert.deepEqual(listPageStates('sessionB', sidebar).map(state => state.url), ['https://b.example/'])
})

test('a guest inside a hidden Sidebar body is not visible', () => {
  const { sidebar } = installTwoSessions()
  const hidden = findSessionTab('sessionB', undefined, sidebar)
  const shown = findSessionTab('sessionA', undefined, sidebar)
  assert.equal(hidden === undefined ? undefined : isGuestVisible(hidden.element), false)
  assert.equal(shown === undefined ? undefined : isGuestVisible(shown.element), true)
})
