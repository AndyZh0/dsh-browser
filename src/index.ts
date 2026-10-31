/**
 * Host half of the dsh-browser plugin: twelve browser tools over the desktop
 * application's built-in Browser tab, driven by its renderer.
 * @module dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { BrowserConfigSchema, resolveBrowserConfig, type BrowserConfig } from './host/config.ts'
import { registerBrowserPrompt } from './host/prompt.ts'
import { registerBrowserRpc } from './host/rpc.ts'
import { BrowserHostSession } from './host/session.ts'
import { registerBrowserTools } from './host/tools.ts'

/** Browser Host deployment configuration. */
export type Config = BrowserConfig

/** Loader schema that resolves every browser limit before activation. */
export const Config = BrowserConfigSchema

/** Cordis plugin identity. */
export const name = 'dsh-browser'

/**
 * Host services required by the tools, the prompt section, and the Client routes.
 *
 * The browser routes ride the shared `/api` channel through
 * `ctx.connection.fetch.register()`, which needs no web-server service.
 */
export const inject = ['tools', 'systemPrompt', 'connection', 'attachments']

/**
 * Mount the browser tools, their workflow guidance, and the Client command channel.
 * @param ctx - Host context carrying every injected service.
 * @param input - deployment configuration supplied by the Loader.
 */
export function apply(ctx: Context, input: Config): void {
  const config = resolveBrowserConfig(input)
  const session = new BrowserHostSession(config)
  registerBrowserTools({ ctx, session, config })
  registerBrowserPrompt(ctx)
  registerBrowserRpc(ctx, session)
  ctx.effect(() => () => {
    session.closeAdmission()
    session.dispose()
  }, 'dsh-browser: session')
}