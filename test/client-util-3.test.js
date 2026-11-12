import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOps } from '../src/ops.js'
import { emptyState } from '../src/seed.js'
import { deskFromState, needsStoryConfirm, opsToast, sameDesk } from '../client/util.js'

test('opsToast：成功取 applied 第一条并带撤销；有错误显示第一条错误；silent 不提示', () => {
  const state = emptyState()
  const ok = applyOps(state, [{ op: 'add_note', text: '一条想法' }])
  assert.deepEqual(opsToast(ok, { undoable: true }), { text: '已记下笔记', undo: true, error: false })
  assert.deepEqual(opsToast(ok, { undoable: false }), { text: '已记下笔记', undo: false, error: false })
  assert.equal(opsToast(ok, { silent: true }), null)
  const bad = applyOps(state, [{ op: 'approve_candidate', id: 'c_none' }])
  assert.deepEqual(opsToast(bad, { silent: true }), { text: '找不到这条稿子', undo: false, error: true })
  assert.equal(opsToast({ applied: [], errors: [] }), null)
  assert.equal(opsToast(null), null)
})

test('deskFromState / sameDesk：只在内容变化时才需要更新界面', () => {
  const data = { state: { candidates: [{ id: 'c_1', text: 'a' }] }, model: 'm', modelOk: true, modelError: null, canUndo: false, exchangeDir: '/x', composing: true, ownHandle: 'me' }
  const patch = deskFromState(data)
  assert.deepEqual(patch, { state: data.state, model: 'm', modelOk: true, modelError: null, canUndo: false, exchangeDir: '/x', composing: true, ownHandle: 'me' })
  assert.deepEqual(deskFromState({ state: {} }), { state: {}, model: null, modelOk: null, modelError: null, canUndo: false, exchangeDir: null, composing: false, ownHandle: '' })
  const snapshot = { ...structuredClone(patch), view: 'inbox', toast: { text: 't' } }
  assert.equal(sameDesk(snapshot, deskFromState(structuredClone(data))), true)
  assert.equal(sameDesk(snapshot, deskFromState({ ...data, ownHandle: 'other' })), false)
  assert.equal(sameDesk(snapshot, deskFromState({ ...data, composing: false })), false)
  assert.equal(sameDesk(snapshot, deskFromState({ ...data, state: { candidates: [{ id: 'c_1', text: 'b' }] } })), false)
})

test('通过前要确认：正文里还有需要自己填的经历', () => {
  assert.equal(needsStoryConfirm('前面【此处填你的经历】后面'), true)
  assert.equal(needsStoryConfirm('已经填好了'), false)
  assert.equal(needsStoryConfirm(undefined), false)
})

test('clear_notices 清空提示，可以撤销', () => {
  const state = emptyState()
  state.runs.notices.push({ id: 'n_1', at: '2026-11-11T00:00:00Z', text: 'x' })
  assert.deepEqual(applyOps(state, [{ op: 'clear_notices' }]), { applied: ['已清空提示'], errors: [] })
  assert.deepEqual(state.runs.notices, [])
})
