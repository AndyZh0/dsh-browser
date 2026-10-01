/** Behavior of the resolved browser configuration. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserConfigSchema, resolveBrowserConfig } from '../src/host/config.ts'

test('every limit resolves to its deployment default', () => {
  const resolved = resolveBrowserConfig({})
  assert.equal(resolved.clientWaitMs, 15_000)
  assert.equal(resolved.pollTimeoutMs, 25_000)
  assert.equal(resolved.operationTimeoutMs, 30_000)
  assert.equal(resolved.codeTimeoutMs, 180_000)
  assert.equal(resolved.dialogTimeoutMs, 120_000)
  assert.equal(resolved.lingerMs, 2_000)
  assert.equal(resolved.maxReadChars, 40_000)
  assert.equal(resolved.maxOutputChars, 50_000)
  assert.equal(resolved.maxCodeChars, 100_000)
  assert.equal(resolved.maxScreenshotBytes, 8_388_608)
})

test('an explicit limit replaces its default', () => {
  assert.equal(resolveBrowserConfig({ maxReadChars: 10 }).maxReadChars, 10)
  assert.equal(resolveBrowserConfig({ lingerMs: 0 }).lingerMs, 0)
})

test('the loader schema applies defaults and rejects out-of-range values', () => {
  const resolved = BrowserConfigSchema({}) as { maxReadChars?: number; lingerMs?: number }
  assert.equal(resolved.maxReadChars, 40_000)
  assert.equal(resolved.lingerMs, 2_000)
  assert.throws(() => { BrowserConfigSchema({ clientWaitMs: 0 }) })
})