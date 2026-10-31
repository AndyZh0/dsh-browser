/** Reveal a hidden Browser guest for the duration of one capture. */

import { BrowserActionError } from './agent-call.ts'
import { withDeadline } from './deadline.ts'
import { WEBVIEW_SELECTOR, type WebviewElement } from './webview.ts'

/** Marks the Sidebar root the reveal rules apply to. */
const REVEAL_ATTRIBUTE = 'data-dsh-browser-reveal'
/** Marks the guest's parent, which carries the faint placement. */
const HOST_ATTRIBUTE = 'data-dsh-browser-reveal-host'
/** Identifies the injected stylesheet. */
const STYLE_ID = 'dsh-browser-reveal-style'
/** The platform's own Session scoping marker on a Sidebar root. */
const SESSION_ROOT_SELECTOR = '[data-sidebar-right-session]'
/** Milliseconds to let a guest lay out and produce a frame before probing it. */
const SETTLE_MS = 150
/** Milliseconds a probe waits for one frame before the next placement is tried. */
const PROBE_MS = 3_000

/** One laid-out size. */
export interface GuestSize {
  readonly width: number
  readonly height: number
}

/** The frame one probe produced. */
export interface ProbeFrame {
  readonly width: number
  readonly height: number
}

/**
 * One way to make a hidden guest paintable.
 *
 * Chromium produces no frame for a guest it considers occluded, so every
 * placement keeps the guest geometrically on screen; they differ only in how
 * little of it the reader sees. Fading the guest itself makes Electron stop
 * compositing the view, which is why the faint placement fades its parent.
 */
interface Placement {
  /** Short name used in diagnostics and in the winning-placement memory. */
  readonly name: string
  /** Declarations for the guest element. */
  readonly guest?: string
  /** Declarations for the guest's parent element. */
  readonly host?: string
}

/**
 * Placements in the order they are tried, from least to most noticeable.
 *
 * \`behind\` only sinks the guest below the content of its own stacking context, so
 * it still shows wherever the application has no opaque cover; it therefore ranks
 * below the two placements that keep the guest nearly invisible by construction.
 */
const PLACEMENTS: readonly Placement[] = [
  {
    // Layout stays the guest's own size, so the capture keeps its full
    // dimensions; only a single pixel of the result is ever drawn, and that
    // pixel is nearly transparent. The probe rejects the placement if the clip
    // reaches the captured frame as well.
    name: 'clipped',
    host: '  opacity: 0.02 !important;',
    guest: '  clip-path: inset(0 0 calc(100% - 1px) calc(100% - 1px)) !important;',
  },
  { name: 'faint', host: '  opacity: 0.01 !important;' },
  { name: 'sliver', guest: '  left: calc(100vw - 1px) !important;\n  right: auto !important;' },
  { name: 'behind', guest: '  z-index: -1 !important;' },
  { name: 'visible' },
]

/** Last size each guest had on screen, so a background capture keeps the page's layout. */
const observedSizes = new WeakMap<WebviewElement, GuestSize>()
/** Guests currently revealed; one guest must not be revealed twice at once. */
const revealed = new WeakSet<WebviewElement>()
/** The placement that last produced a frame, tried first for the same guest. */
const preferred = new WeakMap<WebviewElement, string>()

/**
 * Name the nearest ancestor that keeps the guest out of layout.
 * @param element - the mounted webview.
 * @returns the ancestor's tag with its hiding marker, or 'nothing'.
 */
function hiddenBy(element: WebviewElement): string {
  const hidden = element.closest('[hidden], [aria-hidden="true"]')
  if (hidden === null) return 'nothing'
  return hidden.tagName.toLowerCase()
    + (hidden.hasAttribute('hidden') ? '[hidden]' : '')
    + (hidden.getAttribute('aria-hidden') === 'true' ? '[aria-hidden]' : '')
}

/**
 * Make every hidden ancestor of the guest render again.
 *
 * A Session that is not on screen can sit under a collapsed column, and an
 * ancestor with \`display: none\` keeps every descendant out of layout however the
 * guest itself is styled. Each change is inline and reverted, so the Sidebar
 * returns to exactly the state the platform left it in.
 * @param element - the mounted webview.
 * @returns the revert for every ancestor that was lifted.
 */
function liftHiddenAncestors(element: WebviewElement): Array<() => void> {
  const undo: Array<() => void> = []
  let node: HTMLElement | null = element.parentElement
  while (node !== null && node !== document.body) {
    const lifted = node
    if (lifted.hasAttribute('hidden') || window.getComputedStyle(lifted).display === 'none') {
      const previous = lifted.style.getPropertyValue('display')
      const priority = lifted.style.getPropertyPriority('display')
      lifted.style.setProperty('display', 'contents', 'important')
      undo.push(() => {
        lifted.style.removeProperty('display')
        if (previous !== '') lifted.style.setProperty('display', previous, priority)
      })
    }
    node = node.parentElement
  }
  return undo
}

/** Wait one bounded interval without a cancellation signal. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Record the size a guest currently occupies on screen.
 *
 * A hidden guest reports zero, so this only stores a size the page was actually
 * laid out at; a later background capture reuses it and the page does not reflow.
 * @param element - the mounted webview.
 */
export function rememberGuestSize(element: WebviewElement): void {
  const width = element.clientWidth
  const height = element.clientHeight
  if (width > 0 && height > 0) observedSizes.set(element, { width, height })
}

