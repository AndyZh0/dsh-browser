/** Client controller: claim Host commands, drive the built-in Browser tab, settle results. */

import type { Context } from '@deepseek-ai/cordis'
import {
  BROWSER_API_CHANNEL, BROWSER_HELLO_ENDPOINT, BROWSER_POLL_ENDPOINT, BROWSER_RESULT_ENDPOINT,
  type BrowserCommand, type BrowserOutcome, type BrowserOutcomeData, type BrowserResultPayload,
} from '../protocol.ts'
import { performAction, type ActionContext } from './actions.ts'
import { BrowserActionError, drainDialogs } from './agent-call.ts'
import { ModelControlBorder } from './border.ts'
import { DialogTracker } from './dialogs.ts'
import { rememberGuestSize } from './guest-surface.ts'
import { runBrowserScript } from './script.ts'
import type { BrowserSidebarRight } from './ports.ts'
import {
  browserTabsOf, delay, elementForTab, findSessionTab, isGuestVisible, listPageStates, pageStateOf, sessionOwnsPage,
  waitForGuestReady, waitForSessionTab,
  type BrowserTabHandle,
} from './webview.ts'

/** The page each Session used last, so a command with no pageId keeps its place. */
const lastPage = new Map<string, string>()

/** What a polling payload must carry so the Host can name this renderer. */
interface PollResponse {
  readonly command?: BrowserCommand
  readonly idle?: true
}

/** Lifecycle face of the browser Client controller. */
export interface BrowserClientController {
  /** Start polling and return the disposer that stops it. */
  start(): () => void
}

/**
 * Create the browser Client controller.
 * @param ctx - the Client context carrying the Connection service.
 * @returns a controller that polls until its disposer runs.
 */
export function createBrowserController(ctx: Context): BrowserClientController {
  const clientId = 'dsh-browser-' + Math.random().toString(36).slice(2) + '-' + String(Date.now())
  const border = new ModelControlBorder()
  return {
    start(): () => void {
      const lifetime = new AbortController()
      const run = async (): Promise<void> => {
        await announce(ctx, clientId, lifetime.signal)
        while (!lifetime.signal.aborted) {
          try {
            const response = await ctx.connection.rpc.call(BROWSER_API_CHANNEL, BROWSER_POLL_ENDPOINT, { clientId }, lifetime.signal)
            if (!response.ok) {
              await delay(500, lifetime.signal)
              continue
            }
            const value = response.value as PollResponse | null
            if (value === null || value.command === undefined) continue
            await settle(ctx, value.command, lifetime.signal, border)
          } catch (error) {
            if (lifetime.signal.aborted) break
            console.warn('dsh-browser: browser command polling failed', error)
            await delay(500, lifetime.signal).catch(() => undefined)
          }
        }
      }
      void run()
      return () => {
        lifetime.abort()
        border.dispose()
      }
    },
  }
}

async function announce(ctx: Context, clientId: string, signal: AbortSignal): Promise<void> {
  const desktop = (globalThis as { readonly dshDesktop?: { readonly browser?: unknown } }).dshDesktop
  try {
    await ctx.connection.rpc.call(BROWSER_API_CHANNEL, BROWSER_HELLO_ENDPOINT, {
      clientId,
      desktop: desktop?.browser !== undefined,
    }, signal)
  } catch (error) {
    if (signal.aborted) return
    console.warn('dsh-browser: browser client registration failed', error)
  }
}

async function settle(ctx: Context, command: BrowserCommand, signal: AbortSignal, border: ModelControlBorder): Promise<void> {
  let payload: BrowserResultPayload
  try {
    const outcome = await dispatch(ctx, command, signal, border)
    payload = { commandId: command.commandId, ok: true, outcome }
  } catch (error) {
    const failure = error instanceof BrowserActionError
      ? { code: error.code, message: error.message }
      : { code: 'browser/failed', message: error instanceof Error ? error.message : String(error) }
    payload = { commandId: command.commandId, ok: false, error: failure }
  }
  try {
    await ctx.connection.rpc.call(BROWSER_API_CHANNEL, BROWSER_RESULT_ENDPOINT, payload, signal)
  } catch (error) {
    if (!signal.aborted) console.warn('dsh-browser: browser result delivery failed', error)
  }
}

