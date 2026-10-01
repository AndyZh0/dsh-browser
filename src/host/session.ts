/** Command queue, Client registry, and settlement for one browser Host session. */

import { randomUUID } from 'node:crypto'
import type {
  BrowserAction, BrowserCommand, BrowserCommandLimits, BrowserFailure, BrowserOutcome, BrowserPollResponse, BrowserResultPayload,
} from '../protocol.ts'
import { BROWSER_HELLO_ENDPOINT, BROWSER_POLL_ENDPOINT, BROWSER_RESULT_ENDPOINT } from '../protocol.ts'
import type { ResolvedBrowserConfig } from './config.ts'

/** A browser operation could not be delivered or completed. */
export class BrowserSessionError extends Error {
  /**
   * @param code - stable machine-routing code returned to the tool call.
   * @param message - human-readable failure description.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BrowserSessionError'
  }
}

interface PendingCommand {
  readonly commandId: string
  readonly sessionId: string
  readonly action: BrowserAction
  readonly settle: (outcome: BrowserOutcome) => void
  readonly fail: (error: BrowserFailure) => void
  readonly expire: () => void
  claimed: boolean
  clientTimer: NodeJS.Timeout | undefined
  operationTimer: NodeJS.Timeout | undefined
}

interface Waiter {
  readonly deliver: (command: BrowserCommand) => void
  readonly close: () => void
  readonly timer: NodeJS.Timeout
  readonly abort: () => void
}

/**
 * Owns the pending command queue, the connected Client generations, and every
 * settlement path. Commands are claimed in submission order; one Client
 * executes one command at a time.
 */
export class BrowserHostSession {
  private readonly queue: BrowserCommand[] = []
  private readonly pending = new Map<string, PendingCommand>()
  private readonly waiters = new Set<Waiter>()
  private readonly clients = new Map<string, number>()
  private admitting = true
  private disposed = false

  /** @param config - resolved browser limits and timings. */
  constructor(private readonly config: ResolvedBrowserConfig) {}

  /** Number of Clients that have polled since the last disposal. */
  get clientCount(): number {
    return this.clients.size
  }

  /** Deployment limits the Client applies to every command. */
  get limits(): BrowserCommandLimits {
    return {
      lingerMs: this.config.lingerMs,
      maxReadChars: this.config.maxReadChars,
      maxOutputChars: this.config.maxOutputChars,
      codeTimeoutMs: this.config.codeTimeoutMs,
      maxFullPageTiles: this.config.maxFullPageTiles,
    }
  }

  /**
   * Register one polling renderer.
   * @param payload - decoded `hello` payload.
   */
  hello(payload: unknown): void {
    const clientId = readClientId(payload)
    this.clients.set(clientId, Date.now())
  }

