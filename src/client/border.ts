/** Blue animated ring drawn over the Browser tab the model is currently driving. */

const STYLE_ID = 'dsh-browser-model-control-style'
const RING_CLASS = 'dsh-browser-model-control-ring'
const RING_Z_INDEX = '2147483000'

const STYLE_TEXT = [
  '.' + RING_CLASS + ' {',
  '  position: absolute;',
  '  pointer-events: none;',
  '  z-index: ' + RING_Z_INDEX + ';',
  '  border-radius: 3px;',
  '  box-shadow: inset 0 0 0 2px rgba(76, 141, 255, 0.55), 0 0 0 0 rgba(76, 141, 255, 0);',
  '  animation: dsh-browser-model-pulse 1.6s ease-in-out infinite;',
  '}',
  '@keyframes dsh-browser-model-pulse {',
  '  0%, 100% { box-shadow: inset 0 0 0 2px rgba(76, 141, 255, 0.55), 0 0 0 0 rgba(76, 141, 255, 0); }',
  '  50% { box-shadow: inset 0 0 0 3px rgba(76, 141, 255, 1), 0 0 14px 2px rgba(76, 141, 255, 0.45); }',
  '}',
  '@media (prefers-reduced-motion: reduce) {',
  '  .' + RING_CLASS + ' { animation: none; box-shadow: inset 0 0 0 2px rgba(76, 141, 255, 0.95); }',
  '}',
].join('\n')

/**
 * Owns one ring element and its lifetime.
 *
 * The ring is a sibling overlay of the webview inside the Sidebar's content
 * container, so it never enters the visited document.
 */
export class ModelControlBorder {
  private ring: HTMLDivElement | undefined
  private host: HTMLElement | undefined
  private target: HTMLElement | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private observer: ResizeObserver | undefined
  private hostPosition: string | undefined
  private readonly onLayout = (): void => { this.sync() }

  /**
   * Light the ring over one webview and keep it lit for the linger window.
   * @param target - the webview element the model is driving.
   * @param lingerMs - how long the ring stays lit after the last operation.
   */
  show(target: HTMLElement, lingerMs: number): void {
    this.ensureStyle()
    if (this.target !== target) this.attach(target)
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.hide() }, Math.max(1, lingerMs))
  }

  /** Remove the ring and release every listener it owns. */
  hide(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.observer?.disconnect()
    this.observer = undefined
    this.ring?.remove()
    this.ring = undefined
    if (this.host !== undefined && this.hostPosition !== undefined) {
      this.host.style.position = this.hostPosition
      this.hostPosition = undefined
    }
    this.host = undefined
    this.target = undefined
    window.removeEventListener('resize', this.onLayout)
    window.removeEventListener('scroll', this.onLayout, true)
  }

  /** Remove the ring and its stylesheet. */
  dispose(): void {
    this.hide()
    document.getElementById(STYLE_ID)?.remove()
  }

  private attach(target: HTMLElement): void {
    this.hide()
    const host = target.parentElement
    if (host === null) return
    const computed = window.getComputedStyle(host).position
    if (computed === 'static') {
      this.hostPosition = host.style.position
      host.style.position = 'relative'
    }
    const ring = document.createElement('div')
    ring.className = RING_CLASS
    ring.setAttribute('aria-hidden', 'true')
    host.append(ring)
    this.host = host
    this.target = target
    this.ring = ring
    this.observer = new ResizeObserver(() => { this.sync() })
    this.observer.observe(target)
    this.observer.observe(host)
    window.addEventListener('resize', this.onLayout)
    window.addEventListener('scroll', this.onLayout, true)
    this.sync()
  }

  private sync(): void {
    const ring = this.ring
    const host = this.host
    const target = this.target
    if (ring === undefined || host === undefined || target === undefined) return
    if (!target.isConnected || !host.isConnected) {
      this.hide()
      return
    }
    const hostRect = host.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    ring.style.left = (targetRect.left - hostRect.left + host.scrollLeft) + 'px'
    ring.style.top = (targetRect.top - hostRect.top + host.scrollTop) + 'px'
    ring.style.width = targetRect.width + 'px'
    ring.style.height = targetRect.height + 'px'
  }

  private ensureStyle(): void {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE_TEXT
    document.head.append(style)
  }
}
