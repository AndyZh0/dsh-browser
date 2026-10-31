/** Execute one Host-issued page action against the built-in Browser tab. */

import type {
  BrowserAction, BrowserCommandLimits, BrowserImageResult, BrowserModifier, BrowserMouseButton, BrowserOutcomeData, BrowserRect,
} from '../protocol.ts'
import { agentCall, BrowserActionError, callAgent, ensurePageAgent } from './agent-call.ts'
import type { DialogTracker } from './dialogs.ts'
import { withDeadline } from './deadline.ts'
import { guestCaptureSize, withPaintedGuest } from './guest-surface.ts'
import type { PageAgentDialog, PageAgentElementInfo, PageAgentMetrics, PageAgentRead } from './page-agent.ts'
import { delay, isGuestVisible, waitForDocument, type WebviewElement, type WebviewNativeImage } from './webview.ts'

/** One page action: everything except the renderer-side script action. */
export type PageAction = Exclude<
  BrowserAction,
  { readonly kind: 'code' } | { readonly kind: 'close' } | { readonly kind: 'focus' }
>

/** Everything one action needs from the renderer. */
export interface ActionContext {
  readonly webview: WebviewElement
  readonly limits: BrowserCommandLimits
  readonly dialogs: DialogTracker
}

/**
 * Perform one page action.
 * @param action - the operation the Host issued.
 * @param ctx - the mounted webview, its limits, and the dialog tracker.
 * @param signal - the command's cancellation.
 * @returns the action-specific facts for the tool result.
 */
export async function performAction(action: PageAction, ctx: ActionContext, signal: AbortSignal): Promise<BrowserOutcomeData> {
  // The page agent lives in the visited document, so every agent-backed action
  // installs it first: a managed script can navigate between two of its own calls.
  if (action.kind !== 'open' && action.kind !== 'navigate') await ensurePageAgent(ctx.webview)
  switch (action.kind) {
    case 'open': return await runOpen(action, ctx, signal)
    case 'navigate': return await runNavigate(action, ctx, signal)
    case 'read': return await runRead(action, ctx)
    case 'screenshot': return await runScreenshot(action, ctx, signal)
    case 'click': return await runClick(action, ctx)
    case 'type': return await runType(action, ctx)
    case 'hover': return await runHover(action, ctx, signal)
    case 'drag': return await runDrag(action, ctx)
    case 'dialog': return await runDialog(action, ctx)
  }
}

async function runOpen(action: Extract<PageAction, { kind: 'open' }>, ctx: ActionContext, signal: AbortSignal): Promise<BrowserOutcomeData> {
  const url = action.url
  if (url === undefined || url.length === 0) return {}
  // Opening the page carried this address to the Sidebar's own controller, so
  // give that load a moment before deciding whether a second one is needed.
  await delay(150, signal)
  if (!sameAddress(ctx.webview.getURL(), url)) {
    await ctx.webview.loadURL(url)
    await waitForDocument(ctx.webview, signal)
  }
  return {}
}

/** Whether two addresses name the same document, ignoring URL normalization. */
function sameAddress(current: string, requested: string): boolean {
  try {
    return new URL(current).href === new URL(requested).href
  } catch (error) {
    // An address the URL parser rejects can only be compared verbatim.
    if (error instanceof TypeError) return current === requested
    throw error
  }
}

async function runNavigate(action: Extract<PageAction, { kind: 'navigate' }>, ctx: ActionContext, signal: AbortSignal): Promise<BrowserOutcomeData> {
  if (action.direction === 'goto') {
    if (action.url === undefined || action.url.length === 0) throw new BrowserActionError('browser/bad-request', 'goto requires a url')
    await ctx.webview.loadURL(action.url)
  } else {
    await issueHistoryCommand(ctx.webview, action.direction, signal)
  }
  if (action.waitUntil !== 'commit') await waitForDocument(ctx.webview, signal)
  return {}
}

/** One history command, wrapped so the caller's try owns a single statement. */
async function issueHistoryCommand(webview: WebviewElement, direction: 'back' | 'forward' | 'reload', signal: AbortSignal): Promise<void> {
  if (direction === 'back') webview.goBack()
  else if (direction === 'forward') webview.goForward()
  else webview.reload()
  await delay(200, signal)
}

