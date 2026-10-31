/** In-page runtime for managed scripts: the page facade, the request queue, and log capture. */

import type { DshPageAgent, PageAgentTarget } from './page-agent.ts'

/** Version of the in-page script runtime; a mismatch reinstalls it. */
export const PAGE_SCRIPT_VERSION = 1

declare global {
  /** Page-side script runtime installed by the dsh-browser renderer. */
  // eslint-disable-next-line no-var
  var __dshBrowserScript: DshPageScript | undefined
}

/** One operation the page cannot perform for itself, recorded for the renderer to serve. */
export interface PageScriptRequest {
  /** Request identity, unique within one run. */
  readonly id: number
  /** The operation the renderer must perform. */
  readonly method: string
  /** Lossless-JSON arguments. */
  readonly args: readonly unknown[]
}

/** The in-page surface the renderer operates. */
export interface DshPageScript {
  readonly version: number
  /** The facade a managed script receives as `page`; the renderer passes it through untouched. */
  readonly page: unknown
  /** The captured-console facade a managed script receives as `console`. */
  readonly console: unknown
  /** Next recorded request, or null when the page has asked for nothing. */
  take(): PageScriptRequest | null
  /** Settle one recorded request, resolving or rejecting the page's promise. */
  settle(id: number, ok: boolean, payload: unknown): void
  /** Take the buffered console output. */
  takeLogs(): readonly string[]
  /** Clear buffered state before a new run. */
  reset(): void
}

/**
 * Install the script runtime in the page's main world.
 *
 * Self-contained by construction: the source is serialized with
 * `Function.prototype.toString`, so it reaches the page as plain JavaScript and
 * must not close over anything outside this function.
 * @returns true once the runtime is installed at the current version.
 */
export function pageScriptMain(): boolean {
  const VERSION = 1
  const existing = globalThis.__dshBrowserScript
  if (existing !== undefined && existing.version === VERSION) return true

  const MAX_LOGS = 200
  const MAX_LOG_CHARS = 2_000

  let nextId = 0
  let logs: string[] = []
  let queue: { id: number; method: string; args: readonly unknown[] }[] = []
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()

  function fail(code: string, message: string): { code: string; message: string } {
    return { code, message }
  }

  function describe(value: unknown): string {
    try {
      return (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).slice(0, MAX_LOG_CHARS)
    } catch (error) {
      // A cyclic or otherwise unserializable value still needs a stable log line.
      if (error instanceof Error) return '<unserializable>'
      throw error
    }
  }

  function record(...values: readonly unknown[]): void {
    if (logs.length >= MAX_LOGS) return
    logs.push(values.map(describe).join(' '))
  }

  function unwrap(result: unknown): unknown {
    const envelope = result as { ok?: unknown; value?: unknown; code?: unknown; message?: unknown } | null
    if (envelope === null || envelope === undefined || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
      throw fail('browser/agent-failed', 'the page agent returned an unusable result')
    }
    if (envelope.ok) return envelope.value
    throw fail(String(envelope.code), String(envelope.message))
  }

  function agent(): DshPageAgent {
    const runtime = globalThis.__dshBrowserAgent
    if (runtime === undefined) throw fail('browser/agent-failed', 'the page agent is not installed')
    return runtime
  }

  /** A bare selector string stands for a selector target, as the renderer's own facade does. */
  function toTarget(value: unknown): PageAgentTarget {
    return typeof value === 'string' ? { selector: value } : value as PageAgentTarget
  }

  function ask(method: string, args: readonly unknown[]): Promise<unknown> {
    const id = nextId + 1
    nextId = id
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      queue.push({ id, method, args })
    })
  }

  function wait(ms: number): Promise<void> {
    return new Promise(resolve => { setTimeout(resolve, Math.max(0, Math.min(ms, 60_000))) })
  }

  function unavailable(name: string): () => Promise<never> {
    return async () => {
      throw fail('browser/not-in-script', 'page.' + name + ' cannot run inside the page: navigating replaces the document and ends the script. Call browser_navigatePage first, then start a new script.')
    }
  }

  const page = {
    goto: unavailable('goto'),
    reload: unavailable('reload'),
    goBack: unavailable('goBack'),
    goForward: unavailable('goForward'),
    url: (): string => location.href,
    title: (): string => document.title,
    async waitForSelector(selector: string, options?: { readonly timeoutMs?: number }): Promise<unknown> {
      const deadlineAt = Date.now() + (options?.timeoutMs ?? 10_000)
      let last: unknown = fail('browser/timeout', 'no element matched ' + JSON.stringify(selector))
      while (Date.now() < deadlineAt) {
        try {
          return unwrap(agent().resolve({ selector, exact: true }))
        } catch (error) {
          // Only a missing element is retried; any other failure is the caller's answer.
          if ((error as { code?: unknown }).code !== 'browser/target-missing') throw error
          last = error
        }
        await wait(100)
      }
      throw last
    },
    async waitForTimeout(ms: number): Promise<void> { await wait(ms) },
    querySelector(selector: string): unknown {
      const found = unwrap(agent().queryAll(selector, 1)) as readonly unknown[]
      return found[0] ?? null
    },
    querySelectorAll(selector: string): readonly unknown[] {
      return unwrap(agent().queryAll(selector, 200)) as readonly unknown[]
    },
    async textContent(target?: unknown): Promise<string> {
      const options: { mode: 'aria' | 'text'; cursor: number; limit: number; target?: PageAgentTarget } = { mode: 'text', cursor: 0, limit: 40_000 }
      if (target !== undefined) options.target = toTarget(target)
      return (unwrap(agent().read(options)) as { content: string }).content
    },
    async click(target: unknown, options?: unknown): Promise<unknown> {
      return await ask('click', [target, options ?? {}])
    },
    async hover(target: unknown): Promise<unknown> {
      return await ask('hover', [target])
    },
    async screenshot(options?: unknown): Promise<unknown> {
      return await ask('screenshot', [options ?? {}])
    },
    async fill(target: unknown, text: string): Promise<unknown> {
      return unwrap(agent().fill(target === undefined ? null : toTarget(target), text, false))
    },
    async type(target: unknown, text: string): Promise<unknown> {
      return unwrap(agent().typeText(target === undefined ? null : toTarget(target), text, false))
    },
    async dragTo(source: unknown, target: unknown): Promise<void> {
      unwrap(agent().dragSynthetic(toTarget(source), toTarget(target)))
    },
    async evaluate(input: unknown, arg?: unknown): Promise<unknown> {
      if (typeof input === 'function') return (input as (value: unknown) => unknown)(arg)
      return await ask('evaluate', [String(input)])
    },
  }

  const consoleFacade = { log: record, info: record, warn: record, error: record }

  globalThis.__dshBrowserScript = {
    version: VERSION,
    page,
    console: consoleFacade,
    take(): PageScriptRequest | null {
      const next = queue.shift()
      return next === undefined ? null : next
    },
    settle(id: number, ok: boolean, payload: unknown): void {
      const entry = pending.get(id)
      if (entry === undefined) return
      pending.delete(id)
      if (ok) entry.resolve(payload)
      else entry.reject(payload)
    },
    takeLogs(): readonly string[] {
      const taken = logs
      logs = []
      return taken
    },
    reset(): void {
      nextId = 0
      logs = []
      queue = []
      pending.clear()
    },
  }
  return true
}

/** The serialized installer, evaluated in the page's main world. */
export const PAGE_SCRIPT_SOURCE = '(' + pageScriptMain.toString() + ')()'
