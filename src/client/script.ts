/** Run a model-authored script in the renderer against a Playwright-shaped page facade. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BrowserElementInfo, BrowserImageResult, BrowserTarget, BrowserWaitUntil } from '../protocol.ts'
import { performAction, type ActionContext } from './actions.ts'
import { agentCall, BrowserActionError, callAgent, ensurePageAgent } from './agent-call.ts'
import type { PageAgentElementInfo, PageAgentRead } from './page-agent.ts'
import { delay } from './webview.ts'

/** Console surface exposed to a managed script. */
export interface ScriptConsole {
  log(...values: readonly unknown[]): void
  info(...values: readonly unknown[]): void
  warn(...values: readonly unknown[]): void
  error(...values: readonly unknown[]): void
}

/** The page object a managed script receives. */
export interface BrowserPageFacade {
  goto(url: string, options?: { readonly waitUntil?: BrowserWaitUntil }): Promise<void>
  url(): string
  title(): string
  reload(): Promise<void>
  goBack(): Promise<void>
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

const MAX_LOG_ENTRIES = 200
const MAX_LOG_CHARS = 2_000

/**
 * Execute one managed script against the mounted page.
 * @param ctx - the mounted webview, its limits, and the dialog tracker.
 * @param code - the script body, receiving `page` and `console`.
 * @param timeoutMs - the script's own deadline.
 * @param signal - the command's cancellation.
 * @returns the script's JSON result and captured console output.
 */
export async function runBrowserScript(ctx: ActionContext, code: string, timeoutMs: number, signal: AbortSignal): Promise<ScriptOutcome> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const logs: string[] = []
  const facade = createFacade(ctx, deadline)
  const consoleProxy = createConsole(logs)
  const factory = new Function('page', 'console', 'return (async () => {' + code + '\n})()') as
    (page: BrowserPageFacade, scriptConsole: ScriptConsole) => Promise<unknown>
  const raw = await factory(facade, consoleProxy)
  return { result: toJson(raw), logs }
}

function createConsole(logs: string[]): ScriptConsole {
  const record = (...values: readonly unknown[]): void => {
    if (logs.length >= MAX_LOG_ENTRIES) return
    logs.push(values.map(value => describeValue(value)).join(' ').slice(0, MAX_LOG_CHARS))
  }
  return { log: record, info: record, warn: record, error: record }
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value) ?? String(value)
  } catch (error) {
    // A cyclic or otherwise unserializable console argument still has a textual form.
    console.warn('dsh-browser: console argument is not JSON-serializable', error)
    return String(value)
  }
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch (error) {
    throw new BrowserActionError('browser/script-result-not-serializable', 'the script result is not JSON-serializable: ' + String(error))
  }
}

function toTarget(value: string | BrowserTarget): BrowserTarget {
  return typeof value === 'string' ? { selector: value } : value
}

function createFacade(ctx: ActionContext, deadline: AbortSignal): BrowserPageFacade {
  const webview = ctx.webview
  // A managed script may navigate between its own calls, so every agent-backed
  // method installs the agent first instead of assuming one is present.
  const ask = async <T>(expression: string, userGesture: boolean): Promise<T> => {
    await ensurePageAgent(webview)
    return await callAgent<T>(webview, expression, userGesture)
  }
  return {
    async goto(url, options) {
      await performAction({ kind: 'navigate', direction: 'goto', url, ...options === undefined ? {} : { waitUntil: options.waitUntil } }, ctx, deadline)
    },
    url: () => webview.getURL(),
    title: () => webview.getTitle(),
    async reload() { await performAction({ kind: 'navigate', direction: 'reload' }, ctx, deadline) },
    async goBack() { await performAction({ kind: 'navigate', direction: 'back' }, ctx, deadline) },
    async goForward() { await performAction({ kind: 'navigate', direction: 'forward' }, ctx, deadline) },
    async waitForSelector(selector, options) {
      const deadlineAt = Date.now() + (options?.timeoutMs ?? 10_000)
      let last: BrowserActionError | undefined
      while (Date.now() < deadlineAt) {
        deadline.throwIfAborted()
        try {
          return await ask<PageAgentElementInfo>(agentCall('resolve', { selector, exact: true }), false)
        } catch (error) {
          last = error instanceof BrowserActionError ? error : new BrowserActionError('browser/agent-failed', String(error))
          if (last.code !== 'browser/target-missing') throw last
        }
        await delay(100, deadline)
      }
      throw last ?? new BrowserActionError('browser/timeout', 'no element matched ' + JSON.stringify(selector))
    },
    async waitForTimeout(ms) { await delay(Math.max(0, Math.min(ms, 60_000)), deadline) },
    async querySelector(selector) {
      const found = await ask<readonly PageAgentElementInfo[]>(agentCall('queryAll', selector, 1), false)
      return found[0] ?? null
    },
    async querySelectorAll(selector) {
      return await ask<readonly PageAgentElementInfo[]>(agentCall('queryAll', selector, 200), false)
    },
    async click(target) {
      const outcome = await performAction({ kind: 'click', target: toTarget(target) }, ctx, deadline)
      return requireTarget(outcome.target)
    },
    async fill(target, text) {
      const outcome = await performAction({ kind: 'type', target: toTarget(target), text, mode: 'fill' }, ctx, deadline)
      return outcome.target
    },
    async type(target, text) {
      const outcome = await performAction({ kind: 'type', target: toTarget(target), text, mode: 'type' }, ctx, deadline)
      return outcome.target
    },
    async hover(target) {
      const outcome = await performAction({ kind: 'hover', target: toTarget(target) }, ctx, deadline)
      return requireTarget(outcome.target)
    },
    async dragTo(source, target) {
      await performAction({ kind: 'drag', source: toTarget(source), target: toTarget(target) }, ctx, deadline)
    },
    async textContent(target) {
      const options: Record<string, unknown> = { mode: 'text', cursor: 0, limit: ctx.limits.maxReadChars }
      if (target !== undefined) options.target = toTarget(target)
      const read = await ask<PageAgentRead>(agentCall('read', options), false)
      return read.content
    },
    async evaluate(input, arg) {
      const source = typeof input === 'function'
        ? '(' + input.toString() + ')(' + JSON.stringify(arg ?? null) + ')'
        : '(' + input + ')'
      return await webview.executeJavaScript(source, false)
    },
    async screenshot(options) {
      const outcome = await performAction({ kind: 'screenshot', ...options?.fullPage === true ? { fullPage: true } : {} }, ctx, deadline)
      if (outcome.image === undefined) throw new BrowserActionError('browser/screenshot-failed', 'the renderer produced no capture')
      return outcome.image
    },
  }
}

function requireTarget(target: BrowserElementInfo | undefined): BrowserElementInfo {
  if (target === undefined) throw new BrowserActionError('browser/agent-failed', 'the page agent returned no element')
  return target
}