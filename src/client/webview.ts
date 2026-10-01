/** Locate the built-in Browser tab's Electron webview and read its state. */

import type { BrowserPageState } from '../protocol.ts'
import type { BrowserSidebarRight } from './ports.ts'

/** The DOM marker the built-in Browser renderer and the Desktop shell both rely on. */
export const WEBVIEW_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]'
/** The dock-kit marker that carries one tab's identity. */
export const TAB_HOST_SELECTOR = '[data-dockkit-content]'

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

/** The Browser tab this plugin drives, when one is available. */
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

/** Whether a tab's cell is currently selected rather than retained off-screen. */
function isSelected(element: Element): boolean {
  return element.closest('[hidden]') === null
}

/**
 * Find the webview this command should drive.
 * @param pageId - explicit page identity from the model, when it gave one.
 * @param sidebar - the right-Sidebar face, when the plugin has it.
 * @returns the tab handle, or undefined when no Browser page is mounted.
 */
export function findBrowserTab(pageId: string | undefined, sidebar: BrowserSidebarRight | undefined): BrowserTabHandle | undefined {
  const elements = [...document.querySelectorAll(WEBVIEW_SELECTOR)].filter(
    (candidate): candidate is WebviewElement => candidate instanceof HTMLElement,
  )
  if (elements.length === 0) return undefined
  if (pageId !== undefined && pageId.length > 0) {
    for (const element of elements) {
      const tabId = tabIdOf(element)
      if (tabId === pageId) return { tabId, element }
    }
    return undefined
  }
  const active = sidebar?.active()
  if (active !== undefined && active.kind === 'browser') {
    for (const element of elements) {
      const tabId = tabIdOf(element)
      if (tabId === active.id) return { tabId, element }
    }
  }
  const selected = elements.filter(isSelected)
  const element = selected[0] ?? elements[elements.length - 1]
  if (element === undefined) return undefined
  const tabId = tabIdOf(element)
  return tabId === undefined ? undefined : { tabId, element }
}

/**
 * Open the built-in Browser page and wait for its webview to mount.
 * @param sidebar - the right-Sidebar face.
 * @param url - address the new page should open, when the model gave one.
 * @param signal - the command's cancellation.
 * @returns the mounted tab handle.
 * @throws when the Sidebar is unavailable or the webview never mounts.
 */
export async function openBrowserTab(sidebar: BrowserSidebarRight | undefined, url: string | undefined, signal: AbortSignal): Promise<BrowserTabHandle> {
  if (sidebar === undefined) {
    throw new Error('the DSH right Sidebar is unavailable in this renderer, so no built-in Browser page can be opened')
  }
  sidebar.openTab('browser', url === undefined ? {} : { params: { url } })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('the browser operation was cancelled while opening the built-in Browser page')
    const handle = findBrowserTab(undefined, sidebar)
    if (handle !== undefined) {
      await waitForGuestReady(handle.element, signal)
      return handle
    }
    await delay(50, signal)
  }
  throw new Error('the built-in Browser page did not mount a webview within 15 seconds')
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
 * Read every mounted Browser page.
 * @returns one state per Browser tab currently in the document.
 */
export function listPageStates(): readonly BrowserPageState[] {
  const states: BrowserPageState[] = []
  for (const candidate of document.querySelectorAll(WEBVIEW_SELECTOR)) {
    if (!(candidate instanceof HTMLElement)) continue
    const tabId = tabIdOf(candidate)
    if (tabId === undefined) continue
    const element = candidate as WebviewElement
    observeLoadFailures(element)
    const error = failureOf(element)
    if (!isGuestReady(element)) {
      states.push({ id: tabId, url: '', title: '', loading: true, ...error === undefined ? {} : { error } })
      continue
    }
    states.push({
      id: tabId,
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