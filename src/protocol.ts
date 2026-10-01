/** Shared wire vocabulary between the browser Host session and its Client controller. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Shared Connection API channel carrying browser traffic. */
export const BROWSER_API_CHANNEL = '/api'
/** Endpoint prefix this plugin owns below the shared channel. */
export const BROWSER_ENDPOINT_PREFIX = 'dsh-browser'
/** Client registration endpoint. */
export const BROWSER_HELLO_ENDPOINT = BROWSER_ENDPOINT_PREFIX + '/hello'
/** Client long-poll endpoint that claims the next pending command. */
export const BROWSER_POLL_ENDPOINT = BROWSER_ENDPOINT_PREFIX + '/poll'
/** Client endpoint that settles one claimed command. */
export const BROWSER_RESULT_ENDPOINT = BROWSER_ENDPOINT_PREFIX + '/result'
/** Absolute Fetch route registering one polling renderer. */
export const BROWSER_HELLO_PATH = BROWSER_API_CHANNEL + '/' + BROWSER_HELLO_ENDPOINT
/** Absolute Fetch route that claims the next pending command. */
export const BROWSER_POLL_PATH = BROWSER_API_CHANNEL + '/' + BROWSER_POLL_ENDPOINT
/** Absolute Fetch route that settles one claimed command. */
export const BROWSER_RESULT_PATH = BROWSER_API_CHANNEL + '/' + BROWSER_RESULT_ENDPOINT

/** Opaque command identity minted by the Host. */
export type BrowserCommandId = string

/** Viewport-space rectangle in guest CSS pixels. */
export interface BrowserRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** How the model names one element. */
export interface BrowserTarget {
  /** CSS selector; exclusive with `role`/`name`. */
  readonly selector?: string
  /** ARIA or implicit role. */
  readonly role?: string
  /** Accessible name; matched exactly when `exact`, else by substring. */
  readonly name?: string
  /** Require an exact accessible-name match. */
  readonly exact?: boolean
  /** Selector chain of same-origin iframes to descend before resolving. */
  readonly frames?: readonly string[]
}

/** Resolved element facts returned to the model. */
export interface BrowserElementInfo {
  readonly tag: string
  readonly role: string
  readonly name: string
  readonly selector: string
  readonly rect: BrowserRect
}

/** One visible Browser tab's observable state. */
export interface BrowserPageState {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly error?: string
}

/** One captured page dialog awaiting a decision. */
export interface BrowserPendingDialog {
  readonly id: string
  readonly type: 'alert' | 'confirm' | 'prompt'
  readonly message: string
  readonly defaultValue?: string
}

/** Keyboard modifier accepted by pointer operations. */
export type BrowserModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'
/** Mouse button accepted by pointer operations. */
export type BrowserMouseButton = 'left' | 'middle' | 'right'
/** Page-reading projection. */
export type BrowserReadMode = 'aria' | 'text'
/** Navigation direction. */
export type BrowserNavigateDirection = 'goto' | 'back' | 'forward' | 'reload'
/** Load milestone a navigation waits for. */
export type BrowserWaitUntil = 'commit' | 'domcontentloaded' | 'load'
/** How text enters a field. */
export type BrowserInputMode = 'fill' | 'type'

/** One operation the Client performs against the built-in Browser tab. */
export type BrowserAction =
  | { readonly kind: 'open'; readonly url?: string }
  | {
    readonly kind: 'navigate'
    readonly direction: BrowserNavigateDirection
    readonly url?: string
    readonly waitUntil?: BrowserWaitUntil
  }
  | {
    readonly kind: 'read'
    readonly mode: BrowserReadMode
    readonly cursor?: number
    readonly limit?: number
    readonly target?: BrowserTarget
  }
  | { readonly kind: 'screenshot'; readonly target?: BrowserTarget; readonly fullPage?: boolean }
  | {
    readonly kind: 'click'
    readonly target: BrowserTarget
    readonly button?: BrowserMouseButton
    readonly clickCount?: number
    readonly modifiers?: readonly BrowserModifier[]
  }
  | {
    readonly kind: 'type'
    readonly target?: BrowserTarget
    readonly text: string
    readonly mode?: BrowserInputMode
    readonly submit?: boolean
  }
  | { readonly kind: 'hover'; readonly target: BrowserTarget }
  | { readonly kind: 'drag'; readonly source: BrowserTarget; readonly target: BrowserTarget }
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'dialog'; readonly dialogId: string; readonly accept: boolean; readonly promptText?: string }

/** Deployment limits the Client applies while performing one command. */
export interface BrowserCommandLimits {
  /** How long the model-control ring stays lit after the last operation. */
  readonly lingerMs: number
  /** Default character budget for one page read. */
  readonly maxReadChars: number
  /** Character budget for one managed-script rendering. */
  readonly maxOutputChars: number
  /** Deadline for one managed script, mirrored to the script's own timeout. */
  readonly codeTimeoutMs: number
  /** Maximum viewport tiles one whole-document capture may scroll and stitch. */
  readonly maxFullPageTiles: number
}

/** One Host-issued command claimed by a Client poll. */
export interface BrowserCommand {
  readonly commandId: BrowserCommandId
  readonly sessionId: string
  readonly action: BrowserAction
  readonly limits: BrowserCommandLimits
}

/** Bounded page text produced by a read action. */
export interface BrowserReadResult {
  readonly mode: BrowserReadMode
  readonly content: string
  readonly cursor: number
  readonly nextCursor?: number
  readonly truncated: boolean
}

/** One encoded screenshot produced by a screenshot action. */
export interface BrowserImageResult {
  readonly mediaType: 'image/jpeg' | 'image/png'
  readonly width: number
  readonly height: number
  readonly dataBase64: string
}

/** Managed-script output produced by a code action. */
export interface BrowserScriptResult {
  readonly result: JsonValue
  readonly logs: readonly string[]
}

/** Action-specific facts the Client returns beside the page state. */
export interface BrowserOutcomeData {
  readonly target?: BrowserElementInfo
  readonly source?: BrowserElementInfo
  readonly read?: BrowserReadResult
  readonly image?: BrowserImageResult
  readonly script?: BrowserScriptResult
  readonly dialog?: BrowserPendingDialog & { readonly handled?: 'accepted' | 'dismissed' }
}

/** Successful command settlement. */
export interface BrowserOutcome {
  readonly page: BrowserPageState
  readonly pages: readonly BrowserPageState[]
  readonly dialogPending?: BrowserPendingDialog
  readonly data?: BrowserOutcomeData
}

/** Failure identity carried back to the awaiting tool call. */
export interface BrowserFailure {
  readonly code: string
  readonly message: string
}

/** One Client settlement posted to the Host. */
export type BrowserResultPayload =
  | { readonly commandId: BrowserCommandId; readonly ok: true; readonly outcome: BrowserOutcome }
  | { readonly commandId: BrowserCommandId; readonly ok: false; readonly error: BrowserFailure }

/** Client registration payload. */
export interface BrowserHelloPayload {
  /** Whether this renderer exposes the Desktop browser bridge. */
  readonly desktop: boolean
}

/** Client poll payload. */
export interface BrowserPollPayload {
  /** Stable identity of the polling renderer, used only for diagnostics. */
  readonly clientId: string
}

/** Client poll response. */
export type BrowserPollResponse =
  | { readonly command: BrowserCommand }
  | { readonly idle: true }