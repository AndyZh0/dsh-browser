/**
 * Client half of the dsh-browser plugin: polls the Host for browser commands
 * and drives the desktop application's built-in Browser tab.
 * @module dsh-browser/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { createBrowserController } from './client/controller.ts'
import type {} from './client/ports.ts'

/** Cordis plugin identity. */
export const name = 'dsh-browser-client'

/** The Connection service carries every command and result. */
export const inject = ['connection']

/**
 * Start the browser command loop.
 * @param ctx - Client context carrying the Connection service.
 */
export function apply(ctx: Context): void {
  const controller = createBrowserController(ctx)
  ctx.effect(() => controller.start(), 'dsh-browser: browser client')
}