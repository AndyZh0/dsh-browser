/** Locate a Session's built-in Browser tabs and read their state. */

import type { BrowserPageState } from '../protocol.ts'
import type { BrowserSidebarRight, BrowserTabRecord } from './ports.ts'

/** The DOM marker the built-in Browser renderer and the Desktop shell both rely on. */
export const WEBVIEW_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]'
/** The dock-kit marker that carries one tab's identity. */
export const TAB_HOST_SELECTOR = '[data-dockkit-content]'
/** The marker that scopes one Session's right Sidebar, which owns its tabs. */
export const SESSION_ROOT_SELECTOR = '[data-sidebar-right-session]'

/** Raster image returned by the webview's capture operation. */
export interface WebviewNativeImage {
  toJPEG(quality: number): Uint8Array
  toPNG(): Uint8Array
  toDataURL(): string
  getSize(): { readonly width: number; readonly height: number }
}

/** The Electron `<webview>` surface this plugin drives. */
export interface WebviewElement extends HTMLElement {
  loadURL(url: string, options?: { readonly timeout?: number }): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  clearHistory(): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  capturePage(rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Promise<WebviewNativeImage>
  sendInputEvent(event: Readonly<Record<string, unknown>>): Promise<void>
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

interface NavigationEvent extends Event {
  readonly isMainFrame: boolean
}

interface LoadFailureEvent extends NavigationEvent {
  readonly errorCode: number
  readonly errorDescription: string
}

/** Last main-frame load failure per element, so a blank error page can explain itself. */
const loadFailures = new WeakMap<WebviewElement, string>()

/**
 * Track main-frame load failures on one guest.
 *
 * Mirrors the built-in Browser page's own rule: a failure is recorded only for
 * the main frame, and ERR_ABORTED is ignored because every superseded
 * navigation produces it.
 * @param element - the mounted webview.
 */
export function observeLoadFailures(element: WebviewElement): void {
  if (loadFailures.has(element)) return
  loadFailures.set(element, '')
  element.addEventListener('did-start-navigation', (event) => {
    if ((event as NavigationEvent).isMainFrame) loadFailures.set(element, '')
  })
  element.addEventListener('did-fail-load', (event) => {
    const failure = event as LoadFailureEvent
    if (!failure.isMainFrame || failure.errorCode === -3) return
    loadFailures.set(element, failure.errorDescription + ' (' + String(failure.errorCode) + ')')
  })
}

/** @param element - the mounted webview. @returns the recorded failure, when one stands. */
function failureOf(element: WebviewElement): string | undefined {
  const recorded = loadFailures.get(element)
  return recorded === undefined || recorded.length === 0 ? undefined : recorded
}

/** One mounted Browser tab this plugin can drive. */
export interface BrowserTabHandle {
  readonly tabId: string
  readonly element: WebviewElement
}

/** Tab identity as the dock kit records it. */
function tabIdOf(element: Element): string | undefined {
  const host = element.closest(TAB_HOST_SELECTOR)
  if (host === null) return undefined
  const id = host.getAttribute('data-dockkit-content')
  return id === null || id.length === 0 ? undefined : id
}

/**
 * One Session's right-Sidebar root, which owns that Session's tabs.
 *
 * Tab ids repeat across Sessions, so a tab id alone does not identify an
 * element: the owning Sidebar is part of the identity.
 * @param sessionId - the Session whose Sidebar to find.
 * @returns the Session's root element, when it is in the document.
 */
function sessionRoot(sessionId: string): HTMLElement | undefined {
  for (const candidate of document.querySelectorAll(SESSION_ROOT_SELECTOR)) {
    if (!(candidate instanceof HTMLElement)) continue
    if (candidate.dataset.sidebarRightSession === sessionId) return candidate
  }
  return undefined
}

/**
 * The mounted webview for one Session's tab id.
 * @param sessionId - the Session that owns the tab.
 * @param tabId - the tab's id, unique only within its Session.
 * @returns the element, when that Session's tab is in the document.
 */
export function elementForTab(sessionId: string, tabId: string): WebviewElement | undefined {
  const root = sessionRoot(sessionId)
  if (root === undefined) return undefined
  for (const candidate of root.querySelectorAll(WEBVIEW_SELECTOR)) {
    if (!(candidate instanceof HTMLElement)) continue
    if (tabIdOf(candidate) === tabId) return candidate as WebviewElement
  }
  return undefined
}

/**
 * Whether a guest is currently painted.
 *
 * A hidden Sidebar body is `display: none`, so its guest has no compositor
 * surface: every element method still works, but a capture cannot be taken.
 * @param element - the mounted webview.
 * @returns whether the guest is visible.
 */
export function isGuestVisible(element: WebviewElement): boolean {
  return element.closest('[hidden], [aria-hidden="true"]') === null
}

/**
 * The Browser tabs one Session owns.
 * @param sessionId - the Session whose tabs to list.
 * @param sidebar - the right-Sidebar face, when the plugin has it.
 * @returns that Session's Browser tabs, in inventory order.
 */
export function browserTabsOf(sessionId: string, sidebar: BrowserSidebarRight | undefined): readonly BrowserTabRecord[] {
  const tabs = sidebar?.openTabs.getSnapshot() ?? []
  return tabs.filter(tab => tab.sessionId === sessionId && tab.kind === 'browser')
}

/**
 * Find the mounted Browser page one Session's command should drive.
 *
 * Only that Session's tabs are considered, so a command can never act on the
 * page another Session happens to be showing.
 * @param sessionId - the Session whose model issued the command.
 * @param pageId - the page the model named, when it named one.
 * @param sidebar - the right-Sidebar face, when the plugin has it.
 * @returns the tab handle, or undefined when that Session has no mounted Browser page.
 */
export function findSessionTab(sessionId: string, pageId: string | undefined, sidebar: BrowserSidebarRight | undefined): BrowserTabHandle | undefined {
  const tabs = browserTabsOf(sessionId, sidebar)
  const wanted = pageId === undefined || pageId.length === 0 ? tabs[0]?.tabId : pageId
  if (wanted === undefined) return undefined
  // An explicit page id is still checked against the Session, so no caller can
  // reach another Session's page by naming it.
  if (!tabs.some(tab => tab.tabId === wanted)) return undefined
  const element = elementForTab(sessionId, wanted)
  return element === undefined ? undefined : { tabId: wanted, element }
}

/**
 * Whether one Session owns a page id.
 * @param sessionId - the Session to test against.
 * @param pageId - the page identity the model named.
 * @param sidebar - the right-Sidebar face, when the plugin has it.
 * @returns whether that Session's inventory records the page.
 */
export function sessionOwnsPage(sessionId: string, pageId: string, sidebar: BrowserSidebarRight | undefined): boolean {
  return browserTabsOf(sessionId, sidebar).some(tab => tab.tabId === pageId)
}

/**
 * Wait for the Browser page a Session just asked for to mount.
 *
 * The inventory appends a new tab, so the page that appeared is the one absent
 * from the ids the Session already had; taking the first tab instead would
 * report the page the Session was already showing.
 * @param sessionId - the Session that should receive the page.
 * @param known - the tab ids that Session had before the open.
 * @param sidebar - the right-Sidebar face.
 * @param signal - the command's cancellation.
 * @returns the mounted tab handle.
 * @throws when no page appears within the budget.
 */
export async function waitForSessionTab(
  sessionId: string,
  known: readonly string[],
  sidebar: BrowserSidebarRight | undefined,
  signal: AbortSignal,
): Promise<BrowserTabHandle> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('the browser operation was cancelled while opening the built-in Browser page')
    const opened = browserTabsOf(sessionId, sidebar).find(tab => !known.includes(tab.tabId))
    const handle = opened === undefined ? undefined : findSessionTab(sessionId, opened.tabId, sidebar)
    if (handle !== undefined) {
      await waitForGuestReady(handle.element, signal)
      return handle
    }
    await delay(50, signal)
  }
  throw new Error('the built-in Browser page did not mount within 15 seconds')
}

