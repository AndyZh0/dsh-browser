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
import { runBrowserScript } from './script.ts'
import type { BrowserSidebarRight } from './ports.ts'
import {
  delay, findBrowserTab, listPageStates, openBrowserTab, pageStateOf, waitForGuestReady, type BrowserTabHandle,
} from './webview.ts'

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

async function dispatch(ctx: Context, command: BrowserCommand, signal: AbortSignal, border: ModelControlBorder): Promise<BrowserOutcome> {
  const sidebar = ctx.get('sidebarRight')
  const handle = await resolveHandle(sidebar, command, signal)
  // Electron refuses every element method until the guest has emitted dom-ready.
  await waitForGuestReady(handle.element, signal)
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
    pages: listPageStates(),
    ...pending === undefined ? {} : { dialogPending: pending },
    data,
  }
}

async function resolveHandle(sidebar: BrowserSidebarRight | undefined, command: BrowserCommand, signal: AbortSignal): Promise<BrowserTabHandle> {
  const existing = findBrowserTab(undefined, sidebar)
  if (command.action.kind === 'open') {
    if (existing !== undefined) return existing
    if (command.action.url === undefined || command.action.url.length === 0) {
      throw new BrowserActionError(
        'browser/url-required',
        'the built-in Browser page mounts no document until it loads one, so opening it needs a url',
      )
    }
    return await openBrowserTab(sidebar, command.action.url, signal)
  }
  if (existing === undefined) {
    throw new BrowserActionError('browser/page-unavailable', 'no built-in Browser page is open; call browser_openBrowserPage first')
  }
  return existing
}