async function runRead(action: Extract<PageAction, { kind: 'read' }>, ctx: ActionContext): Promise<BrowserOutcomeData> {
  const options: Record<string, unknown> = {
    mode: action.mode,
    cursor: action.cursor ?? 0,
    limit: action.limit ?? ctx.limits.maxReadChars,
  }
  if (action.target !== undefined) options.target = action.target
  const read = await callAgent<PageAgentRead>(ctx.webview, agentCall('read', options), false)
  return { read }
}

async function runScreenshot(action: Extract<PageAction, { kind: 'screenshot' }>, ctx: ActionContext, signal: AbortSignal): Promise<BrowserOutcomeData> {
  if (isGuestVisible(ctx.webview) && ctx.webview.clientWidth > 0) return await captureScreenshot(action, ctx, signal)
  // A hidden Sidebar body leaves its guest without a compositor surface, so the
  // capture is taken while the page is laid out off-window instead.
  const size = guestCaptureSize(ctx.webview, {
    width: ctx.limits.backgroundCaptureWidth,
    height: ctx.limits.backgroundCaptureHeight,
  })
  return await withPaintedGuest(
    ctx.webview,
    size,
    async () => {
      const frame = await captureRaw(ctx.webview, undefined, signal)
      return frame.getSize()
    },
    async () => await captureScreenshot(action, ctx, signal),
  )
}

/**
 * Take one raw capture, bounded by the command's deadline.
 *
 * Electron never settles a capture for a guest without a compositor surface, so
 * the bound is what keeps a stalled page from blocking every later command.
 * @param webview - the mounted webview.
 * @param rect - the rectangle to capture, or undefined for the whole viewport.
 * @param signal - the command's deadline.
 * @returns the native capture.
 */
