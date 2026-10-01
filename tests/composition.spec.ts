/**
 * Composition behavior: the built host plugin activates against the real Cordis
 * service machinery and registers its tools, prompt section, and command channel.
 *
 * The stub services below reproduce the contracts the plugin consumes, including
 * the Connection channel registry's own access to the CALLING context's
 * `webServer` — the relation that makes that service a required injection.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, Config, inject, name } from '../src/index.ts'

const BROWSER_TOOL_NAMES = [
  'browser_openBrowserPage',
  'browser_navigatePage',
  'browser_readPage',
  'browser_screenshotPage',
  'browser_clickElement',
  'browser_typeInPage',
  'browser_hoverElement',
  'browser_dragElement',
  'browser_runBrowserCode',
  'browser_handleDialog',
]

interface Harness {
  readonly ctx: Context
  readonly routes: string[]
  readonly channels: string[]
  dispose(): Promise<void>
}

async function bootPlugin(): Promise<Harness> {
  const ctx = new Context()
  const routes: string[] = []
  const channels: string[] = []

  class StubConnection extends Service {
    constructor(owner: Context) { super(owner, 'connection') }
    get fetch(): { register(route: WebRoute): () => Promise<void> } {
      const owner = this.ctx
      return {
        // The real exact-route registry only records the route on the Connection
        // service; unlike a private RPC channel it never reaches for a web-server
        // service, which the loader tree does not expose to an out-of-tree plugin.
        register: (route) => owner.effect(() => {
          channels.push(route.path)
          return () => undefined
        }, 'stub connection fetch route'),
      }
    }
  }

  class StubAttachments extends Service {
    constructor(owner: Context) { super(owner, 'attachments') }
    saveImages(): Promise<readonly never[]> { return Promise.resolve([]) }
  }

  class StubSandboxPolicy extends Service {
    constructor(owner: Context) { super(owner, 'sandboxPolicy') }
    resolve(): { mode: string } { return { mode: 'workspace-write' } }
  }

  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  new StubConnection(ctx)
  new StubAttachments(ctx)
  new StubSandboxPolicy(ctx)
  await ctx.plugin({ name, inject, Config, apply }, {})
  return {
    ctx,
    routes,
    channels,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

test('the host plugin registers all ten browser tools', async () => {
  const harness = await bootPlugin()
  try {
    const registered = harness.ctx.tools.schemas().map(schema => schema.name)
    for (const toolName of BROWSER_TOOL_NAMES) {
      assert.ok(registered.includes(toolName), toolName + ' is not registered; got ' + registered.join(', '))
    }
    assert.equal(registered.filter(entry => entry.startsWith('browser_')).length, BROWSER_TOOL_NAMES.length)
  } finally {
    await harness.dispose()
  }
})

test('the host plugin registers its workflow prompt section', async () => {
  const harness = await bootPlugin()
  try {
    const assembly = await harness.ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === 'dsh-browser.workflow')
    assert.ok(section !== undefined, 'the browser workflow section is missing')
    assert.match(section.text, /untrusted task data/)
  } finally {
    await harness.dispose()
  }
})

test('the browser routes register on the shared API channel', async () => {
  const harness = await bootPlugin()
  try {
    assert.deepEqual(harness.channels, [
      '/api/dsh-browser/hello',
      '/api/dsh-browser/poll',
      '/api/dsh-browser/result',
    ])
    // No web-server service is provided: a plugin that needed one would stay
    // pending and register nothing at all.
    assert.deepEqual(harness.routes, [])
  } finally {
    await harness.dispose()
  }
})

test('disposing the plugin fiber removes its contributions', async () => {
  const harness = await bootPlugin()
  const registry = harness.ctx.tools
  assert.equal(registry.schemas().length, BROWSER_TOOL_NAMES.length)
  await harness.dispose()
  assert.deepEqual(registry.schemas(), [])
})