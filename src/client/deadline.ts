/** Bound one pending operation so a stuck native call cannot stall the command loop. */

import { BrowserActionError } from './agent-call.ts'

/**
 * Race one pending operation against a deadline signal.
 *
 * Electron's capture never settles for a guest without a compositor surface, so
 * an unbounded await would leave the Client executing that command forever and
 * every later command unclaimed.
 * @param pending - the operation already dispatched.
 * @param signal - the deadline to race against.
 * @param code - failure code reported when the deadline wins.
 * @param message - failure description reported when the deadline wins.
 * @returns whatever the operation produced.
 * @throws BrowserActionError when the deadline fires first.
 */
export async function withDeadline<T>(pending: Promise<T>, signal: AbortSignal, code: string, message: string): Promise<T> {
  if (signal.aborted) throw new BrowserActionError(code, message)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(new BrowserActionError(code, message)) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    // The abandoned operation may still settle; nothing awaits it any more.
    void pending.catch(() => undefined)
  }
}
