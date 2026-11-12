// 长文：选题、草稿与完成稿，正文始终由本人确认。
import React from 'react'
import { dispatchOps, draftLongform, reviseLongform, suggestLongform, toast, useDesk } from './desk.js'
import { groupLongforms, PLACEHOLDER, relativeDay, splitPlaceholder, t } from './util.js'
import { Dialog, Empty } from './ui.jsx'

function AddLongformDialog({ onClose }) {
  const [title, setTitle] = React.useState('')
  const [angle, setAngle] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const add = async (event) => {
    event.preventDefault()
    if (busy || !title.trim()) return
    setBusy(true)
    const data = await dispatchOps([{ op: 'add_longform', title: title.trim(), angle: angle.trim() }], { label: t('加了一个长文选题') })
    setBusy(false)
    if (data && !data.errors?.length) onClose()
  }
  return (
    <Dialog title={t('自己加一个')} onClose={onClose}>
      <form className="md-form" onSubmit={add}>
        <label className="md-field"><span>{t('标题')}</span><input required value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
        <label className="md-field"><span>{t('角度')}</span><input value={angle} disabled={busy} onChange={event => setAngle(event.target.value)} /></label>
        <div className="md-form-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="md-btn" onClick={onClose}>{t('取消')}</button>
          <button type="submit" className="md-btn is-primary" disabled={busy || !title.trim()}>{t('添加')}</button>
        </div>
      </form>
    </Dialog>
  )
}

function LongformEditor({ row, busy, onBusy }) {
  const [title, setTitle] = React.useState(row.title)
  const [body, setBody] = React.useState(row.body ?? '')
  const [instruction, setInstruction] = React.useState('')
  const [deleting, setDeleting] = React.useState(false)
  const titleRef = React.useRef(null)
  const bodyRef = React.useRef(null)
  const savingBody = React.useRef(null)
  React.useEffect(() => { if (document.activeElement !== titleRef.current) setTitle(row.title) }, [row.title])
  React.useEffect(() => { if (document.activeElement !== bodyRef.current) setBody(row.body ?? '') }, [row.body])

  const saveTitle = async () => {
    const next = title.trim()
    if (!next) { setTitle(row.title); return }
    if (next !== row.title) {
      const data = await dispatchOps([{ op: 'edit_longform', id: row.id, title: next }], { label: t('改了标题') })
      if (data === null || data?.errors?.length) setTitle(row.title)
    }
  }
  const saveBody = () => {
    if (savingBody.current?.body === body) return savingBody.current.promise
    if (!savingBody.current && body === (row.body ?? '')) return
    // 连续失焦保存按顺序完成，改写和完成操作等待最后一次正文保存。
    const save = { body, promise: (savingBody.current?.promise ?? Promise.resolve()).then(() => dispatchOps([{ op: 'edit_longform', id: row.id, body }], { label: t('改了正文') })) }
    savingBody.current = save
    save.promise.finally(() => { if (savingBody.current === save) savingBody.current = null })
    return save.promise
  }
  const draft = async () => {
    if (busy) return
    onBusy(row.id, 'draft')
    await draftLongform(row.id)
    onBusy(row.id, '')
  }
  const revise = async () => {
    if (busy || !instruction.trim()) return
    onBusy(row.id, 'revise')
    const saved = await saveBody()
    if (saved === null || saved?.errors?.length) { onBusy(row.id, ''); return }
    const ok = await reviseLongform(row.id, instruction.trim())
    onBusy(row.id, '')
    if (ok) setInstruction('')
  }
  const finish = async () => {
    onBusy(row.id, 'save')
    const saved = await saveBody()
    if (saved !== null && !saved?.errors?.length) await dispatchOps([{ op: 'finish_longform', id: row.id }], { label: t('标为完成') })
    onBusy(row.id, '')
  }
  const remove = async () => {
    onBusy(row.id, 'save')
    if (savingBody.current) await savingBody.current.promise
    const data = await dispatchOps([{ op: 'delete_longform', id: row.id }], { label: t('删了一篇长文') })
    onBusy(row.id, '')
    if (data && !data.errors?.length) setDeleting(false)
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(body); toast(t('已复制')) }
    catch { toast(t('复制失败，请手动全选复制'), { error: true }) }
  }
  const count = Array.from(body).length
  const placeholders = splitPlaceholder(body).filter(part => part.mark).length
  return (
    <article className="md-panel md-longform-editor" aria-busy={Boolean(busy)}>
      <label className="md-field"><span>{t('标题')}</span><input ref={titleRef} value={title} disabled={Boolean(busy)} onChange={event => setTitle(event.target.value)} onBlur={saveTitle} /></label>
      {row.angle ? <p className="md-muted">{row.angle}</p> : null}
      {row.status === 'done' ? <span className="md-inbox-tag">{t('已完成')}</span> : null}
      {row.error != null ? <div className="md-style-warn" role="status">
        <p>{t('上次没成功：{error}', { error: row.error })}</p>
        {row.status === 'idea' ? <button type="button" className="md-btn is-small" disabled={Boolean(busy)} onClick={draft}>{t('重试')}</button> : null}
      </div> : null}
      {row.status === 'idea' ? <button type="button" className="md-btn is-primary" disabled={Boolean(busy)} onClick={draft}>{busy === 'draft' ? t('正在写初稿，可能要一两分钟…') : t('出初稿')}</button> : null}
      {row.status !== 'idea' || row.body ? <>
        {placeholders ? <div className="md-longform-placeholders md-inbox-need">
          <p>{t('正文里还有 {n} 处需要你自己填的经历', { n: placeholders })}</p>
          {body.split(/\n\s*\n/).filter(paragraph => paragraph.includes(PLACEHOLDER)).map((paragraph, index) => <p key={index}>{splitPlaceholder(paragraph).map((part, i) => part.mark ? <mark key={i}>{part.text}</mark> : <React.Fragment key={i}>{part.text}</React.Fragment>)}</p>)}
        </div> : null}
        <label className="md-field">
          <span>{t('正文')}</span>
          <textarea ref={bodyRef} className="md-longform-body" rows={20} value={body} disabled={Boolean(busy)} onChange={event => setBody(event.target.value)} onBlur={saveBody} />
          <small className={count > 20000 ? 'is-over' : ''}>{count} / 20000</small>
        </label>
        {row.status === 'draft' ? <label className="md-field">
          <span>{t('说一句来改')}</span>
          <input value={instruction} placeholder={t('说一句来改')} disabled={Boolean(busy)} onChange={event => setInstruction(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); revise() } }} />
        </label> : null}
        {busy === 'revise' ? <p className="md-shimmer" role="status">{t('正在改…')}</p> : null}
        <div className="md-style-actions">
          <button type="button" className="md-btn" disabled={Boolean(busy)} onClick={copy}>{t('复制全文')}</button>
          {row.status === 'draft' ? <button type="button" className="md-btn is-primary" disabled={Boolean(busy)} onClick={finish}>{t('标为完成')}</button> : null}
          <button type="button" className="md-btn is-danger" disabled={Boolean(busy)} onClick={() => setDeleting(true)}>{t('删除')}</button>
        </div>
      </> : null}
      {deleting ? <Dialog title={t('删掉这篇长文吗？')} onClose={() => setDeleting(false)}>
        <div className="md-form-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="md-btn" disabled={Boolean(busy)} onClick={() => setDeleting(false)}>{t('取消')}</button>
          <button type="button" className="md-btn is-danger" disabled={Boolean(busy)} onClick={remove}>{t('删除')}</button>
        </div>
      </Dialog> : null}
    </article>
  )
}