async function dispatch(ctx: Context, command: BrowserCommand, lifetime: AbortSignal, border: ModelControlBorder): Promise<BrowserOutcome> {
  // The Client executes one command at a time, so every command carries its own
  // deadline: a stalled action would otherwise leave later commands unclaimed.
  const bound = command.action.kind === 'code' ? command.limits.codeTimeoutMs : command.limits.operationTimeoutMs
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(bound)])
  const sidebar = ctx.get('sidebarRight')
  const handle = await resolveHandle(sidebar, command, signal)
  // A tab that is leaving has no guest to wait for, and a tab brought forward
  // needs no action on the page at all.
  if (command.action.kind === 'close') return await closePage(sidebar, command, handle, signal)
  if (command.action.kind === 'focus') return await focusPage(sidebar, command, handle)
  // Electron refuses every element method until the guest has emitted dom-ready.
  await waitForGuestReady(handle.element, signal)
  // Remember the size the page is laid out at while it is on screen, so a later
  // capture taken off-window reuses it instead of reflowing the page.
  rememberGuestSize(handle.element)
  border.show(handle.element, command.limits.lingerMs)
  const dialogs = new DialogTracker()
  const actionContext: ActionContext = { webview: handle.element, limits: command.limits, dialogs }
  let data: BrowserOutcomeData
  if (command.action.kind === 'code') {
    const outcome = await runBrowserScript(actionContext, command.action.code, command.limits.codeTimeoutMs, signal)
    data = { script: { result: outcome.result, logs: outcome.logs } }
  } else {
    data = await performAction(command.action, actionContext, signal)
  }
  const pending = dialogs.record(await drainDialogs(handle.element))
  return {
    page: pageStateOf(handle),
    pages: listPageStates(command.sessionId, sidebar),
    ...pending === undefined ? {} : { dialogPending: pending },
    data,
  }
}

/**
 * Resolve the Browser page one Session's command drives.
 *
 * Only the issuing Session's own pages are considered: a command can never act
 * on the page another Session happens to be showing.
 * @param sidebar - the right-Sidebar face, when the plugin has it.
 * @param command - the claimed command, carrying its Session and named page.
 * @param signal - the command's cancellation.
 * @returns the tab handle to drive.
 */
async function resolveHandle(sidebar: BrowserSidebarRight | undefined, command: BrowserCommand, signal: AbortSignal): Promise<BrowserTabHandle> {
  const pageId = command.pageId
  if (pageId !== undefined && pageId.length > 0 && !sessionOwnsPage(command.sessionId, pageId, sidebar)) {
    throw new BrowserActionError(
      'browser/page-not-in-session',
      'page ' + pageId + ' does not belong to this session; browser_openBrowserPage lists the pages this session owns',
    )
  }
  if (command.action.kind === 'open' && command.action.newTab === true) {
    const url = command.action.url
    if (url === undefined || url.length === 0) {
      throw new BrowserActionError(
        'browser/url-required',
        'the built-in Browser page mounts no document until it loads one, so opening it needs a url',
      )
    }
    const opened = await openSessionTab(sidebar, command.sessionId, url, signal)
    lastPage.set(command.sessionId, opened.tabId)
    return opened
  }
  const existing = findSessionTab(command.sessionId, pageId ?? preferredPageId(command.sessionId, sidebar), sidebar)
  if (existing !== undefined) {
    lastPage.set(command.sessionId, existing.tabId)
    return existing
  }
  if (command.action.kind !== 'open') {
    throw new BrowserActionError(
      'browser/page-unavailable',
      'this session has no built-in Browser page open; call browser_openBrowserPage first',
    )
  }
  if (command.action.url === undefined || command.action.url.length === 0) {
    throw new BrowserActionError(
      'browser/url-required',
      'the built-in Browser page mounts no document until it loads one, so opening it needs a url',
    )
  }
  return await openSessionTab(sidebar, command.sessionId, command.action.url, signal)
}

/**
 * Close one page and report what the Session still has open.
 * @param sidebar - the right-Sidebar face.
 * @param command - the claimed command carrying its Session.
 * @param handle - the page to close.
 * @param signal - the command's cancellation.
 * @returns the closed page and the pages that remain.
 */