/**
 * The size a hidden guest should be laid out at for a capture.
 * @param element - the mounted webview.
 * @param fallback - the configured size, used when the page was never on screen.
 * @returns the last observed size, or the fallback.
 */
export function guestCaptureSize(element: WebviewElement, fallback: GuestSize): GuestSize {
  return observedSizes.get(element) ?? fallback
}

/**
 * The reveal rules: undo the hiding layers and lay the guest out on screen.
 *
 * The guest must keep its place in the document — removing a webview element
 * destroys its guest — so the rules override the platform's hiding instead of
 * moving anything.
 * @param placement - the placement under test.
 * @param size - the size to lay the guest out at.
 * @returns the stylesheet text.
 */
function revealCss(placement: Placement, size: GuestSize): string {
  const root = '[' + REVEAL_ATTRIBUTE + ']'
  const rules = [
    root + ' { display: contents !important; }',
    root + ' [hidden] { display: block !important; }',
    // The guest carries its own fixed box. A Session that is not on screen has
    // every Sidebar column collapsed to zero, and a fixed element does not
    // inherit that size the way an in-flow child would.
    root + ' ' + WEBVIEW_SELECTOR + ' {'
    + '\n  position: fixed !important;'
    + '\n  top: 0 !important;'
    + '\n  right: 0 !important;'
    + '\n  display: flex !important;'
    + '\n  width: ' + String(size.width) + 'px !important;'
    + '\n  height: ' + String(size.height) + 'px !important;'
    + '\n  visibility: visible !important;'
    + (placement.guest ?? '')
    + '\n}',
  ]
  if (placement.host !== undefined) rules.push('[' + HOST_ATTRIBUTE + '] {' + placement.host + '\n}')
  return rules.join('\n')
}

/**
 * The placements to try for one guest, starting with the one that last worked.
 * @param element - the mounted webview.
 * @returns the placements in attempt order.
 */
function placementsFor(element: WebviewElement): readonly Placement[] {
  const winner = preferred.get(element)
  if (winner === undefined) return PLACEMENTS
  const first = PLACEMENTS.find(placement => placement.name === winner)
  if (first === undefined) return PLACEMENTS
  return [first, ...PLACEMENTS.filter(placement => placement !== first)]
}

/**
 * Reveal one hidden guest, capture it, and always put the Sidebar back.
 *
 * Each placement is probed with one throwaway capture: a guest Chromium does not
 * consider visible never settles its capture, so the probe is what distinguishes
 * a placement that works from one that would stall the command.
 * @param element - the mounted webview.
 * @param size - the size to lay the hidden guest out at.
 * @param probe - one throwaway capture used to test the placement; it reports the
 *   frame's size, so a placement that clips the capture itself is rejected.
 * @param run - the capture to perform once a placement produced a frame.
 * @returns whatever the real capture produced.
 * @throws BrowserActionError when the page is gone, another capture owns it, or no placement worked.
 */
export async function withPaintedGuest<T>(
  element: WebviewElement,
  size: GuestSize,
  probe: () => Promise<ProbeFrame>,
  run: () => Promise<T>,
): Promise<T> {
  if (!element.isConnected) {
    throw new BrowserActionError('browser/page-not-visible', 'the page is no longer in the document, so it has nothing to capture')
  }
  const root = element.closest(SESSION_ROOT_SELECTOR)
  if (root === null) return await run()
  if (revealed.has(element)) {
    throw new BrowserActionError('browser/capture-busy', 'another capture is already revealing this page')
  }
  const host = element.parentElement
  revealed.add(element)
  root.setAttribute(REVEAL_ATTRIBUTE, '')
  host?.setAttribute(HOST_ATTRIBUTE, '')
  const style = document.createElement('style')
  style.id = STYLE_ID
  document.head.append(style)
  const lifted = liftHiddenAncestors(element)
  const failures: string[] = []
  try {
    for (const placement of placementsFor(element)) {
      style.textContent = revealCss(placement, size)
      await pause(SETTLE_MS)
      let frame: ProbeFrame
      try {
        frame = await withDeadline(probe(), AbortSignal.timeout(PROBE_MS), 'browser/page-not-visible', placement.name + ' produced no frame')
      } catch (error) {
        // The laid-out box is what distinguishes a placement that missed its
        // element from a laid-out guest Chromium still refuses to capture.
        failures.push(placement.name + ' ' + String(element.clientWidth) + 'x' + String(element.clientHeight))
        continue
      }
      if (frame.width < size.width || frame.height < size.height) {
        failures.push(placement.name + ' framed ' + String(frame.width) + 'x' + String(frame.height))
        continue
      }
      preferred.set(element, placement.name)
      // Only the probe selects a placement; a failure of the real capture is the
      // caller's answer and must not be retried under another placement.
      return await run()
    }
    throw new BrowserActionError(
      'browser/page-not-visible',
      'no placement produced a capturable frame for this page (boxes: ' + failures.join('; ') + '; hidden by ' + hiddenBy(element) + ')',
    )
  } finally {
    style.remove()
    root.removeAttribute(REVEAL_ATTRIBUTE)
    host?.removeAttribute(HOST_ATTRIBUTE)
    for (const revert of lifted) revert()
    revealed.delete(element)
    await pause(SETTLE_MS)
  }
}
