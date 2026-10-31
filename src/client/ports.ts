/**
 * Structural views of the public services this independent plugin consumes.
 *
 * The Sidebar face is declared here rather than imported from its package so
 * this plugin carries no type dependency on another plugin's React surface.
 */

/** One open Sidebar tab, as the Sidebar's inventory reports it. */
export interface BrowserTabRecord {
  /** The Session the tab belongs to. */
  readonly sessionId: string
  /** The tab's own identity, which is also the page id the model sees. */
  readonly tabId: string
  /** The tab type's kind. */
  readonly kind: string
}

/** The right-Sidebar operations the browser controller needs. */
export interface BrowserSidebarRight {
  /**
   * Open a Browser page in the session on screen.
   * @param kind - page kind; this plugin only opens the built-in browser.
   * @param options - the browser page's own parameters.
   */
  openTab(kind: 'browser', options?: { readonly params?: { readonly url?: string } }): void
  /**
   * Open a Browser page in one named session.
   *
   * Not part of the Sidebar's public face: placing a tab in a session that is
   * not on screen has no public path, and a browser tool call must reach the
   * session that issued it. Nothing happens for a session whose store was never
   * adopted, which is why the controller reports that case by name.
   * @param sessionId - the session that should receive the page.
   * @param kind - page kind; this plugin only opens the built-in browser.
   * @param options - the browser page's own parameters.
   */
  openTabIn(sessionId: string, kind: 'browser', options?: { readonly params?: { readonly url?: string } }): void
  /**
   * Close a tab of one named session.
   *
   * Not part of the Sidebar's public face: the Tab domain's path, and like
   * `openTabIn` it does nothing for a session whose store was never adopted.
   * @param sessionId - the session that owns the tab.
   * @param tabId - the tab to close.
   */
  closeIn(sessionId: string, tabId: string): void
  /**
   * Focus a tab and the pane holding it.
   *
   * Resolves against the session on screen, so it is only meaningful while the
   * issuing session is the one the reader is looking at.
   * @param tabId - the tab to bring forward.
   */
  focus(tabId: string): void
  /** Observable inventory of open tabs across saved and adopted sessions. */
  readonly openTabs: { getSnapshot(): readonly BrowserTabRecord[] }
  /** The Session on screen, or undefined while none is. */
  readonly mounted: { getSnapshot(): string | undefined }
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
     * @param channel - absolute logical channel such as /api.
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
