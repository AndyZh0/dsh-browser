/** Remembers the dialog the page raised and the answer policy the model chose. */

import type { PageAgentDialog } from './page-agent.ts'
import type { BrowserPendingDialog } from '../protocol.ts'

/** One dialog awaiting a model decision, with the policy that already answered it. */
export class DialogTracker {
  private pending: BrowserPendingDialog | undefined

  /**
   * Record dialogs the page raised since the last drain.
   * @param dialogs - dialogs reported by the page agent.
   * @returns the newest pending dialog, when one exists.
   */
  record(dialogs: readonly PageAgentDialog[]): BrowserPendingDialog | undefined {
    for (const dialog of dialogs) {
      this.pending = dialog.defaultValue === undefined
        ? { id: dialog.id, type: dialog.type, message: dialog.message }
        : { id: dialog.id, type: dialog.type, message: dialog.message, defaultValue: dialog.defaultValue }
    }
    return this.pending
  }

  /** @returns the dialog the model still has to decide, if any. */
  get pendingDialog(): BrowserPendingDialog | undefined {
    return this.pending
  }

  /** @param dialogId - the dialog the model decided. @returns the settled dialog, when it was pending. */
  settle(dialogId: string): BrowserPendingDialog | undefined {
    if (this.pending === undefined || this.pending.id !== dialogId) return undefined
    const settled = this.pending
    this.pending = undefined
    return settled
  }

  /** Forget any pending dialog, as a new document does. */
  reset(): void {
    this.pending = undefined
  }
}