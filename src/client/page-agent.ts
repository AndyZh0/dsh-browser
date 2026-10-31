/**
 * The page-side agent injected into the controlled document's main world.
 *
 * `pageAgentMain` must stay self-contained: it is serialized through
 * `Function.prototype.toString` and evaluated inside the guest, so it may
 * reference nothing but its own body and browser globals.
 */

/** Viewport-space rectangle in guest CSS pixels. */
export interface PageAgentRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Resolved element facts. */
export interface PageAgentElementInfo {
  readonly tag: string
  readonly role: string
  readonly name: string
  readonly selector: string
  readonly rect: PageAgentRect
}

/** One captured page dialog. */
export interface PageAgentDialog {
  readonly id: string
  readonly type: 'alert' | 'confirm' | 'prompt'
  readonly message: string
  readonly defaultValue?: string
}

/** Document and viewport metrics used by whole-document capture. */
export interface PageAgentMetrics {
  readonly scrollX: number
  readonly scrollY: number
  readonly scrollWidth: number
  readonly scrollHeight: number
  readonly viewportWidth: number
  readonly viewportHeight: number
}

/** Bounded page text. */
export interface PageAgentRead {
  readonly mode: 'aria' | 'text'
  readonly content: string
  readonly cursor: number
  readonly nextCursor?: number
  readonly truncated: boolean
}

/** Successful or failed page-side operation. */
export type PageAgentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Element target accepted by every page-side operation. */
export interface PageAgentTarget {
  readonly selector?: string
  readonly role?: string
  readonly name?: string
  readonly exact?: boolean
  readonly frames?: readonly string[]
}

/** The page-side agent surface the renderer calls. */
export interface DshPageAgent {
  readonly version: number
  resolve(target: PageAgentTarget): PageAgentResult<PageAgentElementInfo>
  rect(target: PageAgentTarget): PageAgentResult<PageAgentRect>
  queryAll(selector: string, limit: number): PageAgentResult<readonly PageAgentElementInfo[]>
  metrics(): PageAgentResult<PageAgentMetrics>
  scrollTo(x: number, y: number): PageAgentResult<undefined>
  composeTiles(tiles: readonly string[], width: number, height: number, tileHeight: number): Promise<PageAgentResult<string>>
  flatten(dataUrl: string, width: number, height: number): Promise<PageAgentResult<string>>
  read(options: {
    mode: 'aria' | 'text'
    cursor: number
    limit: number
    target?: PageAgentTarget
  }): PageAgentResult<PageAgentRead>
  scrollIntoView(target: PageAgentTarget): PageAgentResult<PageAgentElementInfo>
  fill(target: PageAgentTarget | null, text: string, submit: boolean): PageAgentResult<PageAgentElementInfo | undefined>
  typeText(target: PageAgentTarget | null, text: string, submit: boolean): PageAgentResult<PageAgentElementInfo | undefined>
  clickSynthetic(target: PageAgentTarget, options: { button: string; clickCount: number; modifiers: readonly string[] }): PageAgentResult<PageAgentElementInfo>
  hoverSynthetic(target: PageAgentTarget): PageAgentResult<PageAgentElementInfo>
  dragSynthetic(source: PageAgentTarget, target: PageAgentTarget): PageAgentResult<{ source: PageAgentElementInfo; target: PageAgentElementInfo }>
  submitFocused(): PageAgentResult<undefined>
  takeDialogs(): readonly PageAgentDialog[]
  setPolicy(accept: boolean, promptText: string): void
  handleDialog(dialogId: string, accept: boolean, promptText: string): PageAgentResult<PageAgentDialog>
}

declare global {
  /** Page-side agent installed by the dsh-browser renderer. */
  // eslint-disable-next-line no-var
  var __dshBrowserAgent: DshPageAgent | undefined
}

/** Source evaluated inside the guest to install the agent. */
export const PAGE_AGENT_SOURCE = '(' + pageAgentMain.toString() + ')()'

/** Version the renderer checks before trusting an already installed agent. */
export const PAGE_AGENT_VERSION = 2

