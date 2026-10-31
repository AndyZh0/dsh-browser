/** Run a model-authored script inside the controlled page, servicing what the page cannot do itself. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BrowserElementInfo, BrowserImageResult, BrowserTarget, BrowserWaitUntil } from '../protocol.ts'
import { performAction, type ActionContext } from './actions.ts'
import { BrowserActionError, ensurePageAgent } from './agent-call.ts'
import { withDeadline } from './deadline.ts'
import { PAGE_SCRIPT_SOURCE, type PageScriptRequest } from './page-script.ts'
import { delay, type WebviewElement } from './webview.ts'

/** Console surface exposed to a managed script. */
export interface ScriptConsole {
  log(...values: readonly unknown[]): void
  info(...values: readonly unknown[]): void
  warn(...values: readonly unknown[]): void
  error(...values: readonly unknown[]): void
}

/**
 * The page object a managed script receives.
 *
 * The script runs in the page, so the navigation methods cannot run there: they
 * reject with `browser/not-in-script` and point at `browser_navigatePage`.
 */
export interface BrowserPageFacade {
  /** Unavailable inside a script; navigation replaces the document and ends it. */
  goto(url: string, options?: { readonly waitUntil?: BrowserWaitUntil }): Promise<void>
  url(): string
  title(): string
  /** Unavailable inside a script; see {@link BrowserPageFacade.goto}. */
  reload(): Promise<void>
  /** Unavailable inside a script; see {@link BrowserPageFacade.goto}. */
  goBack(): Promise<void>
  /** Unavailable inside a script; see {@link BrowserPageFacade.goto}. */
  goForward(): Promise<void>
  waitForSelector(selector: string, options?: { readonly timeoutMs?: number }): Promise<BrowserElementInfo>
  waitForTimeout(ms: number): Promise<void>
  querySelector(selector: string): Promise<BrowserElementInfo | null>
  querySelectorAll(selector: string): Promise<readonly BrowserElementInfo[]>
  click(target: string | BrowserTarget): Promise<BrowserElementInfo>
  fill(target: string | BrowserTarget, text: string): Promise<BrowserElementInfo | undefined>
  type(target: string | BrowserTarget, text: string): Promise<BrowserElementInfo | undefined>
  hover(target: string | BrowserTarget): Promise<BrowserElementInfo>
  dragTo(source: string | BrowserTarget, target: string | BrowserTarget): Promise<void>
  textContent(target?: string | BrowserTarget): Promise<string>
  evaluate(input: string | ((arg: unknown) => unknown), arg?: unknown): Promise<unknown>
  screenshot(options?: { readonly fullPage?: boolean }): Promise<BrowserImageResult>
}

/** Managed-script output. */
export interface ScriptOutcome {
  readonly result: JsonValue
  readonly logs: readonly string[]
}

/** How often the renderer asks the page whether it needs something. */
const POLL_INTERVAL_MS = 40

/**
 * Install the script runtime in the page.
 * @param webview - the mounted webview.
 * @throws BrowserActionError when the document refuses the installation.
 */
export async function ensurePageScript(webview: WebviewElement): Promise<void> {
  const installed = await webview.executeJavaScript(PAGE_SCRIPT_SOURCE, false)
  if (installed !== true) {
    throw new BrowserActionError('browser/script-failed', 'the script runtime did not install in the controlled document')
  }
}

/**
 * Execute one managed script inside the controlled page.
 *
 * The body runs in the page, so it can reach the document directly. The page
 * cannot screenshot itself or inject trusted input, so those calls — and string
 * evaluation, which a page's CSP may forbid — are recorded as requests and
 * served here while the script awaits them.
 * @param ctx - the mounted webview, its limits, and the dialog tracker.
 * @param code - the script body, receiving `page` and `console`.
 * @param timeoutMs - the script's own deadline.
 * @param signal - the command's cancellation.
 * @returns the script's JSON result and captured console output.
 */
export async function runBrowserScript(ctx: ActionContext, code: string, timeoutMs: number, signal: AbortSignal): Promise<ScriptOutcome> {
  await ensurePageAgent(ctx.webview)
  await ensurePageScript(ctx.webview)
  await ctx.webview.executeJavaScript('globalThis.__dshBrowserScript.reset()', false)
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const state = { done: false }
  const running = ctx.webview.executeJavaScript(wrapScript(code), false)
  const serving = serveRequests(ctx, state, deadline)
  let raw: unknown
  try {
    raw = await withDeadline(running, deadline, 'browser/timeout', 'the script did not finish before its deadline')
  } catch (error) {
    if (error instanceof BrowserActionError) throw error
    throw new BrowserActionError(
      'browser/script-failed',
      'the script could not be evaluated in the page: ' + (error instanceof Error ? error.message : String(error)),
    )
  } finally {
    state.done = true
    await serving
  }
  const envelope = raw as { readonly ok?: unknown; readonly value?: unknown; readonly error?: { readonly code?: unknown; readonly message?: unknown } } | null
  if (envelope === null || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
    throw new BrowserActionError('browser/script-failed', 'the page returned no script result')
  }
  if (!envelope.ok) {
    throw new BrowserActionError(
      String(envelope.error?.code ?? 'browser/script-failed'),
      String(envelope.error?.message ?? 'the script failed inside the page'),
    )
  }
  return { result: (envelope.value ?? null) as JsonValue, logs: await readLogs(ctx.webview) }
}

