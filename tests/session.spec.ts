/** Behavior of the Host command queue and its settlement paths. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowserConfig } from '../src/host/config.ts'
import { resolveBrowserConfig } from '../src/host/config.ts'
import { BrowserHostSession, BrowserSessionError } from '../src/host/session.ts'
import type { BrowserOutcome } from '../src/protocol.ts'

const OUTCOME: BrowserOutcome = {
  page: { id: 'p1', url: 'https://example.com/', title: 'Example', loading: false },
  pages: [],
}

function makeSession(overrides: BrowserConfig = {}): BrowserHostSession {
  return new BrowserHostSession(resolveBrowserConfig({ clientWaitMs: 500, pollTimeoutMs: 60, operationTimeoutMs: 500, ...overrides }))
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error)
}

test('a command no client claims fails as client-unavailable', async () => {
  const session = makeSession({ clientWaitMs: 30 })
  const error = await rejection(session.execute('s1', { kind: 'navigate', direction: 'reload' }, new AbortController().signal, 1_000))
  assert.ok(error instanceof BrowserSessionError)
  assert.equal(error.code, 'browser/client-unavailable')
})

test('a claimed command settles through the result endpoint', async () => {
  const session = makeSession()
  const pending = session.execute('s1', { kind: 'navigate', direction: 'reload' }, new AbortController().signal, 1_000)
  const polled = await session.poll({ clientId: 'c1' }, new AbortController().signal)
  assert.ok('command' in polled)
  if (!('command' in polled)) throw new Error('expected a claimed command')
  assert.equal(polled.command.action.kind, 'navigate')
  if (polled.command.action.kind === 'navigate') assert.equal(polled.command.action.direction, 'reload')
  assert.equal(polled.command.limits.maxReadChars, resolveBrowserConfig({}).maxReadChars)
  session.settle({ commandId: polled.command.commandId, ok: true, outcome: OUTCOME })
  const outcome = await pending
  assert.equal(outcome.page.id, 'p1')
})

test('a failed command carries its own code back to the caller', async () => {
  const session = makeSession()
  const pending = rejection(session.execute('s1', { kind: 'navigate', direction: 'reload' }, new AbortController().signal, 1_000))
  const polled = await session.poll({ clientId: 'c1' }, new AbortController().signal)
  if (!('command' in polled)) throw new Error('expected a claimed command')
  session.settle({ commandId: polled.command.commandId, ok: false, error: { code: 'browser/target-missing', message: 'no element matches' } })
  const error = await pending
  assert.ok(error instanceof BrowserSessionError)
  assert.equal(error.code, 'browser/target-missing')
  assert.equal(error.message, 'no element matches')
})

test('an idle poll answers with the idle marker', async () => {
  const session = makeSession({ pollTimeoutMs: 20 })
  const polled = await session.poll({ clientId: 'c1' }, new AbortController().signal)
  assert.deepEqual(polled, { idle: true })
})

test('cancelling the tool call rejects the queued command', async () => {
  const session = makeSession()
  const controller = new AbortController()
  const pending = rejection(session.execute('s1', { kind: 'navigate', direction: 'reload' }, controller.signal, 1_000))
  controller.abort()
  const error = await pending
  assert.ok(error instanceof BrowserSessionError)
  assert.equal(error.code, 'browser/cancelled')
})

test('a claimed command that never settles times out', async () => {
  const session = makeSession({ operationTimeoutMs: 30 })
  const pending = rejection(session.execute('s1', { kind: 'navigate', direction: 'reload' }, new AbortController().signal, 1_000))
  const polled = await session.poll({ clientId: 'c1' }, new AbortController().signal)
  assert.ok('command' in polled)
  const error = await pending
  assert.ok(error instanceof BrowserSessionError)
  assert.equal(error.code, 'browser/timeout')
})

test('settling an unknown command fails loudly', () => {
  const session = makeSession()
  assert.throws(
    () => { session.settle({ commandId: 'missing', ok: true, outcome: OUTCOME }) },
    (error: unknown) => error instanceof BrowserSessionError && error.code === 'browser/unknown-command',
  )
})

test('a malformed client payload is refused', async () => {
  const session = makeSession()
  await assert.rejects(session.poll({}, new AbortController().signal), (error: unknown) => error instanceof BrowserSessionError && error.code === 'browser/bad-request')
})

test('disposal rejects a pending command and stops admitting', async () => {
  const session = makeSession()
  const pending = rejection(session.execute('s1', { kind: 'navigate', direction: 'reload' }, new AbortController().signal, 1_000))
  session.dispose()
  const error = await pending
  assert.ok(error instanceof BrowserSessionError)
  assert.equal(error.code, 'browser/unavailable')
  await assert.rejects(session.execute('s1', { kind: 'navigate', direction: 'reload' }, new AbortController().signal, 1_000), (next: unknown) => next instanceof BrowserSessionError && next.code === 'browser/unavailable')
})

test('a GUI that announced no Desktop surface refuses the command at once', async () => {
  const session = makeSession({ clientWaitMs: 5_000 })
  session.hello({ clientId: 'web', desktop: false })
  const started = Date.now()
  const error = await rejection(session.execute('s1', { kind: 'navigate', direction: 'reload' }, new AbortController().signal, 1_000))
  assert.ok(error instanceof BrowserSessionError)
  assert.equal(error.code, 'browser/desktop-required')
  // The refusal must not wait out the client window.
  assert.ok(Date.now() - started < 1_000)
})

test('a GUI that announced the Desktop surface accepts the command', async () => {
  const session = makeSession()
  session.hello({ clientId: 'desktop', desktop: true })
  const pending = session.execute('s1', { kind: 'navigate', direction: 'reload' }, new AbortController().signal, 1_000)
  const polled = await session.poll({ clientId: 'desktop' }, new AbortController().signal)
  assert.ok('command' in polled)
  if (!('command' in polled)) throw new Error('expected a claimed command')
  session.settle({ commandId: polled.command.commandId, ok: true, outcome: OUTCOME })
  assert.equal((await pending).page.id, 'p1')
})

test('a later poll keeps the surface its client announced', async () => {
  const session = makeSession({ pollTimeoutMs: 20 })
  session.hello({ clientId: 'desktop', desktop: true })
  // The poll payload carries no capability, so it must not reset the record.
  await session.poll({ clientId: 'desktop' }, new AbortController().signal)
  const pending = session.execute('s1', { kind: 'navigate', direction: 'reload' }, new AbortController().signal, 1_000)
  const polled = await session.poll({ clientId: 'desktop' }, new AbortController().signal)
  assert.ok('command' in polled)
  if (!('command' in polled)) throw new Error('expected a claimed command')
  session.settle({ commandId: polled.command.commandId, ok: true, outcome: OUTCOME })
  await pending
})