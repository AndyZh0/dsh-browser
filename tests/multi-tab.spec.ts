/**
 * Multi-tab behavior of the built-in browser, driven through the real Client
 * controller and a real Cordis service lookup.
 *
 * The Sidebar double keeps the production inventory order (\`Object.values\` of
 * the layout's tab record, so a page opened later is listed later). That order
 * is what makes a second page distinguishable from the Session's first one.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  BROWSER_HELLO_ENDPOINT, BROWSER_POLL_ENDPOINT, BROWSER_RESULT_ENDPOINT,
  type BrowserAction, type BrowserCommand, type BrowserCommandLimits, type BrowserOutcome,
  type BrowserResultPayload,
} from '../src/protocol.ts'
import { createBrowserController } from '../src/client/controller.ts'
import type { BrowserRpcResult, BrowserTabRecord } from '../src/client/ports.ts'

/** Limits a Host command carries; each deadline only has to outlast one action. */
const LIMITS: BrowserCommandLimits = {
  lingerMs: 10,
  maxReadChars: 4_000,
  maxOutputChars: 4_000,
  operationTimeoutMs: 5_000,
  codeTimeoutMs: 5_000,
  maxFullPageTiles: 4,
  backgroundCaptureWidth: 800,
  backgroundCaptureHeight: 600,
}

/** A page action that resolves a handle without reaching into the page's own script. */
const RELOAD: BrowserAction = { kind: 'navigate', direction: 'reload' }

/** How long the Sidebar double keeps a closed page listed, as one real render would. */
const INVENTORY_REFRESH_MS = 25

/** One page address this spec drives. */
function address(name: string): string {
  return 'http://127.0.0.1:17999/' + name
}

/** The page ids one outcome reports, in inventory order. */
function pageIds(outcome: BrowserOutcome): readonly string[] {
  return outcome.pages.map((page) => page.id)
}

/** The failure code one settlement carries, or \`none\` when it succeeded. */
function failureCode(payload: BrowserResultPayload): string {
  return payload.ok ? 'none' : payload.error.code
}

/** Options the Sidebar receives when one page is opened. */
interface OpenOptions {
  readonly params?: { readonly url?: string }
}

/** One mounted page of the Sidebar double. */
interface FakePane {
  readonly sessionId: string
  readonly host: HTMLElement
}

/**
 * A Sidebar double that mounts real jsdom guests.
 *
 * Its inventory is a flat record list in mount order, matching the production
 * inventory, and its panes carry the \`hidden\` marker the plugin reads as
 * "not painted".
 */
class FakeSidebar {
  readonly records: BrowserTabRecord[] = []
  readonly opened: { readonly sessionId: string; readonly url: string | undefined }[] = []
  readonly closedTabs: string[] = []
  readonly focusedTabs: string[] = []
  mountedSession: string | undefined
  private sequence = 0
  private readonly roots = new Map<string, HTMLElement>()
  private readonly panes = new Map<string, FakePane>()

  readonly openTabs = { getSnapshot: (): readonly BrowserTabRecord[] => [...this.records] }
  readonly mounted = { getSnapshot: (): string | undefined => this.mountedSession }

  openTab(_kind: 'browser', options?: OpenOptions): void {
    this.show(this.mount(this.mountedSession, options?.params?.url))
  }

  openTabIn(sessionId: string, _kind: 'browser', options?: OpenOptions): void {
    this.show(this.mount(sessionId, options?.params?.url))
  }

  closeIn(_sessionId: string, tabId: string): void {
    this.closedTabs.push(tabId)
    // The pane leaves at once, but the inventory only republishes on the
    // Sidebar's next render; that gap is what the controller has to wait out.
    setTimeout(() => { this.forget(tabId) }, INVENTORY_REFRESH_MS)
  }

  focus(tabId: string): void {
    this.focusedTabs.push(tabId)
    this.show(tabId)
  }

  /** Mount one page as the reader would have, without any tool command. */
  seed(sessionId: string, url: string, visible: boolean): string {
    const tabId = this.mount(sessionId, url)
    if (visible) this.show(tabId)
    return tabId
  }

