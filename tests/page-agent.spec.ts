/** Behavior of the page-side agent inside a real document. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { pageAgentMain, type DshPageAgent } from '../src/client/page-agent.ts'

function assignGlobals(values: Record<string, unknown>): void {
  Object.assign(globalThis, values)
}

function installDocument(html: string): DshPageAgent {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { pretendToBeVisual: true })
  assignGlobals({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    Event: dom.window.Event,
    DragEvent: dom.window.DragEvent ?? class DragEventStub extends dom.window.Event {},
    DataTransfer: dom.window.DataTransfer,
  })
  delete (globalThis as { __dshBrowserAgent?: unknown }).__dshBrowserAgent
  const installed = pageAgentMain()
  assert.equal(installed, true)
  const agent = globalThis.__dshBrowserAgent
  assert.ok(agent !== undefined)
  return agent
}

test('a selector resolves to one element with its role and name', () => {
  const agent = installDocument('<button id="go">Start now</button>')
  const resolved = agent.resolve({ selector: '#go' })
  assert.ok(resolved.ok)
  if (!resolved.ok) return
  assert.equal(resolved.value.tag, 'button')
  assert.equal(resolved.value.role, 'button')
  assert.equal(resolved.value.name, 'Start now')
  assert.equal(resolved.value.selector, '#go')
})

test('a selector matching several elements is ambiguous unless exact', () => {
  const agent = installDocument('<p class="x">one</p><p class="x">two</p>')
  const ambiguous = agent.resolve({ selector: '.x' })
  assert.ok(!ambiguous.ok)
  if (ambiguous.ok) return
  assert.equal(ambiguous.code, 'browser/target-ambiguous')
  const first = agent.resolve({ selector: '.x', exact: true })
  assert.ok(first.ok)
})

test('a role and name resolve without a selector', () => {
  const agent = installDocument('<button>Save</button><button>Cancel</button>')
  const resolved = agent.resolve({ role: 'button', name: 'Cancel' })
  assert.ok(resolved.ok)
  if (!resolved.ok) return
  assert.equal(resolved.value.name, 'Cancel')
})

test('a missing target reports its own code', () => {
  const agent = installDocument('<div>nothing here</div>')
  const missing = agent.resolve({ selector: '#absent' })
  assert.ok(!missing.ok)
  if (missing.ok) return
  assert.equal(missing.code, 'browser/target-missing')
})

test('a text read returns the document text and honours the cursor', () => {
  const agent = installDocument('<p>alpha beta gamma</p>')
  const first = agent.read({ mode: 'text', cursor: 0, limit: 5 })
  assert.ok(first.ok)
  if (!first.ok) return
  assert.equal(first.value.content, 'alpha')
  assert.equal(first.value.nextCursor, 5)
  assert.equal(first.value.truncated, true)
  const second = agent.read({ mode: 'text', cursor: first.value.nextCursor ?? 0, limit: 100 })
  assert.ok(second.ok)
  if (!second.ok) return
  assert.equal(second.value.truncated, false)
  assert.equal(second.value.nextCursor, undefined)
})

test('an accessibility read reports roles and names', () => {
  const agent = installDocument('<h1>Title</h1><button>Go</button>')
  const read = agent.read({ mode: 'aria', cursor: 0, limit: 1_000 })
  assert.ok(read.ok)
  if (!read.ok) return
  assert.match(read.value.content, /heading "Title"/)
  assert.match(read.value.content, /button "Go"/)
})

test('an accessibility read keeps prose that has no role of its own', () => {
  const agent = installDocument('<p>plain sentence</p><p>second sentence</p>')
  const read = agent.read({ mode: 'aria', cursor: 0, limit: 1_000 })
  assert.ok(read.ok)
  if (!read.ok) return
  assert.match(read.value.content, /text "plain sentence"/)
  assert.match(read.value.content, /text "second sentence"/)
})

test('dragging dispatches the DOM drag sequence to the drop target', () => {
  const agent = installDocument('<div id="from" draggable="true">drag me</div><div id="to">drop here</div>')
  const observed: string[] = []
  const target = document.getElementById('to')
  if (target === null) throw new Error('the drop target is missing')
  for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) {
    document.addEventListener(type, (event) => { observed.push(type + ':' + String((event.target as Element).id)) }, true)
  }
  const dragged = agent.dragSynthetic({ selector: '#from' }, { selector: '#to' })
  assert.ok(dragged.ok)
  if (!dragged.ok) return
  assert.equal(dragged.value.source.selector, '#from')
  assert.equal(dragged.value.target.selector, '#to')
  // The pointer path is interpolated, so the target sees several dragovers
  // before the drop; what matters is the ordered sequence and its endpoints.
  assert.equal(observed[0], 'dragstart:from')
  assert.equal(observed[observed.length - 1], 'dragend:from')
  const dropIndex = observed.indexOf('drop:to')
  assert.ok(dropIndex > 0, 'the drop target never received drop: ' + observed.join(', '))
  assert.deepEqual([...new Set(observed.slice(1, dropIndex))], ['dragover:to'])
})

test('scrollIntoView reports the element, not a bare rectangle', () => {
  const agent = installDocument('<button id="go">Go</button>')
  const scrolled = agent.scrollIntoView({ selector: '#go' })
  assert.ok(scrolled.ok)
  if (!scrolled.ok) return
  assert.equal(scrolled.value.selector, '#go')
  assert.equal(typeof scrolled.value.rect.x, 'number')
})

test('filling a field sets its value and announces the change', () => {
  const agent = installDocument('<input id="name" type="text">')
  let changes = 0
  const input = document.getElementById('name') as HTMLInputElement
  input.addEventListener('input', () => { changes += 1 })
  const filled = agent.fill({ selector: '#name' }, 'ada', false)
  assert.ok(filled.ok)
  assert.equal(input.value, 'ada')
  assert.equal(changes, 1)
})

test('the dialog shim records dialogs and applies the page policy', () => {
  const agent = installDocument('<div></div>')
  assert.equal(window.confirm('proceed?'), false)
  assert.equal(window.prompt('name?', 'fallback'), null)
  window.alert('heads up')
  const raised = agent.takeDialogs()
  assert.deepEqual(raised.map(entry => entry.type), ['confirm', 'prompt', 'alert'])
  assert.equal(agent.takeDialogs().length, 0)
  agent.setPolicy(true, 'typed')
  assert.equal(window.confirm('again?'), true)
  assert.equal(window.prompt('name?', 'fallback'), 'typed')
})

test('a dialog decision updates the policy and reports the settled dialog', () => {
  const agent = installDocument('<div></div>')
  window.alert('boom')
  const raised = agent.takeDialogs()
  const first = raised[0]
  assert.ok(first !== undefined)
  const settled = agent.handleDialog(first.id, true, '')
  assert.ok(settled.ok)
  if (!settled.ok) return
  assert.equal(settled.value.message, 'boom')
  assert.equal(window.confirm('after'), true)
})