export function LongformView() {
  const longforms = useDesk(s => s.state.longforms) ?? []
  const [selected, setSelected] = React.useState(null)
  const [adding, setAdding] = React.useState(false)
  const [suggesting, setSuggesting] = React.useState(false)
  const [busy, setBusy] = React.useState({})
  const groups = groupLongforms(longforms)
  const row = longforms.find(item => item.id === selected)
  React.useEffect(() => { if (!row) setSelected(null) }, [row])
  const suggest = async () => {
    setSuggesting(true)
    const result = await suggestLongform()
    setSuggesting(false)
    if (result?.busy) toast(t('已经在想选题了，稍等一下'))
    else if (result?.created > 0) toast(t('出了 {n} 个选题', { n: result.created }))
    else if (result?.error) toast(result.error, { error: true })
  }
  return (
    <div className="md-page">
      <div className="md-longform">
        <aside className="md-panel md-longform-list">
          <header className="md-style-actions">
            <button type="button" className="md-btn" disabled={suggesting} onClick={suggest}>{suggesting ? t('正在想选题…') : t('建议几个选题')}</button>
            <button type="button" className="md-btn" onClick={() => setAdding(true)}>{t('自己加一个')}</button>
          </header>
          {!longforms.length ? <Empty title={t('还没有长文')} hint={t('每周一会自动建议几个选题，也可以点「建议几个选题」或自己加一个。')} /> : null}
          {Object.entries({ idea: '选题', draft: '草稿', done: '完成' }).map(([status, label]) => <section key={status}>
            <h3>{t(label)}（{groups[status].length}）</h3>
            <ul>{groups[status].map(item => <li key={item.id}><button type="button" className={`md-longform-row ${selected === item.id ? 'is-on' : ''}`} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}><span>{item.title}</span><time>{relativeDay(item.updatedAt)}</time></button></li>)}</ul>
          </section>)}
        </aside>
        {row ? <LongformEditor key={row.id} row={row} busy={busy[row.id]} onBusy={(id, value) => setBusy(prev => ({ ...prev, [id]: value }))} /> : null}
      </div>
      {adding ? <AddLongformDialog onClose={() => setAdding(false)} /> : null}
    </div>
  )
}
