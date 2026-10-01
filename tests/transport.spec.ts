/**
 * The Client half's transport pairing: the endpoints it calls must be the ones
 * the Host registers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/client.ts'
import type { BrowserRpcResult } from '../src/client/ports.ts'

interface RecordedCall {
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

test('the client announces and polls on the shared API channel', async () => {
  const ctx = new Context()
  const calls: RecordedCall[] = []

  class StubConnection extends Service {
    constructor(owner: Context) { super(owner, 'connection') }
    get rpc(): { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<BrowserRpcResult> } {
      return {
        call: (channel, endpoint, payload) => {
          calls.push({ channel, endpoint, payload })
          return Promise.resolve({ ok: false, error: { code: 'stub', message: 'the stub transport carries no browser traffic' } })
        },
      }
    }
  }

  new StubConnection(ctx)
  await ctx.plugin({ name, inject, apply })
  try {
    await delay(80)
    assert.equal(calls[0]?.channel, '/api')
    assert.equal(calls[0]?.endpoint, 'dsh-browser/hello')
    const hello = calls[0]?.payload as { clientId?: unknown; desktop?: unknown } | undefined
    assert.equal(typeof hello?.clientId, 'string')
    assert.equal(hello?.desktop, false)
    assert.equal(calls[1]?.channel, '/api')
    assert.equal(calls[1]?.endpoint, 'dsh-browser/poll')
  } finally {
    await ctx.fiber.dispose()
  }
})