  private mount(sessionId: string | undefined, url: string | undefined): string {
    if (sessionId === undefined) throw new Error('the Sidebar double mounts a page only for a named Session')
    const tabId = 'tab' + String(++this.sequence)
    let current = url ?? 'about:blank'
    const host = document.createElement('div')
    host.setAttribute('data-dockkit-content', tabId)
    const webview = document.createElement('webview')
    webview.setAttribute('data-sidebar-browser-frame', 'webview')
    Object.assign(webview, {
      getURL: () => current,
      getTitle: () => current,
      isLoading: () => false,
      loadURL: (next: string) => { current = next; return Promise.resolve() },
      // The dialog drain always runs, and a document without the page agent
      // reports no dialogs.
      executeJavaScript: () => Promise.resolve([]),
      reload: () => {},
      goBack: () => {},
      goForward: () => {},
    })
    host.append(webview)
    this.rootOf(sessionId).append(host)
    this.records.push({ sessionId, tabId, kind: 'browser' })
    this.panes.set(tabId, { sessionId, host })
    this.opened.push({ sessionId, url })
    return tabId
  }

  private forget(tabId: string): void {
    const index = this.records.findIndex(record => record.tabId === tabId)
    if (index >= 0) this.records.splice(index, 1)
    this.panes.get(tabId)?.host.remove()
    this.panes.delete(tabId)
  }

  /** Paint one page and hide the other pages of its own Session. */
  private show(tabId: string): void {
    const shown = this.panes.get(tabId)
    if (shown === undefined) return
    for (const [id, pane] of this.panes) {
      if (pane.sessionId !== shown.sessionId) continue
      pane.host.hidden = id !== tabId
    }
  }

  private rootOf(sessionId: string): HTMLElement {
    const existing = this.roots.get(sessionId)
    if (existing !== undefined) return existing
    const root = document.createElement('div')
    root.setAttribute('data-sidebar-right-session', sessionId)
    document.body.append(root)
    this.roots.set(sessionId, root)
    return root
  }
}

/** The Sidebar service the controller reads through \`ctx.get('sidebarRight')\`. */
class StubSidebarService extends Service {
  private readonly fake: FakeSidebar

  constructor(owner: Context, fake: FakeSidebar) {
    super(owner, 'sidebarRight')
    this.fake = fake
  }

  openTab(kind: 'browser', options?: OpenOptions): void { this.fake.openTab(kind, options) }
  openTabIn(sessionId: string, kind: 'browser', options?: OpenOptions): void { this.fake.openTabIn(sessionId, kind, options) }
  closeIn(sessionId: string, tabId: string): void { this.fake.closeIn(sessionId, tabId) }
  focus(tabId: string): void { this.fake.focus(tabId) }
  get openTabs(): { getSnapshot(): readonly BrowserTabRecord[] } { return this.fake.openTabs }
  get mounted(): { getSnapshot(): string | undefined } { return this.fake.mounted }
}

/** The Connection service that carries the Host command queue. */
class StubConnectionService extends Service {
  private readonly queue: BrowserCommand[] = []
  private readonly waiting = new Map<string, (payload: BrowserResultPayload) => void>()
  private sequence = 0

  constructor(owner: Context) { super(owner, 'connection') }

  /** Queue one command and resolve once the Client settles it. */
  async settle(command: BrowserCommand): Promise<BrowserResultPayload> {
    const settled = new Promise<BrowserResultPayload>((resolve) => { this.waiting.set(command.commandId, resolve) })
    this.queue.push(command)
    return await settled
  }

  /** Mint the next command identity. */
  nextCommandId(): string {
    this.sequence += 1
    return 'cmd' + String(this.sequence)
  }

