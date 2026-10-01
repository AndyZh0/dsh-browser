/**
 * Structural views of the public services this independent plugin consumes.
 *
 * The Sidebar face is declared here rather than imported from its package so
 * this plugin carries no type dependency on another plugin's React surface.
 */

/** One open right-Sidebar tab, as the controller reads it. */
export interface BrowserTabRecord {
  readonly id: string
  readonly kind: string
}

/** The right-Sidebar operations the browser controller needs. */
export interface BrowserSidebarRight {
  /**
   * The active tab of the active pane.
   * @returns the tab record, or undefined with no Session on screen.
   */
  active(): BrowserTabRecord | undefined
  /**
   * Open a Browser page and reveal the column.
   * @param kind - page kind; this plugin only opens the built-in browser.
   * @param options - placement and the browser page's own parameters.
   */
  openTab(kind: 'browser', options?: { readonly params?: { readonly url?: string } }): void
}

/** One generic Connection RPC result. */
export type BrowserRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The Connection operations the browser controller uses. */
export interface BrowserConnection {
  readonly rpc: {
    /**
     * Call one endpoint through a registered logical channel.
     * @param channel - absolute logical channel such as /dsh-browser.
     * @param endpoint - channel-relative endpoint.
     * @param payload - channel-owned request payload.
     * @param signal - caller cancellation.
     * @returns the endpoint's own success or failure result.
     */
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<BrowserRpcResult>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Right-Sidebar navigation face. */
    sidebarRight: BrowserSidebarRight
    /** Client Connection transport face. */
    connection: BrowserConnection
  }
}