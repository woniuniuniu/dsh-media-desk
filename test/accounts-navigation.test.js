import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as accounts from '../src/accounts.js'

const state = { accounts: [{ id: 'a' }, { id: 'b' }], items: [], metrics: [], chat: [], skills: [] }
const busy = () => ({ state, accountId: 'a', view: 'insights', workspaceEntered: true, workspaceRevision: 3, focusId: 'old', sheetOrigin: {}, studioDock: true, chatQuote: {}, capture: {}, dialog: {}, related: {}, query: 'old', kindFilter: 'video', selectedIds: ['old'] })

test('entering an account or virtual scope opens content and clears transient workspace state locally', () => {
  assert.equal(typeof accounts.enterAccountWorkspace, 'function')
  for (const id of ['b', null, undefined]) {
    const next = accounts.enterAccountWorkspace(busy(), id)
    assert.equal(next.accountId, id)
    assert.equal(next.workspaceEntered, true)
    assert.equal(next.view, 'content')
    assert.equal(next.workspaceRevision, 4)
    for (const field of ['focusId', 'sheetOrigin', 'chatQuote', 'capture', 'dialog', 'related']) assert.equal(next[field], null, field)
    assert.equal(next.studioDock, false)
    assert.equal(next.query, '')
    assert.equal(next.kindFilter, 'all')
    assert.deepEqual(next.selectedIds, [])
    assert.equal(next.state, state)
  }
  assert.throws(() => accounts.enterAccountWorkspace(busy(), 'missing'), /not found/i)
})

test('leaving an account returns to the hub and invalidates outstanding assistant navigation', () => {
  assert.equal(typeof accounts.leaveAccountWorkspace, 'function')
  assert.equal(typeof accounts.workspaceOrigin, 'function')
  assert.equal(typeof accounts.matchesWorkspace, 'function')
  const next = accounts.enterAccountWorkspace(busy(), undefined)
  const origin = accounts.workspaceOrigin(next)
  assert.equal(accounts.matchesWorkspace(next, origin), true)
  const root = accounts.leaveAccountWorkspace(next)
  assert.equal(root.view, 'accounts')
  assert.equal(root.workspaceEntered, false)
  assert.equal(root.accountId, undefined)
  assert.equal(accounts.matchesWorkspace(root, origin), false)
  assert.equal(accounts.matchesWorkspace(accounts.enterAccountWorkspace(root, undefined), origin), false)
})

test('deleting the selected account falls back to the hub while virtual scopes remain valid', () => {
  assert.equal(typeof accounts.reconcileAccountWorkspace, 'function')
  const next = { ...busy(), state: { ...state, accounts: [] } }
  const root = accounts.reconcileAccountWorkspace(next)
  assert.equal(root.workspaceEntered, false)
  assert.equal(root.view, 'accounts')
  assert.equal(root.focusId, null)
  for (const id of [null, undefined]) {
    const virtual = { ...next, accountId: id }
    assert.equal(accounts.reconcileAccountWorkspace(virtual), virtual)
  }
})