async function captureRaw(webview: WebviewElement, rect: BrowserRect | undefined, signal: AbortSignal): Promise<WebviewNativeImage> {
  const pending = rect === undefined
    ? webview.capturePage()
    : webview.capturePage({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  return await withDeadline(
    pending,
    signal,
    'browser/screenshot-failed',
    'the page produced no capturable frame before the deadline',
  )
}

/**
 * Capture one page: the whole document, one element, or the viewport.
 * @param action - the screenshot the model asked for.
 * @param ctx - the mounted webview and its limits.
 * @param signal - the command's cancellation.
 * @returns the encoded capture.
 */
async function captureScreenshot(action: Extract<PageAction, { kind: 'screenshot' }>, ctx: ActionContext, signal: AbortSignal): Promise<BrowserOutcomeData> {
  if (action.fullPage === true) return { image: await captureFullPage(ctx, signal) }
  if (action.target !== undefined) {
    await callAgent<PageAgentElementInfo>(ctx.webview, agentCall('scrollIntoView', action.target), true)
    await delay(120, signal)
    const resolved = await callAgent<PageAgentElementInfo>(ctx.webview, agentCall('resolve', action.target), false)
    return { image: await captureViewport(ctx.webview, clampRect(ctx.webview, resolved.rect), signal) }
  }
  return { image: await captureViewport(ctx.webview, undefined, signal) }
}

async function runClick(action: Extract<PageAction, { kind: 'click' }>, ctx: ActionContext): Promise<BrowserOutcomeData> {
  const info = await callAgent<PageAgentElementInfo>(ctx.webview, agentCall('scrollIntoView', action.target), true)
  const button = action.button ?? 'left'
  const clickCount = action.clickCount ?? 1
  const modifiers = action.modifiers ?? []
  const point = centreOf(ctx.webview, info.rect)
  try {
    await sendClick(ctx.webview, point, button, clickCount, modifiers)
  } catch (error) {
    // Desktop input injection is unavailable for this guest; page events are the documented fallback.
    console.warn('dsh-browser: falling back to page events for click', error)
    await callAgent(ctx.webview, agentCall('clickSynthetic', action.target, { button, clickCount, modifiers: [...modifiers] }), true)
  }
  return { target: info }
}

/** One click as a single injected-input statement. */
async function sendClick(webview: WebviewElement, point: { x: number; y: number }, button: BrowserMouseButton, clickCount: number, modifiers: readonly BrowserModifier[]): Promise<void> {
  const event = { x: point.x, y: point.y, button, clickCount, modifiers: electronModifiers(modifiers) }
  await webview.sendInputEvent({ type: 'mouseDown', ...event })
  await webview.sendInputEvent({ type: 'mouseUp', ...event })
}

async function runType(action: Extract<PageAction, { kind: 'type' }>, ctx: ActionContext): Promise<BrowserOutcomeData> {
  const method = action.mode === 'type' ? 'typeText' : 'fill'
  const target = action.target ?? null
  const info = await callAgent<PageAgentElementInfo | undefined>(ctx.webview, agentCall(method, target, action.text, action.submit === true), true)
  return info === undefined ? {} : { target: info }
}

async function runHover(action: Extract<PageAction, { kind: 'hover' }>, ctx: ActionContext, signal: AbortSignal): Promise<BrowserOutcomeData> {
  const info = await callAgent<PageAgentElementInfo>(ctx.webview, agentCall('scrollIntoView', action.target), true)
  const point = centreOf(ctx.webview, info.rect)
  await ctx.webview.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  // The guest dispatches enter/leave from the compositor, so the next observation
  // would otherwise race the handler.
  await delay(120, signal)
  return { target: info }
}

async function runDrag(action: Extract<PageAction, { kind: 'drag' }>, ctx: ActionContext): Promise<BrowserOutcomeData> {
  // Chromium's native drag session swallows the mouse stream before the drop
  // target sees dragover/drop, so the drag is delivered as the DOM drag events
  // page drop handlers actually listen for.
  const dragged = await callAgent<{ source: PageAgentElementInfo; target: PageAgentElementInfo }>(
    ctx.webview,
    agentCall('dragSynthetic', action.source, action.target),
    true,
  )
  return { source: dragged.source, target: dragged.target }
}

async function runDialog(action: Extract<PageAction, { kind: 'dialog' }>, ctx: ActionContext): Promise<BrowserOutcomeData> {
  const dialog = await callAgent<PageAgentDialog>(ctx.webview, agentCall('handleDialog', action.dialogId, action.accept, action.promptText ?? ''), true)
  ctx.dialogs.settle(action.dialogId)
  return { dialog: { ...dialog, handled: action.accept ? 'accepted' : 'dismissed' } }
}

/**
 * Capture the guest viewport, or one rectangle of it.
 *
 * The capture is converted through `toDataURL` alone: it is the one conversion
 * that returns plain text, so no native image object reaches the rest of the
 * pipeline. Whole-document capture is deliberately absent; the tile stitching
 * it needs would run inside the application renderer.
 * @param webview - the mounted webview.
 * @param rect - the rectangle to capture, or undefined for the whole viewport.
 * @returns the encoded capture.
 */
async function captureViewport(webview: WebviewElement, rect: BrowserRect | undefined, signal: AbortSignal): Promise<BrowserImageResult> {
  const image = await captureRaw(webview, rect, signal)
  const width = rect === undefined ? Math.max(1, webview.clientWidth) : Math.max(1, Math.round(rect.width))
  const height = rect === undefined ? Math.max(1, webview.clientHeight) : Math.max(1, Math.round(rect.height))
  const captured = dataUrlOf(image)
  let flattened = captured
  try {
    flattened = await callAgent<string>(webview, agentCall('flatten', captured, width, height), false)
  } catch (error) {
    // A document with no usable canvas keeps its own capture: a transparent
    // background is then the page's own rendering, not a failure to report.
    if (!(error instanceof BrowserActionError)) throw error
  }
  return decodeCapture(flattened, width, height)
}

/**
 * Capture the whole scrollable document by scrolling it in viewport steps.
 *
 * Each step is an ordinary viewport capture. The tiles are stitched inside the
 * visited document, not here: canvas work in the application renderer is what
 * took the whole application down once already.
 * @param ctx - the mounted webview and its limits.
 * @param signal - the command's cancellation.
 * @returns the stitched capture.
 */
async function captureFullPage(ctx: ActionContext, signal: AbortSignal): Promise<BrowserImageResult> {
  const metrics = await callAgent<PageAgentMetrics>(ctx.webview, agentCall('metrics'), false)
  const viewportWidth = Math.max(1, metrics.viewportWidth)
  const viewportHeight = Math.max(1, metrics.viewportHeight)
  const tiles = Math.max(1, Math.ceil(metrics.scrollHeight / viewportHeight))
  if (tiles > ctx.limits.maxFullPageTiles) {
    throw new BrowserActionError(
      'browser/screenshot-too-tall',
      'the document needs ' + String(tiles) + ' viewport captures, above the configured maxFullPageTiles of ' + String(ctx.limits.maxFullPageTiles),
    )
  }
  const captured: string[] = []
  try {
    for (let index = 0; index < tiles; index += 1) {
      // The last step stops at the document end so it cannot repeat the tile above it.
      const offset = Math.min(index * viewportHeight, Math.max(0, metrics.scrollHeight - viewportHeight))
      await callAgent(ctx.webview, agentCall('scrollTo', 0, offset), false)
      await delay(140, signal)
      captured.push(dataUrlOf(await captureRaw(ctx.webview, undefined, signal)))
    }
  } finally {
    await restoreScroll(ctx.webview, metrics)
  }
  const composed = await callAgent<string>(
    ctx.webview,
    agentCall('composeTiles', captured, viewportWidth, metrics.scrollHeight, viewportHeight),
    false,
  )
  return decodeCapture(composed, viewportWidth, metrics.scrollHeight)
}

/** Restore the reader's scroll position; a failure here must not mask the capture outcome. */
async function restoreScroll(webview: WebviewElement, metrics: PageAgentMetrics): Promise<void> {
  try {
    await callAgent(webview, agentCall('scrollTo', metrics.scrollX, metrics.scrollY), false)
  } catch (error) {
    console.warn('dsh-browser: could not restore the scroll position after a whole-document capture', error)
  }
}

/** Read the data URL one capture produced. */
function dataUrlOf(image: { toDataURL(): string }): string {
  const dataUrl = image.toDataURL()
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new BrowserActionError('browser/screenshot-failed', 'the renderer returned no image data URL for the capture')
  }
  return dataUrl
}

/** Decode one image data URL into the wire result. */
function decodeCapture(dataUrl: string, width: number, height: number): BrowserImageResult {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new BrowserActionError('browser/screenshot-failed', 'the renderer returned a malformed image data URL')
  const header = dataUrl.slice(0, comma)
  return {
    mediaType: header.includes('image/png') ? 'image/png' : 'image/jpeg',
    width,
    height,
    dataBase64: dataUrl.slice(comma + 1),
  }
}

/** Centre of one element in guest viewport coordinates, clamped to the visible area. */
function centreOf(webview: WebviewElement, rect: BrowserRect): { x: number; y: number } {
  const clamped = clampRect(webview, rect)
  return { x: Math.round(clamped.x + clamped.width / 2), y: Math.round(clamped.y + clamped.height / 2) }
}

/** Clamp a rectangle to the guest viewport. */
function clampRect(webview: WebviewElement, rect: BrowserRect): BrowserRect {
  const width = Math.max(0, webview.clientWidth)
  const height = Math.max(0, webview.clientHeight)
  const x = Math.min(Math.max(0, rect.x), Math.max(0, width - 1))
  const y = Math.min(Math.max(0, rect.y), Math.max(0, height - 1))
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.width, width - x)),
    height: Math.max(1, Math.min(rect.height, height - y)),
  }
}

/** Electron modifier names for the model-facing modifier vocabulary. */
function electronModifiers(modifiers: readonly BrowserModifier[]): string[] {
  const mapped: string[] = []
  for (const modifier of modifiers) {
    if (modifier === 'Alt') mapped.push('alt')
    else if (modifier === 'Control') mapped.push('control')
    else if (modifier === 'Meta') mapped.push('meta')
    else mapped.push('shift')
  }
  return mapped
}