/**
 * Wrap one script body so the page can run it and report both outcomes.
 * @param code - the model's script body.
 * @returns a self-contained expression evaluated in the page.
 */
function wrapScript(code: string): string {
  return [
    '(async () => {',
    '  const runtime = globalThis.__dshBrowserScript;',
    '  if (runtime === undefined) return { ok: false, error: { code: "browser/agent-failed", message: "the script runtime is not installed" } };',
    '  try {',
    '    const value = await (async (page, console) => {',
    code,
    '    })(runtime.page, runtime.console);',
    '    let json = null;',
    '    try { json = value === undefined ? null : JSON.parse(JSON.stringify(value)); }',
    '    catch (error) { json = null; }',
    '    return { ok: true, value: json };',
    '  } catch (error) {',
    '    const code = error && error.code ? String(error.code) : "browser/script-failed";',
    '    const message = error && error.message ? String(error.message) : String(error);',
    '    return { ok: false, error: { code, message } };',
    '  }',
    '})()',
  ].join('\n')
}

/**
 * Answer the page's recorded requests until the script settles.
 * @param ctx - the mounted webview and its limits.
 * @param state - shared flag the runner sets when the script is done.
 * @param deadline - the script's deadline.
 */
async function serveRequests(ctx: ActionContext, state: { done: boolean }, deadline: AbortSignal): Promise<void> {
  while (!state.done && !deadline.aborted) {
    let request: PageScriptRequest | null
    try {
      request = await ctx.webview.executeJavaScript('globalThis.__dshBrowserScript.take()', false) as PageScriptRequest | null
    } catch (error) {
      // The document may be gone; the runner reports the script's own failure.
      if (error instanceof Error) return
      throw error
    }
    if (request === null || request === undefined) {
      await delay(POLL_INTERVAL_MS, deadline).catch(() => undefined)
      continue
    }
    await answer(ctx, request, deadline)
  }
}

/**
 * Perform one recorded request and resolve the page's pending promise.
 * @param ctx - the mounted webview and its limits.
 * @param request - the operation the page asked for.
 * @param deadline - the script's deadline.
 */
async function answer(ctx: ActionContext, request: PageScriptRequest, deadline: AbortSignal): Promise<void> {
  let ok = true
  let payload: unknown
  try {
    payload = await serveRequest(ctx, request, deadline)
  } catch (error) {
    ok = false
    payload = error instanceof BrowserActionError
      ? { code: error.code, message: error.message }
      : { code: 'browser/script-failed', message: error instanceof Error ? error.message : String(error) }
  }
  await ctx.webview.executeJavaScript(
    'globalThis.__dshBrowserScript.settle(' + String(request.id) + ', ' + (ok ? 'true' : 'false') + ', ' + JSON.stringify(payload ?? null) + ')',
    false,
  )
}

/**
 * Perform one operation the page cannot perform itself.
 * @param ctx - the mounted webview and its limits.
 * @param request - the recorded request.
 * @param deadline - the script's deadline.
 * @returns the value the page's promise resolves with.
 */
async function serveRequest(ctx: ActionContext, request: PageScriptRequest, deadline: AbortSignal): Promise<unknown> {
  if (request.method === 'screenshot') {
    const options = (request.args[0] ?? {}) as { readonly fullPage?: boolean; readonly target?: unknown }
    const outcome = await performAction({
      kind: 'screenshot',
      ...options.target === undefined ? {} : { target: toTarget(options.target) },
      ...options.fullPage === true ? { fullPage: true } : {},
    }, ctx, deadline)
    if (outcome.image === undefined) throw new BrowserActionError('browser/screenshot-failed', 'the renderer produced no capture')
    return outcome.image
  }
  if (request.method === 'click') {
    const options = (request.args[1] ?? {}) as { readonly button?: 'left' | 'middle' | 'right'; readonly clickCount?: number; readonly modifiers?: readonly ('Alt' | 'Control' | 'Meta' | 'Shift')[] }
    const outcome = await performAction({
      kind: 'click',
      target: toTarget(request.args[0]),
      ...options.button === undefined ? {} : { button: options.button },
      ...options.clickCount === undefined ? {} : { clickCount: options.clickCount },
      ...options.modifiers === undefined ? {} : { modifiers: options.modifiers },
    }, ctx, deadline)
    return outcome.target
  }
  if (request.method === 'hover') {
    const outcome = await performAction({ kind: 'hover', target: toTarget(request.args[0]) }, ctx, deadline)
    return outcome.target
  }
  if (request.method === 'evaluate') {
    return await ctx.webview.executeJavaScript(String(request.args[0]), false)
  }
  throw new BrowserActionError('browser/script-failed', 'the page asked for an unsupported operation: ' + request.method)
}

/**
 * A bare selector string stands for a selector target, as the tools accept it.
 * @param value - the target the page passed.
 * @returns a target the actions resolve.
 */
function toTarget(value: unknown): BrowserTarget {
  return typeof value === 'string' ? { selector: value } : value as BrowserTarget
}

/**
 * Read the console output the page buffered.
 * @param webview - the mounted webview.
 * @returns the captured lines.
 */
async function readLogs(webview: WebviewElement): Promise<readonly string[]> {
  const raw = await webview.executeJavaScript('globalThis.__dshBrowserScript.takeLogs()', false)
  return Array.isArray(raw) ? raw as readonly string[] : []
}