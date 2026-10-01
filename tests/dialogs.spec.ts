/** Behavior of the pending-dialog tracker. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DialogTracker } from '../src/client/dialogs.ts'

test('the newest raised dialog is the pending one', () => {
  const tracker = new DialogTracker()
  const pending = tracker.record([
    { id: 'd1', type: 'alert', message: 'first' },
    { id: 'd2', type: 'confirm', message: 'second' },
  ])
  assert.equal(pending?.id, 'd2')
  assert.equal(tracker.pendingDialog?.type, 'confirm')
})

test('settling clears only the decided dialog', () => {
  const tracker = new DialogTracker()
  tracker.record([{ id: 'd1', type: 'prompt', message: 'name?', defaultValue: 'ada' }])
  assert.equal(tracker.settle('other'), undefined)
  assert.equal(tracker.pendingDialog?.id, 'd1')
  assert.equal(tracker.settle('d1')?.defaultValue, 'ada')
  assert.equal(tracker.pendingDialog, undefined)
})

test('a new document forgets the pending dialog', () => {
  const tracker = new DialogTracker()
  tracker.record([{ id: 'd1', type: 'alert', message: 'gone' }])
  tracker.reset()
  assert.equal(tracker.pendingDialog, undefined)
})