async function closePage(
  sidebar: BrowserSidebarRight | undefined,
  command: BrowserCommand,
  handle: BrowserTabHandle,
  signal: AbortSignal,
): Promise<BrowserOutcome> {
  const closed = pageStateOf(handle)
  sidebar?.closeIn(command.sessionId, handle.tabId)
  if (lastPage.get(command.sessionId) === handle.tabId) lastPage.delete(command.sessionId)
  // The inventory drops a closed tab on the Sidebar's next render, so the
  // reported list waits for the tab to leave instead of echoing it back.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!listPageStates(command.sessionId, sidebar).some(page => page.id === handle.tabId)) break
    await delay(50, signal)
  }
  return { page: closed, pages: listPageStates(command.sessionId, sidebar) }
}

/**
 * Bring one page to the front of the Session the reader is looking at.
 * @param sidebar - the right-Sidebar face.
 * @param command - the claimed command carrying its Session.
 * @param handle - the page to focus.
 * @returns the focused page and the Session's pages.
 * @throws BrowserActionError when the Sidebar is missing or shows another Session.
 */
async function focusPage(
  sidebar: BrowserSidebarRight | undefined,
  command: BrowserCommand,
  handle: BrowserTabHandle,
): Promise<BrowserOutcome> {
  if (sidebar === undefined) {
    throw new BrowserActionError(
      'browser/sidebar-unavailable',
      'the DSH right Sidebar is unavailable in this renderer, so no built-in Browser page can be focused',
    )
  }
  if (sidebar.mounted.getSnapshot() !== command.sessionId) {
    throw new BrowserActionError(
      'browser/session-not-displayed',
      'this page cannot be brought forward while the reader is looking at another conversation',
    )
  }
  sidebar.focus(handle.tabId)
  lastPage.set(command.sessionId, handle.tabId)
  return { page: pageStateOf(handle), pages: listPageStates(command.sessionId, sidebar) }
}

/**
 * The page a command with no pageId acts on.
 *
 * The Session's own last page comes first so a sequence of calls keeps driving
 * the same tab; the page the reader is looking at is next, so an explicit tab
 * click moves the default with it; the first open page is the last resort.
 * @param sessionId - the Session issuing the command.
 * @param sidebar - the right-Sidebar face, when the plugin has it.
 * @returns the page id to act on, or undefined when the Session has none.
 */
function preferredPageId(sessionId: string, sidebar: BrowserSidebarRight | undefined): string | undefined {
  const pages = listPageStates(sessionId, sidebar)
  const remembered = lastPage.get(sessionId)
  if (remembered !== undefined && pages.some(page => page.id === remembered)) return remembered
  const shown = pages.find((page) => {
    const element = elementForTab(sessionId, page.id)
    return element !== undefined && isGuestVisible(element)
  })
  return (shown ?? pages[0])?.id
}

/**
 * Ask the Sidebar for a Browser page in one Session and wait for it to mount.
 *
 * The public face opens only in the Session on screen. A command from any other
 * Session uses the Tab domain's own entry, which is the only path that places a
 * tab outside the on-screen Session; it does nothing for a Session whose store
 * was never adopted, and that case is reported by name.
 * @param sidebar - the right-Sidebar face.
 * @param sessionId - the Session that should receive the page.
 * @param url - the address the new page should open.
 * @param signal - the command's cancellation.
 * @returns the mounted tab handle.
 */
async function openSessionTab(sidebar: BrowserSidebarRight | undefined, sessionId: string, url: string, signal: AbortSignal): Promise<BrowserTabHandle> {
  if (sidebar === undefined) {
    throw new BrowserActionError(
      'browser/sidebar-unavailable',
      'the DSH right Sidebar is unavailable in this renderer, so no built-in Browser page can be opened',
    )
  }
  const options = { params: { url } }
  const known = browserTabsOf(sessionId, sidebar).map(tab => tab.tabId)
  if (sidebar.mounted.getSnapshot() === sessionId) sidebar.openTab('browser', options)
  else sidebar.openTabIn(sessionId, 'browser', options)
  try {
    return await waitForSessionTab(sessionId, known, sidebar, signal)
  } catch (error) {
    throw new BrowserActionError(
      'browser/session-not-displayed',
      'the built-in Browser page for this session did not appear: a session whose Sidebar was never displayed has no store to open one in'
      + ' (' + (error instanceof Error ? error.message : String(error)) + ')',
    )
  }
}