/** Install the page-side agent; a second call with the same version is a no-op. */
export function pageAgentMain(): boolean {
  const VERSION = 1
  if (globalThis.__dshBrowserAgent !== undefined && globalThis.__dshBrowserAgent.version === VERSION) return true

  const MAX_OUTLINE_ELEMENTS = 4_000
  const MAX_CANVAS_WIDTH = 4_096
  const MAX_CANVAS_HEIGHT = 20_000
  const MAX_NAME_CHARS = 200
  const CANDIDATE_SELECTOR = [
    'a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'iframe', 'area',
    '[role]', '[tabindex]', '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',')

  const IMPLICIT_ROLES: Record<string, string> = {
    a: 'link', article: 'article', aside: 'complementary', button: 'button', dialog: 'dialog',
    fieldset: 'group', figure: 'figure', footer: 'contentinfo', form: 'form', h1: 'heading',
    h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', header: 'banner',
    hr: 'separator', img: 'img', input: 'textbox', li: 'listitem', main: 'main', nav: 'navigation',
    ol: 'list', option: 'option', output: 'status', progress: 'progressbar', section: 'region',
    select: 'combobox', summary: 'button', table: 'table', td: 'cell', textarea: 'textbox',
    th: 'columnheader', tr: 'row', ul: 'list',
  }

  const dialogs: PageAgentDialog[] = []
  const recorded: PageAgentDialog[] = []
  const policy = { accept: false, promptText: '' }
  let dialogCounter = 0

  /** Record one dialog for the drain queue and the retained decision window. */
  function remember(dialog: PageAgentDialog): void {
    dialogs.push(dialog)
    recorded.push(dialog)
    if (recorded.length > 50) recorded.shift()
  }

  function ok<T>(value: T): PageAgentResult<T> {
    return { ok: true, value }
  }

  function bad<T>(code: string, message: string): PageAgentResult<T> {
    return { ok: false, code, message }
  }

  function elementTag(element: Element): string {
    return element.tagName.toLowerCase()
  }

  function explicitName(element: Element): string {
    const label = element.getAttribute('aria-label')
    if (label !== null && label.trim().length > 0) return label.trim()
    const labelledby = element.getAttribute('aria-labelledby')
    if (labelledby !== null && labelledby.trim().length > 0) {
      const parts: string[] = []
      for (const id of labelledby.trim().split(/\s+/)) {
        const target = element.ownerDocument.getElementById(id)
        if (target !== null && target.textContent !== null) parts.push(target.textContent.trim())
      }
      if (parts.length > 0) return parts.join(' ')
    }
    const alt = element.getAttribute('alt')
    if (alt !== null && alt.trim().length > 0) return alt.trim()
    const title = element.getAttribute('title')
    if (title !== null && title.trim().length > 0) return title.trim()
    const placeholder = element.getAttribute('placeholder')
    if (placeholder !== null && placeholder.trim().length > 0) return placeholder.trim()
    const tag = elementTag(element)
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const id = element.getAttribute('id')
      if (id !== null && id.length > 0) {
        const label2 = element.ownerDocument.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]')
        if (label2 !== null && label2.textContent !== null && label2.textContent.trim().length > 0) return label2.textContent.trim()
      }
      const value = (element as HTMLInputElement).value
      const type = element.getAttribute('type')
      if (typeof value === 'string' && value.length > 0 && type !== 'password') return value
    }
    return ''
  }

  function roleOf(element: Element): string {
    const explicit = element.getAttribute('role')
    if (explicit !== null && explicit.trim().length > 0) return explicit.trim().split(/\s+/)[0] as string
    const tag = elementTag(element)
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'file') return 'button'
      return 'textbox'
    }
    return IMPLICIT_ROLES[tag] ?? 'generic'
  }

  function nameOf(element: Element): string {
    const explicit = explicitName(element)
    if (explicit.length > 0) return explicit.slice(0, MAX_NAME_CHARS)
    const role = roleOf(element)
    if (role === 'generic' || element.children.length > 0) return ''
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
  }

  function cssPath(element: Element): string {
    const id = element.getAttribute('id')
    if (id !== null && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) && element.ownerDocument.querySelectorAll('#' + id).length === 1) return '#' + id
    const parts: string[] = []
    let current: Element | null = element
    let depth = 0
    while (current !== null && depth < 6 && elementTag(current) !== 'html') {
      const tag = elementTag(current)
      const parent: Element | null = current.parentElement
      if (parent === null) { parts.unshift(tag); break }
      const siblings = Array.from(parent.children).filter(child => elementTag(child) === tag)
      const index = siblings.indexOf(current) + 1
      parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + String(index) + ')' : tag)
      current = parent
      depth += 1
    }
    return parts.join(' > ')
  }

  function rectOf(element: Element): PageAgentRect {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  function describe(element: Element): PageAgentElementInfo {
    return { tag: elementTag(element), role: roleOf(element), name: nameOf(element), selector: cssPath(element), rect: rectOf(element) }
  }

  function isVisible(element: Element): boolean {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = element.ownerDocument.defaultView?.getComputedStyle(element)
    if (style === undefined || style === null) return true
    return style.visibility !== 'hidden' && style.display !== 'none'
  }

  function frameDocument(frames: readonly string[] | undefined): Document {
    let doc: Document = document
    for (const selector of frames ?? []) {
      const frame = doc.querySelector(selector)
      if (frame === null || elementTag(frame) !== 'iframe') throw { code: 'browser/frame-missing', message: 'no iframe matches ' + JSON.stringify(selector) }
      const child = (frame as HTMLIFrameElement).contentDocument
      if (child === null) throw { code: 'browser/frame-cross-origin', message: 'iframe ' + JSON.stringify(selector) + ' is cross-origin and cannot be reached' }
      doc = child
    }
    return doc
  }

  function matchesName(element: Element, name: string, exact: boolean): boolean {
    const value = nameOf(element)
    if (value.length === 0) return false
    return exact ? value === name : value.includes(name)
  }

  function resolve(target: PageAgentTarget): PageAgentResult<PageAgentElementInfo> {
    let doc: Document
    try {
      doc = frameDocument(target.frames)
    } catch (error) {
      const failure = error as { code?: string; message?: string }
      return bad(failure.code ?? 'browser/frame-missing', failure.message ?? 'the requested frame is unavailable')
    }
    if (target.selector !== undefined && target.selector.length > 0) {
      let found: Element[]
      try {
        found = Array.from(doc.querySelectorAll(target.selector))
      } catch (error) {
        return bad('browser/bad-selector', 'invalid CSS selector ' + JSON.stringify(target.selector) + ': ' + String(error))
      }
      const visible = found.filter(isVisible)
      const usable = visible.length > 0 ? visible : found
      if (usable.length === 0) return bad('browser/target-missing', 'no element matches ' + JSON.stringify(target.selector))
      if (usable.length > 1 && target.exact !== true) {
        return bad('browser/target-ambiguous', String(usable.length) + ' elements match ' + JSON.stringify(target.selector) + '; candidates: ' + usable.slice(0, 5).map(cssPath).join(', '))
      }
      return ok(describe(usable[0] as Element))
    }
    const role = target.role
    const name = target.name
    if ((role === undefined || role.length === 0) && (name === undefined || name.length === 0)) {
      return bad('browser/bad-target', 'a target needs either selector or role/name')
    }
    const all = Array.from(doc.querySelectorAll(CANDIDATE_SELECTOR))
    const visible = all.filter(isVisible)
    const candidates = visible.length > 0 ? visible : all
    const byRole = role === undefined || role.length === 0 ? candidates : candidates.filter(element => roleOf(element) === role)
    let matched = name === undefined || name.length === 0 ? byRole : byRole.filter(element => matchesName(element, name, true))
    if (matched.length === 0 && name !== undefined && name.length > 0 && target.exact !== true) {
      matched = byRole.filter(element => matchesName(element, name, false))
    }
    if (matched.length === 0) {
      return bad('browser/target-missing', 'no element matches role=' + JSON.stringify(role ?? '') + ' name=' + JSON.stringify(name ?? ''))
    }
    if (matched.length > 1) {
      return bad('browser/target-ambiguous', String(matched.length) + ' elements match role=' + JSON.stringify(role ?? '') + ' name=' + JSON.stringify(name ?? '') + '; candidates: ' + matched.slice(0, 5).map(cssPath).join(', '))
    }
    return ok(describe(matched[0] as Element))
  }

  function visibleText(root: Element): string {
    const html = root as HTMLElement
    if (typeof html.innerText === 'string' && html.innerText.length > 0) return html.innerText
    return root.textContent ?? ''
  }

  function ariaOutline(root: Element): { text: string; truncated: boolean } {
    const lines: string[] = []
    let visited = 0
    let truncated = false
    const walk = (element: Element, depth: number): void => {
      if (truncated) return
      visited += 1
      if (visited > MAX_OUTLINE_ELEMENTS) { truncated = true; return }
      const role = roleOf(element)
      const name = nameOf(element)
      // A leaf with no role of its own still carries the page's prose; dropping
      // it would leave a text page with no outline at all.
      const ownText = role === 'generic' && element.children.length === 0
        ? (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
        : ''
      const label = name.length > 0 ? name : ownText
      const interesting = role !== 'generic' || label.length > 0
      if (interesting) lines.push('  '.repeat(Math.min(depth, 12)) + (role === 'generic' ? 'text' : role) + (label.length === 0 ? '' : ' "' + label + '"'))
      for (const child of Array.from(element.children)) walk(child, interesting ? depth + 1 : depth)
    }
    walk(root, 0)
    return { text: lines.join('\n'), truncated }
  }

  function read(options: { mode: 'aria' | 'text'; cursor: number; limit: number; target?: PageAgentTarget }): PageAgentResult<PageAgentRead> {
    let root: Element = document.body
    if (options.target !== undefined) {
      const resolved = resolve(options.target)
      if (!resolved.ok) return bad(resolved.code, resolved.message)
      let doc: Document
      try {
        doc = frameDocument(options.target.frames)
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        return bad(failure.code ?? 'browser/frame-missing', failure.message ?? 'the requested frame is unavailable')
      }
      const found = findResolved(doc, resolved.value)
      if (found === null) return bad('browser/target-missing', 'the resolved element disappeared before reading')
      root = found
    }
    const source = options.mode === 'text'
      ? { text: visibleText(root), truncated: false }
      : ariaOutline(root)
    const cursor = Math.max(0, Math.min(options.cursor, source.text.length))
    const end = Math.min(source.text.length, cursor + Math.max(1, options.limit))
    const content = source.text.slice(cursor, end)
    const more = end < source.text.length
    return ok({
      mode: options.mode,
      content,
      cursor,
      ...more ? { nextCursor: end } : {},
      truncated: more || source.truncated,
    })
  }

  function scrollIntoView(target: PageAgentTarget): PageAgentResult<PageAgentElementInfo> {
    const resolved = resolve(target)
    if (!resolved.ok) return bad(resolved.code, resolved.message)
    let doc: Document
    try {
      doc = frameDocument(target.frames)
    } catch (error) {
      const failure = error as { code?: string; message?: string }
      return bad(failure.code ?? 'browser/frame-missing', failure.message ?? 'the requested frame is unavailable')
    }
    const element = target.selector !== undefined && target.selector.length > 0
      ? doc.querySelector(target.selector)
      : findResolved(doc, resolved.value)
    if (element === null) return bad('browser/target-missing', 'the resolved element disappeared before scrolling')
    // Scrolling is an optimization: an engine without it still reports a rect.
    if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', inline: 'center' })
    return ok(describe(element))
  }

  function findResolved(doc: Document, info: PageAgentElementInfo): Element | null {
    const bySelector = doc.querySelector(info.selector)
    if (bySelector !== null) return bySelector
    const candidates = Array.from(doc.querySelectorAll(CANDIDATE_SELECTOR))
    return candidates.find(element => roleOf(element) === info.role && nameOf(element) === info.name) ?? null
  }

  function editableValue(element: Element): { get(): string; set(value: string): void } | undefined {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return {
        get(): string { return element.value },
        set(value: string): void {
          const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
          const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
          descriptor?.set?.call(element, value)
        },
      }
    }
    if (element instanceof HTMLSelectElement) {
      return {
        get(): string { return element.value },
        set(value: string): void {
          for (const option of Array.from(element.options)) {
            if (option.value === value || (option.text ?? '').trim() === value) { element.value = option.value; return }
          }
          element.value = value
        },
      }
    }
    if ((element as HTMLElement).isContentEditable) {
      return {
        get(): string { return element.textContent ?? '' },
        set(value: string): void { element.textContent = value },
      }
    }
    return undefined
  }

  function dispatchInput(element: Element, text: string): void {
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, data: text, inputType: 'insertText' }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function submitFrom(element: Element): void {
    const form = element.closest('form')
    if (form !== null && typeof form.requestSubmit === 'function') { form.requestSubmit(); return }
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
  }

  /**
   * Resolve and focus the element a text operation writes to.
   * @param target - the element to focus, or null for whatever is already focused.
   * @returns the focused element and the resolved facts, when one was targeted.
   */
  function focusFor(target: PageAgentTarget | null): PageAgentResult<{ element: Element; info: PageAgentElementInfo | undefined }> {
    if (target === null) {
      const active = document.activeElement
      if (active === null) return bad('browser/target-missing', 'no element is focused for typing')
      return ok({ element: active, info: undefined })
    }
    const result = resolve(target)
    if (!result.ok) return bad(result.code, result.message)
    let doc: Document
    try {
      doc = frameDocument(target.frames)
    } catch (error) {
      const failure = error as { code?: string; message?: string }
      return bad(failure.code ?? 'browser/frame-missing', failure.message ?? 'the requested frame is unavailable')
    }
    const found = target.selector !== undefined && target.selector.length > 0 ? doc.querySelector(target.selector) : findResolved(doc, result.value)
    if (found === null) return bad('browser/target-missing', 'the resolved element disappeared before writing to it')
    ;(found as HTMLElement).focus()
    return ok({ element: found, info: result.value })
  }

  function fill(target: PageAgentTarget | null, text: string, submit: boolean): PageAgentResult<PageAgentElementInfo | undefined> {
    const focused = focusFor(target)
    if (!focused.ok) return focused
    const { element, info } = focused.value
    const editable = editableValue(element)
    if (editable === undefined) return bad('browser/target-not-editable', 'the element does not accept text')
    editable.set(text)
    dispatchInput(element, text)
    if (submit) submitFrom(element)
    return ok(info)
  }

  /** Send keystrokes that append to whatever the field already holds. */
  function typeText(target: PageAgentTarget | null, text: string, submit: boolean): PageAgentResult<PageAgentElementInfo | undefined> {
    const focused = focusFor(target)
    if (!focused.ok) return focused
    const { element, info } = focused.value
    if (element instanceof HTMLSelectElement) return bad('browser/target-not-editable', 'a select element takes fill, not typing')
    const editable = editableValue(element)
    if (editable === undefined) return bad('browser/target-not-editable', 'the element does not accept text')
    for (const character of Array.from(text)) {
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: character }))
      element.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: character }))
      editable.set(editable.get() + character)
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: character, inputType: 'insertText' }))
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: character }))
    }
    element.dispatchEvent(new Event('change', { bubbles: true }))
    if (submit) submitFrom(element)
    return ok(info)
  }

  function pointerOptions(modifiers: readonly string[]): MouseEventInit {
    return {
      bubbles: true, cancelable: true, composed: true, view: window,
      altKey: modifiers.includes('Alt'), ctrlKey: modifiers.includes('Control'),
      metaKey: modifiers.includes('Meta'), shiftKey: modifiers.includes('Shift'),
    }
  }

  function clickSynthetic(target: PageAgentTarget, options: { button: string; clickCount: number; modifiers: readonly string[] }): PageAgentResult<PageAgentElementInfo> {
    const result = resolve(target)
    if (!result.ok) return bad(result.code, result.message)
    let doc: Document
    try {
      doc = frameDocument(target.frames)
    } catch (error) {
      const failure = error as { code?: string; message?: string }
      return bad(failure.code ?? 'browser/frame-missing', failure.message ?? 'the requested frame is unavailable')
    }
    const element = target.selector !== undefined && target.selector.length > 0 ? doc.querySelector(target.selector) : findResolved(doc, result.value)
    if (element === null) return bad('browser/target-missing', 'the resolved element disappeared before clicking')
    ;(element as HTMLElement).focus()
    const init: MouseEventInit = {
      ...pointerOptions(options.modifiers),
      button: options.button === 'right' ? 2 : options.button === 'middle' ? 1 : 0,
      detail: options.clickCount,
    }
    for (let index = 0; index < options.clickCount; index += 1) {
      element.dispatchEvent(new MouseEvent('mousedown', init))
      element.dispatchEvent(new MouseEvent('mouseup', init))
      element.dispatchEvent(new MouseEvent('click', init))
    }
    return ok(describe(element))
  }

  function hoverSynthetic(target: PageAgentTarget): PageAgentResult<PageAgentElementInfo> {
    const result = resolve(target)
    if (!result.ok) return bad(result.code, result.message)
    let doc: Document
    try {
      doc = frameDocument(target.frames)
    } catch (error) {
      const failure = error as { code?: string; message?: string }
      return bad(failure.code ?? 'browser/frame-missing', failure.message ?? 'the requested frame is unavailable')
    }
    const element = target.selector !== undefined && target.selector.length > 0 ? doc.querySelector(target.selector) : findResolved(doc, result.value)
    if (element === null) return bad('browser/target-missing', 'the resolved element disappeared before hovering')
    const rect = element.getBoundingClientRect()
    const init: MouseEventInit = { ...pointerOptions([]), clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }
    element.dispatchEvent(new MouseEvent('mouseover', init))
    element.dispatchEvent(new MouseEvent('mouseenter', init))
    element.dispatchEvent(new MouseEvent('mousemove', init))
    return ok(describe(element))
  }

  function dragSynthetic(source: PageAgentTarget, target: PageAgentTarget): PageAgentResult<{ source: PageAgentElementInfo; target: PageAgentElementInfo }> {
    const from = resolve(source)
    if (!from.ok) return bad(from.code, from.message)
    const to = resolve(target)
    if (!to.ok) return bad(to.code, to.message)
    let doc: Document
    try {
      doc = frameDocument(source.frames)
    } catch (error) {
      const failure = error as { code?: string; message?: string }
      return bad(failure.code ?? 'browser/frame-missing', failure.message ?? 'the requested frame is unavailable')
    }
    const sourceElement = source.selector !== undefined && source.selector.length > 0 ? doc.querySelector(source.selector) : findResolved(doc, from.value)
    const targetElement = target.selector !== undefined && target.selector.length > 0 ? doc.querySelector(target.selector) : findResolved(doc, to.value)
    if (sourceElement === null || targetElement === null) return bad('browser/target-missing', 'a drag endpoint disappeared before dragging')
    // Scroll once, then read both rects: scrolling between the two reads would
    // report the second endpoint in a different viewport than the first.
    if (typeof sourceElement.scrollIntoView === 'function') sourceElement.scrollIntoView({ block: 'center', inline: 'center' })
    const start = sourceElement.getBoundingClientRect()
    const end = targetElement.getBoundingClientRect()
    const startX = start.x + start.width / 2
    const startY = start.y + start.height / 2
    const endX = end.x + end.width / 2
    const endY = end.y + end.height / 2
    const dataTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : undefined
    const dragInit = (x: number, y: number): DragEventInit => ({ ...pointerOptions([]), clientX: x, clientY: y, dataTransfer: dataTransfer ?? null })
    sourceElement.dispatchEvent(new DragEvent('dragstart', dragInit(startX, startY)))
    for (let step = 1; step <= 8; step += 1) {
      const x = startX + ((endX - startX) * step) / 8
      const y = startY + ((endY - startY) * step) / 8
      targetElement.dispatchEvent(new DragEvent('dragover', dragInit(x, y)))
    }
    targetElement.dispatchEvent(new DragEvent('drop', dragInit(endX, endY)))
    sourceElement.dispatchEvent(new DragEvent('dragend', dragInit(endX, endY)))
    return ok({ source: describe(sourceElement), target: describe(targetElement) })
  }

  function submitFocused(): PageAgentResult<undefined> {
    const element = document.activeElement
    if (element === null) return bad('browser/target-missing', 'no element is focused')
    submitFrom(element)
    return ok(undefined)
  }

  function queryAll(selector: string, limit: number): PageAgentResult<readonly PageAgentElementInfo[]> {
    let found: Element[]
    try {
      found = Array.from(document.querySelectorAll(selector))
    } catch (error) {
      return bad('browser/bad-selector', 'invalid CSS selector ' + JSON.stringify(selector) + ': ' + String(error))
    }
    const visible = found.filter(isVisible)
    const usable = visible.length > 0 ? visible : found
    return ok(usable.slice(0, Math.max(1, limit)).map(describe))
  }

  function metrics(): PageAgentResult<PageAgentMetrics> {
    const root = document.documentElement
    const body = document.body
    return ok({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollWidth: Math.max(root.scrollWidth, body?.scrollWidth ?? 0, window.innerWidth),
      scrollHeight: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, window.innerHeight),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })
  }

  function scrollTo(x: number, y: number): PageAgentResult<undefined> {
    window.scrollTo(x, y)
    return ok(undefined)
  }

  function loadTile(source: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const picture = new Image()
      picture.onload = () => { resolve(picture) }
      picture.onerror = () => { reject(new Error('a captured tile could not be decoded for stitching')) }
      picture.src = source
    })
  }

  /**
   * Stitch viewport captures into one image.
   *
   * The composition runs here, in the visited document, so a failure of the
   * canvas work cannot take the application renderer down with it.
   */
  async function composeTiles(tiles: readonly string[], width: number, height: number, tileHeight: number): Promise<PageAgentResult<string>> {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.min(Math.round(width), MAX_CANVAS_WIDTH))
    canvas.height = Math.max(1, Math.min(Math.round(height), MAX_CANVAS_HEIGHT))
    const context = canvas.getContext('2d')
    if (context === null) return bad('browser/screenshot-failed', 'the page exposes no 2D canvas context for stitching')
    try {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      for (let index = 0; index < tiles.length; index += 1) {
        const tile = tiles[index]
        if (tile === undefined) continue
        const picture = await loadTile(tile)
        const offset = Math.min(index * tileHeight, Math.max(0, canvas.height - tileHeight))
        context.drawImage(picture, 0, offset)
      }
    } catch (error) {
      return bad('browser/screenshot-failed', 'stitching failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    return ok(canvas.toDataURL('image/png'))
  }

  /**
   * Composite one capture onto an opaque base.
   *
   * A document that declares no background captures with a transparent one, and
   * dark text over transparency is unreadable wherever the viewer paints it on a
   * dark surface. The base is white because that is what the guest shows such a
   * document over.
   * @param dataUrl - the capture to flatten.
   * @param width - the capture's width in pixels.
   * @param height - the capture's height in pixels.
   * @returns the flattened capture.
   */
  async function flatten(dataUrl: string, width: number, height: number): Promise<PageAgentResult<string>> {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.min(Math.round(width), MAX_CANVAS_WIDTH))
    canvas.height = Math.max(1, Math.min(Math.round(height), MAX_CANVAS_HEIGHT))
    const context = canvas.getContext('2d')
    if (context === null) return bad('browser/screenshot-failed', 'the page exposes no 2D canvas context for flattening')
    try {
      const picture = await loadTile(dataUrl)
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(picture, 0, 0)
    } catch (error) {
      return bad('browser/screenshot-failed', 'flattening failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    return ok(canvas.toDataURL('image/png'))
  }

  function takeDialogs(): readonly PageAgentDialog[] {
    const taken = dialogs.splice(0, dialogs.length)
    return taken
  }

  function setPolicy(accept: boolean, promptText: string): void {
    policy.accept = accept
    policy.promptText = promptText
  }

  function handleDialog(dialogId: string, accept: boolean, promptText: string): PageAgentResult<PageAgentDialog> {
    setPolicy(accept, promptText)
    for (let index = recorded.length - 1; index >= 0; index -= 1) {
      const entry = recorded[index]
      if (entry !== undefined && entry.id === dialogId) return ok(entry)
    }
    return ok({ id: dialogId, type: 'alert', message: 'the page recorded no dialog with this id' })
  }

  window.alert = function alert(message?: unknown): void {
    dialogCounter += 1
    remember({ id: 'd' + String(dialogCounter), type: 'alert', message: String(message ?? '') })
  }
  window.confirm = function confirm(message?: unknown): boolean {
    dialogCounter += 1
    remember({ id: 'd' + String(dialogCounter), type: 'confirm', message: String(message ?? '') })
    return policy.accept
  }
  window.prompt = function prompt(message?: unknown, defaultValue?: string): string | null {
    dialogCounter += 1
    remember({ id: 'd' + String(dialogCounter), type: 'prompt', message: String(message ?? ''), ...defaultValue === undefined ? {} : { defaultValue } })
    if (!policy.accept) return null
    return policy.promptText.length > 0 ? policy.promptText : (defaultValue ?? '')
  }

  globalThis.__dshBrowserAgent = {
    version: VERSION,
    resolve,
    rect: target => {
      const result = resolve(target)
      return result.ok ? ok(result.value.rect) : bad(result.code, result.message)
    },
    read,
    queryAll,
    metrics,
    scrollTo,
    composeTiles,
    flatten,
    scrollIntoView,
    fill,
    typeText,
    clickSynthetic,
    hoverSynthetic,
    dragSynthetic,
    submitFocused,
    takeDialogs,
    setPolicy,
    handleDialog,
  }
  return true
}