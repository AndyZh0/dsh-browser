/** Exact Connection Fetch routes carrying browser commands and their results. */

import type { Context } from '@deepseek-ai/cordis'
import {
  BROWSER_HELLO_ENDPOINT, BROWSER_HELLO_PATH, BROWSER_POLL_ENDPOINT, BROWSER_POLL_PATH,
  BROWSER_RESULT_ENDPOINT, BROWSER_RESULT_PATH,
} from '../protocol.ts'
import { BrowserHostSession, BrowserSessionError } from './session.ts'

/** One decoded client request envelope. */
interface BrowserEnvelope {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/**
 * Register the plugin's three Connection Fetch routes.
 *
 * The routes live on the shared `/api` channel rather than a private channel:
 * a private channel registers a web route on the calling context, which the
 * loader tree does not expose to an out-of-tree plugin.
 * @param ctx - Host context carrying the Connection service.
 * @param session - the browser session that owns command settlement.
 */
export function registerBrowserRpc(ctx: Context, session: BrowserHostSession): void {
  registerRoute(ctx, BROWSER_HELLO_PATH, BROWSER_HELLO_ENDPOINT, (payload) => {
    session.hello(payload)
    return { registered: true }
  })
  registerRoute(ctx, BROWSER_POLL_PATH, BROWSER_POLL_ENDPOINT, async (payload, signal) => await session.poll(payload, signal))
  registerRoute(ctx, BROWSER_RESULT_PATH, BROWSER_RESULT_ENDPOINT, (payload) => {
    session.settle(payload)
    return { settled: true }
  })
}

function registerRoute(
  ctx: Context,
  path: string,
  method: string,
  execute: (payload: unknown, signal: AbortSignal) => Promise<unknown> | unknown,
): void {
  ctx.connection.fetch.register({
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') return new Response('Expected application/json.', { status: 415 })
      let body: unknown
      try {
        body = await request.json()
      } catch (error) {
        // A body that is not JSON is a caller bug, not a server failure.
        return new Response('Invalid JSON body: ' + String(error), { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined || envelope.method !== method) {
        return new Response('Invalid browser RPC envelope for ' + method + '.', { status: 400 })
      }
      try {
        return Response.json({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: await execute(envelope.payload, request.signal) },
        })
      } catch (error) {
        const failure = error instanceof BrowserSessionError
          ? { code: error.code, message: error.message }
          : { code: 'browser/failed', message: error instanceof Error ? error.message : String(error) }
        return Response.json({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: false, error: { ...failure, details: {} } },
        })
      }
    },
  })
}

function readEnvelope(body: unknown): BrowserEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  if (record.type !== 'client-request') return undefined
  if (typeof record.rpcId !== 'string' || record.rpcId.length === 0) return undefined
  if (typeof record.method !== 'string' || record.method.length === 0) return undefined
  return { rpcId: record.rpcId, method: record.method, payload: record.payload }
}