  /**
   * Claim the next pending command, or wait for one.
   * @param payload - decoded `poll` payload.
   * @param signal - the HTTP request lifetime.
   * @returns the claimed command, or an idle marker.
   */
  async poll(payload: unknown, signal: AbortSignal): Promise<BrowserPollResponse> {
    const clientId = readClientId(payload)
    this.clients.set(clientId, Date.now())
    const queued = this.queue.shift()
    if (queued !== undefined) {
      this.claim(queued)
      return { command: queued }
    }
    if (!this.admitting) return { idle: true }
    return await new Promise<BrowserPollResponse>((resolve) => {
      const finish = (value: BrowserPollResponse): void => {
        clearTimeout(waiter.timer)
        signal.removeEventListener('abort', waiter.abort)
        this.waiters.delete(waiter)
        resolve(value)
      }
      const waiter: Waiter = {
        deliver: (command) => { finish({ command }) },
        close: () => { finish({ idle: true }) },
        timer: setTimeout(() => { finish({ idle: true }) }, this.config.pollTimeoutMs),
        abort: () => { finish({ idle: true }) },
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.waiters.add(waiter)
    })
  }

  /**
   * Settle one claimed command.
   * @param payload - decoded `result` payload.
   * @throws BrowserSessionError when the command is unknown or already settled.
   */
  settle(payload: unknown): void {
    const result = readResultPayload(payload)
    const entry = this.pending.get(result.commandId)
    if (entry === undefined) {
      throw new BrowserSessionError('browser/unknown-command', 'no browser command is awaiting result ' + result.commandId)
    }
    if (result.ok) entry.settle(result.outcome)
    else entry.fail(result.error)
  }

  /**
   * Queue one browser action and await its settlement.
   * @param sessionId - the Session whose model requested the action.
   * @param action - the operation the Client performs.
   * @param signal - the tool call's cancellation.
   * @param timeoutMs - deadline for the claimed operation.
   * @returns the Client's outcome for this action.
   */
  async execute(sessionId: string, action: BrowserAction, signal: AbortSignal, timeoutMs: number): Promise<BrowserOutcome> {
    if (!this.admitting || this.disposed) {
      throw new BrowserSessionError('browser/unavailable', 'the dsh-browser plugin is shutting down and accepts no new browser operations')
    }
    if (signal.aborted) throw new BrowserSessionError('browser/cancelled', 'the browser operation was cancelled before dispatch')
    const commandId = randomUUID()
    const command: BrowserCommand = { commandId, sessionId, action, limits: this.limits }
    return await new Promise<BrowserOutcome>((resolve, reject) => {
      const cleanup = (): void => {
        const entry = this.pending.get(commandId)
        if (entry !== undefined) {
          if (entry.clientTimer !== undefined) clearTimeout(entry.clientTimer)
          if (entry.operationTimer !== undefined) clearTimeout(entry.operationTimer)
        }
        this.pending.delete(commandId)
        signal.removeEventListener('abort', onAbort)
        const index = this.queue.findIndex(queued => queued.commandId === commandId)
        if (index >= 0) this.queue.splice(index, 1)
      }
      const onAbort = (): void => {
        cleanup()
        reject(new BrowserSessionError('browser/cancelled', 'the browser operation was cancelled'))
      }
      const entry: PendingCommand = {
        commandId,
        sessionId,
        action,
        claimed: false,
        clientTimer: undefined,
        operationTimer: undefined,
        settle: (outcome) => { cleanup(); resolve(outcome) },
        fail: (error) => { cleanup(); reject(new BrowserSessionError(error.code, error.message)) },
        expire: () => {
          cleanup()
          reject(new BrowserSessionError('browser/timeout', 'the browser operation timed out after ' + String(timeoutMs) + 'ms'))
        },
      }
      this.pending.set(commandId, entry)
      signal.addEventListener('abort', onAbort, { once: true })
      const waiter = this.takeWaiter()
      if (waiter !== undefined) {
        this.claim(command)
        waiter.deliver(command)
        return
      }
      this.queue.push(command)
      entry.clientTimer = setTimeout(() => {
        if (entry.claimed) return
        cleanup()
        reject(new BrowserSessionError(
          'browser/client-unavailable',
          this.clients.size === 0
            ? 'no DSH GUI is polling for browser commands; the desktop application must be running with the built-in Browser available'
            : 'the DSH GUI did not claim the browser command within ' + String(this.config.clientWaitMs) + 'ms',
        ))
      }, this.config.clientWaitMs)
    })
  }

  /** Stop admitting new commands; in-flight commands keep their deadlines. */
  closeAdmission(): void {
    this.admitting = false
  }

  /** Reject every waiter and pending command and release all timers. */
  dispose(): void {
    this.disposed = true
    this.admitting = false
    for (const waiter of [...this.waiters]) waiter.close()
    this.waiters.clear()
    for (const entry of [...this.pending.values()]) {
      entry.fail({ code: 'browser/unavailable', message: 'the dsh-browser plugin was disposed before the browser operation settled' })
    }
    this.pending.clear()
    this.queue.length = 0
    this.clients.clear()
  }

  private claim(command: BrowserCommand): void {
    const entry = this.pending.get(command.commandId)
    if (entry === undefined) return
    entry.claimed = true
    if (entry.clientTimer !== undefined) {
      clearTimeout(entry.clientTimer)
      entry.clientTimer = undefined
    }
    entry.operationTimer = setTimeout(() => { entry.expire() }, this.config.operationTimeoutMs)
  }

  private takeWaiter(): Waiter | undefined {
    for (const waiter of this.waiters) {
      this.waiters.delete(waiter)
      return waiter
    }
    return undefined
  }
}

function readClientId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) throw new BrowserSessionError('browser/bad-request', 'the browser Client payload must be an object')
  const value = (payload as { clientId?: unknown }).clientId
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new BrowserSessionError('browser/bad-request', 'the browser Client payload must carry a clientId of 1-128 characters')
  }
  return value
}

function readResultPayload(payload: unknown): BrowserResultPayload {
  if (typeof payload !== 'object' || payload === null) throw new BrowserSessionError('browser/bad-request', 'the browser result payload must be an object')
  const record = payload as { commandId?: unknown; ok?: unknown }
  if (typeof record.commandId !== 'string' || typeof record.ok !== 'boolean') {
    throw new BrowserSessionError('browser/bad-request', 'the browser result payload must carry commandId and ok')
  }
  return payload as BrowserResultPayload
}

/** Endpoint names this session serves, exported for route registration. */
export const BROWSER_ENDPOINTS = [BROWSER_HELLO_ENDPOINT, BROWSER_POLL_ENDPOINT, BROWSER_RESULT_ENDPOINT] as const