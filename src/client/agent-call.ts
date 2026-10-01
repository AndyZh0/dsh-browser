/** Page-agent installation, evaluation, and typed calls into the controlled document. */

import { PAGE_AGENT_SOURCE, type PageAgentDialog, type PageAgentResult } from './page-agent.ts'
import type { WebviewElement } from './webview.ts'

/** A page-side operation failed in a way the model must see. */
export class BrowserActionError extends Error {
  /**
   * @param code - stable machine-routing code reported to the model.
   * @param message - human-readable failure description.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BrowserActionError'
  }
}

/**
 * Install the page agent in the guest's main world.
 *
 * The agent is idempotent and self-versioned, so this runs before every action:
 * a navigation replaces the document and its globals.
 * @param webview - the mounted webview.
 * @throws BrowserActionError when the document refuses the installation.
 */
export async function ensurePageAgent(webview: WebviewElement): Promise<void> {
  const installed = await webview.executeJavaScript(PAGE_AGENT_SOURCE, false)
  if (installed !== true) {
    throw new BrowserActionError('browser/agent-failed', 'the page agent did not install in the controlled document')
  }
}

/**
 * Evaluate one expression in the guest's main world.
 * @param webview - the mounted webview.
 * @param expression - self-contained JavaScript expression.
 * @param userGesture - whether the evaluation carries transient user activation.
 * @returns the raw evaluation result.
 */
export async function evaluate(webview: WebviewElement, expression: string, userGesture: boolean): Promise<unknown> {
  return await webview.executeJavaScript(expression, userGesture)
}

/**
 * Call one page-agent method and unwrap its result envelope.
 * @param webview - the mounted webview.
 * @param expression - expression returning a {@link PageAgentResult}.
 * @param userGesture - whether the call carries transient user activation.
 * @returns the unwrapped value.
 * @throws BrowserActionError carrying the page agent's own failure code.
 */
export async function callAgent<T>(webview: WebviewElement, expression: string, userGesture: boolean): Promise<T> {
  const raw = await webview.executeJavaScript(expression, userGesture)
  const result = raw as PageAgentResult<T> | null | undefined
  if (result === null || result === undefined || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    throw new BrowserActionError('browser/agent-failed', 'the page agent returned an unusable result')
  }
  if (!result.ok) throw new BrowserActionError(result.code, result.message)
  return result.value
}

/**
 * Collect the dialogs the page raised since the last drain.
 *
 * Tolerant by construction: navigation and open actions never install the page
 * agent, so a document without one reports no dialogs instead of failing the
 * whole tool call.
 * @param webview - the mounted webview.
 * @returns the dialogs the installed agent recorded, or none.
 */
export async function drainDialogs(webview: WebviewElement): Promise<readonly PageAgentDialog[]> {
  const raw = await webview.executeJavaScript(
    '(globalThis.__dshBrowserAgent ? globalThis.__dshBrowserAgent.takeDialogs() : [])',
    false,
  )
  return Array.isArray(raw) ? raw as readonly PageAgentDialog[] : []
}

/**
 * Build one page-agent call expression.
 * @param method - agent method name.
 * @param args - lossless-JSON arguments; undefined becomes null.
 * @returns a self-contained expression.
 */
export function agentCall(method: string, ...args: readonly unknown[]): string {
  return 'globalThis.__dshBrowserAgent.' + method + '(' + args.map(argument => JSON.stringify(argument ?? null)).join(', ') + ')'
}