  get rpc(): { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<BrowserRpcResult> } {
    return {
      call: async (_channel, endpoint, payload) => {
        if (endpoint === BROWSER_HELLO_ENDPOINT) return { ok: true, value: null }
        if (endpoint === BROWSER_RESULT_ENDPOINT) {
          const result = payload as BrowserResultPayload
          this.waiting.get(result.commandId)?.(result)
          return { ok: true, value: null }
        }
        if (endpoint === BROWSER_POLL_ENDPOINT) {
          const command = this.queue.shift()
          if (command === undefined) {
            // Yield to the timer queue, so an idle poll cannot starve the test.
            await new Promise((resolve) => { setTimeout(resolve, 2) })
            return { ok: true, value: { idle: true } }
          }
          return { ok: true, value: { command } }
        }
        throw new Error('the Connection double has no endpoint ' + endpoint)
      },
    }
  }
}

interface Harness {
  readonly sidebar: FakeSidebar
  dispatch(sessionId: string, action: BrowserAction, pageId?: string): Promise<BrowserResultPayload>
  outcome(sessionId: string, action: BrowserAction, pageId?: string): Promise<BrowserOutcome>
  dispose(): Promise<void>
}

/** Boot one jsdom renderer with the controller polling its own command queue. */
function createHarness(): Harness {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true })
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    ResizeObserver: StubResizeObserver,
  })

  const ctx = new Context()
  const sidebar = new FakeSidebar()
  new StubSidebarService(ctx, sidebar)
  const connection = new StubConnectionService(ctx)
  const stop = createBrowserController(ctx).start()

  const dispatch = async (sessionId: string, action: BrowserAction, pageId?: string): Promise<BrowserResultPayload> => {
    return await connection.settle({
      commandId: connection.nextCommandId(),
      sessionId,
      action,
      limits: LIMITS,
      ...pageId === undefined ? {} : { pageId },
    })
  }

  return {
    sidebar,
    dispatch,
    outcome: async (sessionId, action, pageId) => {
      const payload = await dispatch(sessionId, action, pageId)
      if (!payload.ok) throw new Error('the command failed: ' + payload.error.code + ' (' + payload.error.message + ')')
      return payload.outcome
    },
    dispose: async () => {
      stop()
      await ctx.fiber.dispose()
    },
  }
}

test('newTab true opens another page and newTab false reuses the current one', { timeout: 15_000 }, async () => {
  const harness = createHarness()
  try {
    harness.sidebar.mountedSession = 's-open'

    const first = await harness.outcome('s-open', { kind: 'open', url: address('first'), newTab: false })
    assert.equal(harness.sidebar.opened.length, 1)
    assert.deepEqual(pageIds(first), ['tab1'])

    const second = await harness.outcome('s-open', { kind: 'open', url: address('second'), newTab: true })
    assert.equal(harness.sidebar.opened.length, 2, 'newTab true must ask the Sidebar for another page')
    assert.equal(second.pages.length, 2, 'the Session must own both pages after newTab true')

    const third = await harness.outcome('s-open', { kind: 'open', url: address('third'), newTab: false })
    assert.equal(harness.sidebar.opened.length, 2, 'newTab false must not ask for another page')
    assert.equal(third.pages.length, 2)
    assert.equal(third.page?.id, second.page?.id, 'newTab false must reuse the page the Session used last')
  } finally {
    await harness.dispose()
  }
})

test('the page reported for newTab true is the tab that was just opened', { timeout: 15_000 }, async () => {
  const harness = createHarness()
  try {
    harness.sidebar.mountedSession = 's-report'
    await harness.outcome('s-report', { kind: 'open', url: address('first'), newTab: false })

    const opened = await harness.outcome('s-report', { kind: 'open', url: address('second'), newTab: true })
    const newest = harness.sidebar.records[harness.sidebar.records.length - 1]?.tabId
    assert.equal(opened.pages.length, 2)
    assert.equal(
      opened.page?.id,
      newest,
      'browser_openBrowserPage with newTab true reported ' + String(opened.page?.id)
        + ' instead of the page it just opened (' + String(newest) + ')',
    )
  } finally {
    await harness.dispose()
  }
})