/**
 * Whether the guest is attached and has emitted `dom-ready`.
 *
 * Electron refuses every element method before that point, so readiness is
 * probed by calling one and treating its refusal as "not yet".
 * @param element - the mounted webview.
 * @returns whether element methods may be called.
 */
export function isGuestReady(element: WebviewElement): boolean {
  try {
    element.getURL()
    return true
  } catch (error) {
    // The only expected refusal here is Electron's not-yet-attached guard; any
    // other failure would also mean the element cannot be driven yet.
    if (error instanceof Error) return false
    throw error
  }
}

/**
 * Wait until the guest accepts element methods.
 * @param element - the mounted webview.
 * @param signal - the command's cancellation.
 * @throws when the guest never becomes ready within the budget.
 */
export async function waitForGuestReady(element: WebviewElement, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('the browser operation was cancelled while waiting for the page')
    if (isGuestReady(element)) return
    await delay(50, signal)
  }
  throw new Error('the built-in Browser page did not become ready within 15 seconds')
}

/**
 * Wait until the guest has committed a document.
 * @param element - the mounted webview.
 * @param signal - the command's cancellation.
 */
export async function waitForDocument(element: WebviewElement, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('the browser operation was cancelled while waiting for the page to load')
    if (!element.isLoading()) return
    await delay(50, signal)
  }
}

/**
 * Read the observable state of one webview.
 * @param handle - the tab handle.
 * @returns the page state reported to the model.
 */
export function pageStateOf(handle: BrowserTabHandle): BrowserPageState {
  observeLoadFailures(handle.element)
  const error = failureOf(handle.element)
  if (!isGuestReady(handle.element)) {
    return { id: handle.tabId, url: '', title: '', loading: true, ...error === undefined ? {} : { error } }
  }
  return {
    id: handle.tabId,
    url: handle.element.getURL(),
    title: handle.element.getTitle(),
    loading: handle.element.isLoading(),
    ...error === undefined ? {} : { error },
  }
}

/**
 * Read every mounted Browser page of one Session.
 * @param sessionId - the Session whose pages to report.
 * @param sidebar - the right-Sidebar face, when the plugin has it.
 * @returns one state per mounted Browser tab of that Session.
 */
export function listPageStates(sessionId: string, sidebar: BrowserSidebarRight | undefined): readonly BrowserPageState[] {
  const states: BrowserPageState[] = []
  for (const tab of browserTabsOf(sessionId, sidebar)) {
    const element = elementForTab(sessionId, tab.tabId)
    if (element === undefined) continue
    observeLoadFailures(element)
    const error = failureOf(element)
    if (!isGuestReady(element)) {
      states.push({ id: tab.tabId, url: '', title: '', loading: true, ...error === undefined ? {} : { error } })
      continue
    }
    states.push({
      id: tab.tabId,
      url: element.getURL(),
      title: element.getTitle(),
      loading: element.isLoading(),
      ...error === undefined ? {} : { error },
    })
  }
  return states
}

/**
 * Wait one bounded interval.
 * @param ms - milliseconds to wait.
 * @param signal - cancellation for the wait.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(new Error('the browser operation was cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}