test('a command with no pageId drives the visible page when nothing was used yet', { timeout: 15_000 }, async () => {
  const harness = createHarness()
  try {
    harness.sidebar.mountedSession = 's-visible'
    harness.sidebar.seed('s-visible', address('first'), false)
    const shown = harness.sidebar.seed('s-visible', address('second'), true)

    const outcome = await harness.outcome('s-visible', RELOAD)
    assert.equal(outcome.page?.id, shown, 'the painted page wins over the inventory first entry')
  } finally {
    await harness.dispose()
  }
})

test('a command with no pageId prefers the page the Session used last', { timeout: 15_000 }, async () => {
  const harness = createHarness()
  try {
    harness.sidebar.mountedSession = 's-recent'
    const first = harness.sidebar.seed('s-recent', address('first'), false)
    harness.sidebar.seed('s-recent', address('second'), true)

    const explicit = await harness.outcome('s-recent', RELOAD, first)
    assert.equal(explicit.page?.id, first)

    const next = await harness.outcome('s-recent', RELOAD)
    assert.equal(next.page?.id, first, 'the page the Session used last stays the default')
  } finally {
    await harness.dispose()
  }
})

test('a command with no pageId falls back to the first page when none is painted', { timeout: 15_000 }, async () => {
  const harness = createHarness()
  try {
    harness.sidebar.mountedSession = 's-hidden'
    const first = harness.sidebar.seed('s-hidden', address('first'), false)
    harness.sidebar.seed('s-hidden', address('second'), false)

    const outcome = await harness.outcome('s-hidden', RELOAD)
    assert.equal(outcome.page?.id, first, 'the first open page is the last resort')
  } finally {
    await harness.dispose()
  }
})

test('focusing a page makes it the default', { timeout: 15_000 }, async () => {
  const harness = createHarness()
  try {
    harness.sidebar.mountedSession = 's-focus'
    harness.sidebar.seed('s-focus', address('first'), true)
    const second = harness.sidebar.seed('s-focus', address('second'), false)

    const focused = await harness.outcome('s-focus', { kind: 'focus' }, second)
    assert.equal(focused.page?.id, second)
    assert.deepEqual(harness.sidebar.focusedTabs, [second])

    const next = await harness.outcome('s-focus', RELOAD)
    assert.equal(next.page?.id, second, 'the focused page stays the default')
  } finally {
    await harness.dispose()
  }
})

test('closing a page drops it from the list and moves the default', { timeout: 15_000 }, async () => {
  const harness = createHarness()
  try {
    harness.sidebar.mountedSession = 's-close'
    const first = harness.sidebar.seed('s-close', address('first'), true)
    const second = harness.sidebar.seed('s-close', address('second'), true)
    await harness.outcome('s-close', RELOAD, first)

    const closed = await harness.outcome('s-close', { kind: 'close' }, first)
    assert.equal(closed.page?.id, first, 'the outcome names the page that left')
    assert.deepEqual(pageIds(closed), [second], 'the closed page must not be listed among the remaining pages')
    assert.deepEqual(harness.sidebar.closedTabs, [first], 'the Sidebar was asked to close that page')

    const next = await harness.outcome('s-close', RELOAD)
    assert.equal(next.page?.id, second, 'the default page must follow the close')
  } finally {
    await harness.dispose()
  }
})

test('a page id owned by another Session is refused', { timeout: 15_000 }, async () => {
  const harness = createHarness()
  try {
    harness.sidebar.mountedSession = 's-a'
    const mine = harness.sidebar.seed('s-a', address('a'), true)
    const theirs = harness.sidebar.seed('s-b', address('b'), true)

    const refused = await harness.dispatch('s-b', RELOAD, mine)
    assert.equal(failureCode(refused), 'browser/page-not-in-session')

    const own = await harness.outcome('s-b', RELOAD)
    assert.equal(own.page?.id, theirs, 'the command still reaches its own page')
    assert.notEqual(own.page?.id, mine)

    const empty = await harness.dispatch('s-c', RELOAD)
    assert.equal(failureCode(empty), 'browser/page-unavailable')
  } finally {
    await harness.dispose()
  }
})
