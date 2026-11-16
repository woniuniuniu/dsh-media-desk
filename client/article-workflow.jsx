// 一份正文：直接编辑、引用素材，并选择接受或放弃 AI 建议。
import React from 'react'
import { articleWorkspace, productionFor } from '../src/workflow.js'
import { articleAction, fetchArticleWorkflow, loadDesk, saveProduced, sendChat, setDesk, toast, useDesk } from './desk.js'
import { t } from './i18n.js'
import { Icon } from './ui.jsx'
import { renderMarkdown } from './util.js'

const clone = value => JSON.parse(JSON.stringify(value))
const NOOP = () => {}

/** 背景状态刷新只更新未编辑的字段，不覆盖用户正在改的正文或表单。 */
function useEditable(incoming) {
  const [value, setValue] = React.useState(() => clone(incoming))
  const [dirty, setDirty] = React.useState(false)
  const editing = React.useRef(false)
  const serialized = JSON.stringify(incoming)
  const seen = React.useRef(serialized)
  React.useEffect(() => {
    if (serialized === seen.current) return
    seen.current = serialized
    if (!editing.current) setValue(clone(incoming))
  }, [serialized])
  const change = next => { editing.current = true; setDirty(true); setValue(next) }
  const accept = next => { editing.current = false; setDirty(false); setValue(clone(next)) }
  return { value, change, accept, dirty }
}

function Field({ label, value, onChange, multiline = false, disabled = false, ...props }) {
  const Tag = multiline ? 'textarea' : 'input'
  return <label className="md-aw-field"><span>{t(label)}</span><Tag value={value ?? ''} onChange={event => onChange(event.target.value)} disabled={disabled} {...props} /></label>
}

function ImageList({ production }) {
  const pictures = [production?.cover ? { ...production.cover, role: 'cover' } : null, ...(production?.images || [])].filter(Boolean)
  if (!pictures.length) return null
  return <div className="md-aw-images">{pictures.map((image, index) => <figure key={`${image.role || 'image'}-${index}`}>
    {image.src ? <a href={image.src} target="_blank" rel="noreferrer"><img src={image.src} alt={image.alt || image.caption || t('文章封面')} /></a> : <div className="md-aw-image-empty"><Icon name="image" size={24} /><span>{image.status === 'failed' ? t('图片生成失败，可重试') : image.status === 'running' || image.status === 'pending' ? t('正在生成图片……') : t('等待生成图片')}</span></div>}
    <figcaption><b>{image.role === 'cover' ? t('文章封面') : image.caption || t('配图 {n}', { n: index })}</b>{image.anchor ? <span>{image.anchor}</span> : null}{image.prompt ? <p>{image.prompt}</p> : null}{image.error ? <p className="md-aw-error">{image.error}</p> : null}</figcaption>
  </figure>)}</div>
}

function candidateText(record) {
  const value = record.data || {}
  if (typeof value.text === 'string') return [value.title, value.text].filter(Boolean).join('\n\n')
  if (value.point) return [t('核心观点') + '：' + (value.point.thesis || ''), t('目标读者') + '：' + (value.point.audience || ''), t('适用边界') + '：' + (value.point.boundary || '')].join('\n')
  if (value.outline) return [value.outline.title, value.outline.text].filter(Boolean).join('\n\n')
  return [value.title, value.thesis, value.audience, value.boundary].filter(Boolean).join('\n\n')
}

/** 旧稿和并发生成的候选只读展示，不暗中覆盖当前版本。 */
function VersionHistory({ workspace, images = false }) {
  const drafts = workspace.draftHistory || []
  const pictures = workspace.imageHistory || []
  const candidates = workspace.candidateHistory || []
  const copyVersion = async text => { try { await navigator.clipboard.writeText(text); toast(t('版本内容已复制')) } catch (error) { toast(error.message, { error: true }) } }
  return <section className="md-aw-history" aria-label={t('版本记录')}>
    {!images && drafts.length ? <details><summary>{t('以前的稿件（{n}）', { n: drafts.length })}</summary>{[...drafts].reverse().map((record, index) => <article key={record.id || index}>
      <header><b>{record.title || t('文章')}</b><span>{record.candidate ? t('生成候选') : t('以前的稿件')}{record.at ? ` · ${record.at}` : ''}</span></header>
      <textarea readOnly rows={8} aria-label={t('以前的正文')} value={record.text || ''} /><button type="button" className="md-pill" onClick={() => copyVersion([record.title, record.text].filter(Boolean).join('\n\n'))}>{t('复制这个版本')}</button>
    </article>)}</details> : null}
    {images && pictures.length ? <details><summary>{t('以前的配图（{n}）', { n: pictures.length })}</summary>{[...pictures].reverse().map((record, index) => <article key={record.id || index}><header><b>{t('以前的配图')}</b>{record.at ? <span>{record.at}</span> : null}</header><ImageList production={{ cover: record.cover, images: record.images }} /></article>)}</details> : null}
    {candidates.length ? <details><summary>{t('尚未采用的生成候选（{n}）', { n: candidates.length })}</summary><p className="md-aw-description">{t('这些结果未覆盖当前内容。可以阅读、复制，再自行决定是否采用。')}</p>{[...candidates].reverse().map((record, index) => {
      const value = candidateText(record)
      return <article key={record.id || index}><header><b>{t('生成候选')}</b>{record.at ? <span>{record.at}</span> : null}</header>{value ? <><textarea readOnly rows={8} aria-label={t('候选内容')} value={value} /><button type="button" className="md-pill" onClick={() => copyVersion(value)}>{t('复制候选内容')}</button></> : null}{record.data?.cover || record.data?.images?.length ? <ImageList production={record.data} /> : null}</article>
    })}</details> : null}
  </section>
}

export function ArticleWorkflow({ item, onDirty = NOOP, onBusy = NOOP, controllerRef, onSelectionChange = NOOP, onAsk = NOOP }) {
  const workspace = articleWorkspace(item)
  const production = productionFor(item, 'article')
  const settings = useDesk(state => state.settings)
  const serverAction = useDesk(state => state.articleBusy?.[item.id])
  const draft = useEditable({ title: production?.title ?? item.title ?? '', text: production?.article ?? '' })
  const [busy, setBusy] = React.useState('')
  const [remoteBusy, setRemoteBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const [selection, setSelection] = React.useState(null)
  const [position, setPosition] = React.useState({ x: 12, y: 12 })
  const lock = React.useRef(false)
  const alive = React.useRef(true)
  const input = React.useRef(null)
  const editor = React.useRef(null)
  const composing = React.useRef(false)
  const editVersion = React.useRef(0)
  const editBase = React.useRef(null)
  const liveDraft = React.useRef(draft.value)
  liveDraft.current = draft.value
  const api = React.useRef(null)
  const candidatesRef = React.useRef(null)
  const assetBusy = [production?.cover, ...(production?.images || [])].some(image => ['pending', 'running'].includes(image?.status))
  const waiting = Boolean(busy || serverAction || remoteBusy || assetBusy)
  const hasText = Boolean(draft.value.text.trim())
  const candidates = workspace.editCandidates || []
  const pending = candidates.filter(candidate => candidate.status === 'pending')
  const handled = candidates.filter(candidate => candidate.status !== 'pending')
  const earlier = item.articleWorkflow
  const hasEarlier = earlier && (earlier.sources?.some(source => source.text || source.title || source.url) || earlier.point?.thesis || earlier.point?.audience || earlier.point?.boundary || earlier.outline?.title || earlier.outline?.text)
  const serverText = JSON.stringify({ title: production?.title ?? item.title ?? '', text: production?.article ?? '' })
  const conflict = draft.dirty && editBase.current && workspace.revision !== editBase.current.revision && serverText !== editBase.current.text
  const clearSelection = () => {
    setSelection(null)
    onSelectionChange(null)
    const element = input.current
    if (element && element.selectionStart !== element.selectionEnd) element.setSelectionRange(element.selectionEnd, element.selectionEnd)
  }

  React.useEffect(() => { onDirty(draft.dirty); return () => onDirty(false) }, [draft.dirty, onDirty])
  React.useEffect(() => { onBusy(waiting); return () => onBusy(false) }, [waiting, onBusy])
  React.useEffect(() => { onSelectionChange(selection) }, [selection, onSelectionChange])
  React.useEffect(() => { if (pending.length) candidatesRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }) }, [pending.at(-1)?.id])
  React.useEffect(() => {
    alive.current = true
    if (controllerRef) controllerRef.current = api.current
    let stopped = false, timer = null, wasBusy = false
    const read = async () => {
      try {
        const status = await fetchArticleWorkflow(item.id)
        if (stopped) return
        setRemoteBusy(Boolean(status.busy))
        if (status.busy) { wasBusy = true; timer = setTimeout(read, 1200) }
        else if (wasBusy) await loadDesk()
      } catch { if (!stopped && wasBusy) timer = setTimeout(read, 2500) }
    }
    read()
    return () => { stopped = true; alive.current = false; clearTimeout(timer); onSelectionChange(null); if (controllerRef) controllerRef.current = null }
  }, [item.id, controllerRef, onSelectionChange])

  const updateDraft = patch => {
    if (!editBase.current) editBase.current = { revision: workspace.revision, text: serverText }
    editVersion.current += 1
    const next = { ...liveDraft.current, ...patch }
    liveDraft.current = next
    draft.change(next)
    if ('text' in patch) clearSelection()
  }
  const captureSelection = event => {
    if (composing.current) return
    const element = event.currentTarget || event.target
    const start = element.selectionStart, end = element.selectionEnd
    const text = element.value.slice(start, end)
    if (start === end || !text.trim()) { clearSelection(); return }
    setSelection(previous => previous?.start === start && previous?.end === end && previous?.text === text ? previous : { start, end, text })
    const box = editor.current?.getBoundingClientRect()
    if (box && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) setPosition({ x: Math.max(8, Math.min(event.clientX - box.left, box.width - 260)), y: Math.max(8, event.clientY - box.top - 44) })
  }
  const run = async (action, { data = {}, mentions, flush = false } = {}) => {
    if (lock.current || waiting) return false
    lock.current = true
    setBusy(action)
    setFailed(false)
    let revision = draft.dirty && (flush || action === 'save_draft') ? (editBase.current?.revision ?? workspace.revision) : workspace.revision
    try {
      if (flush && (draft.dirty || !item.production || item.production.format !== 'article' || production?.legacyFromDraft)) {
        const version = editVersion.current
        const value = { ...liveDraft.current }
        const saved = await articleAction(item.id, 'save_draft', value, revision)
        if (!saved) { if (alive.current) setFailed(true); return false }
        revision = saved.workflow.revision
        if (alive.current) {
          if (editVersion.current === version) { editBase.current = null; draft.accept(value) }
          else editBase.current = { revision, text: JSON.stringify(value) }
        }
      }
      const version = editVersion.current
      const result = await articleAction(item.id, action, data, revision, mentions)
      if (!result) { if (alive.current) setFailed(true); return false }
      if (!alive.current) return result
      if (action === 'save_draft' || action === 'accept_candidate') {
        const row = result.state?.items?.find(entry => entry.id === item.id)
        const accepted = productionFor(row, 'article')
        const value = { title: accepted?.title ?? data.title ?? liveDraft.current.title, text: accepted?.article ?? data.text ?? liveDraft.current.text }
        if (editVersion.current === version) { editBase.current = null; draft.accept(value) }
        else if (action === 'save_draft') editBase.current = { revision: result.workflow.revision, text: JSON.stringify(value) }
        if (action === 'accept_candidate') clearSelection()
      }
      if (action === 'discard_candidate') clearSelection()
      return result
    } finally { lock.current = false; if (alive.current) setBusy('') }
  }
  const send = async (instruction, { mentions = [] } = {}) => {
    const commands = mentions.filter(mention => mention.id?.startsWith('cmd:'))
    const otherCommand = commands.some(command => command.id !== 'cmd:produce')
    const rawCommand = /^\/(?!produce(?:\s|$)|成稿(?:\s|$))/i.test(instruction.trim())
    if (otherCommand || rawCommand) {
      const result = await sendChat(instruction, { mentions })
      if (result) clearSelection()
      return result
    }
    const material = mentions.filter(mention => !mention.id?.startsWith('cmd:'))
    const selected = selection && liveDraft.current.text.slice(selection.start, selection.end) === selection.text ? selection : null
    const result = await run(selected ? 'rewrite_selection' : 'generate_draft', { flush: true, mentions: material, data: { instruction, ...(selected ? { selection: { ...selected } } : { title: liveDraft.current.title }) } })
    return Boolean(result)
  }
  api.current = { send, clearSelection }
  if (controllerRef) controllerRef.current = api.current

  const copy = async () => { try { await navigator.clipboard.writeText(`# ${draft.value.title}\n\n${draft.value.text}`); toast(t('文章已复制')) } catch (error) { toast(error.message, { error: true }) } }
  const acceptable = candidate => !waiting && !draft.dirty && !candidate.stale && candidate.baseRevision === workspace.revision && (candidate.kind !== 'selection' || production?.article?.slice(candidate.selection?.start, candidate.selection?.end) === candidate.selection?.text)
  const candidateCard = (candidate, history = false) => <article className="md-ai-candidate" key={candidate.id} data-candidate-id={candidate.id}>
    <header><b>{candidate.kind === 'selection' ? t('选中文字的修改建议') : t('文章草稿建议')}</b><span>{candidate.instruction}</span></header>
    <div className="md-ai-comparison"><div><span>{t('原文')}</span><pre>{candidate.selection?.text ?? production?.article ?? ''}</pre></div><div><span>{t('建议')}</span>{candidate.title ? <h3>{candidate.title}</h3> : null}<pre>{candidate.text}</pre></div></div>
    {!history ? <footer><button type="button" className="md-pill is-primary" disabled={!acceptable(candidate)} onClick={() => { if (acceptable(candidate)) run('accept_candidate', { data: { candidateId: candidate.id } }) }}>{t('接受建议')}</button><button type="button" className="md-pill" disabled={waiting} onClick={() => run('discard_candidate', { data: { candidateId: candidate.id } })}>{t('放弃建议')}</button>{draft.dirty || candidate.stale || candidate.baseRevision !== workspace.revision ? <span>{t('正文已有改动，这条建议不会自动覆盖。')}</span> : null}</footer> : <p className="md-aw-notice">{candidate.status === 'accepted' ? t('已接受') : t('已放弃')}</p>}
  </article>

  return <section className="md-article-workflow md-inline-editor" aria-label={t('文章编辑器')} aria-busy={waiting}>
    <header className="md-aw-heading"><div><span className="md-idea-label">{t('文章')}</span><p className="md-aw-description">{t('直接写或粘贴正文；在助手中 @ 引用素材，选中文字就能提出修改。')}</p></div><div className="md-aw-actions">
      <button type="button" className="md-pill" disabled={!draft.dirty || waiting} onClick={() => run('save_draft', { data: { ...liveDraft.current } })}>{t('保存正文')}</button>
      <button type="button" className="md-pill" disabled={!hasText} onClick={copy}>{t('复制文章')}</button>
      <button type="button" className="md-pill" disabled={!hasText || draft.dirty || waiting} onClick={async () => { if (lock.current) return; lock.current = true; setBusy('export'); try { await saveProduced(item.id) } finally { lock.current = false; if (alive.current) setBusy('') } }}>{t('保存到文件夹')}</button>
      <button type="button" className="md-pill" onClick={() => { setPreview(value => !value); clearSelection() }}>{preview ? t('编辑正文') : t('预览正文')}</button>
    </div></header>
    {failed ? <p className="md-aw-error" role="alert">{t('本次操作未完成，输入已保留，可重试。')}</p> : null}
    {conflict ? <p className="md-aw-error" role="alert">{t('其他窗口已修改正文。本地输入已保留，请复制后与最新内容合并。')}</p> : null}
    {waiting ? <p className="md-aw-notice" role="status">{t('正在生成建议，你可以继续编辑正文。')}</p> : null}
    {draft.dirty ? <p className="md-aw-dirty" role="status">{t('有未保存的修改')}</p> : null}
    <div className="md-aw-panel md-document-paper" ref={editor}>
      <Field label="文章标题" value={draft.value.title} onChange={value => updateDraft({ title: value })} />
      {preview ? <div className="md-prose md-aw-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.value.text) }} /> : <label className="md-aw-field md-document-body"><span>{t('文章正文')}</span><textarea ref={input} aria-label={t('文章正文')} rows={22} value={draft.value.text} placeholder={t('在这里写下或粘贴你的文章……')} onChange={event => updateDraft({ text: event.target.value })} onSelect={captureSelection} onMouseUp={captureSelection} onKeyUp={captureSelection} onCompositionStart={() => { composing.current = true; clearSelection() }} onCompositionEnd={event => { composing.current = false; captureSelection(event) }} /></label>}
      {selection && !preview ? <div className="md-selection-tools" role="toolbar" aria-label={t('选中文字操作')} style={{ left: position.x, top: position.y }} onMouseDown={event => event.preventDefault()}>
        <button type="button" disabled={waiting} onClick={() => onAsk()}>{t('让 AI 修改')}</button><button type="button" disabled={waiting} onClick={() => onAsk(t('简化这段文字'))}>{t('简化')}</button><button type="button" disabled={waiting} onClick={() => onAsk(t('扩写这段文字'))}>{t('扩写')}</button><button type="button" disabled={waiting} onClick={() => onAsk(t('润色这段文字'))}>{t('润色')}</button><button type="button" aria-label={t('清除选区')} onClick={clearSelection}>×</button>
      </div> : null}
    </div>
    {pending.length ? <section ref={candidatesRef} className="md-ai-candidates" aria-label={t('待处理建议')}>{pending.map(candidate => candidateCard(candidate))}</section> : null}
    {handled.length ? <details className="md-inline-details"><summary>{t('已处理的建议（{n}）', { n: handled.length })}</summary>{handled.map(candidate => candidateCard(candidate, true))}</details> : null}
    <details className="md-inline-details"><summary>{t('文章配图')}</summary><p className="md-aw-description">{t('配图可选。先按当前正文规划，再明确点击生成；已有文字和图片会保留。')}</p>
      {!settings?.imageReady ? <p className="md-aw-notice">{t('尚未配置生图，文字稿仍可复制或保存。')}<button type="button" className="md-link-btn" onClick={() => setDesk({ settingsOpen: true })}>{t('去接入')}</button></p> : null}
      <div className="md-aw-actions"><button type="button" className="md-pill" disabled={waiting || !hasText} onClick={() => run('plan_images', { flush: true })}>{t('按正文规划配图')}</button><button type="button" className="md-pill is-primary" disabled={waiting || !hasText || draft.dirty || !workspace.imagesPlanned || workspace.imagesStale || !settings?.imageReady} onClick={() => run('generate_images')}>{t('生成文章配图')}</button></div>
      <ImageList production={production} /><VersionHistory workspace={{ ...workspace, candidateHistory: [] }} images />
    </details>
    <VersionHistory workspace={workspace} />
    {hasEarlier ? <details className="md-inline-details"><summary>{t('此前整理的资料与提纲')}</summary>{(earlier.sources || []).map((source, index) => <article className="md-earlier-note" key={source.id || index}><b>{source.title || t('参考资料')}</b>{/^https?:\/\//i.test(source.url || '') ? <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a> : source.url ? <span>{source.url}</span> : null}<pre>{source.text}</pre></article>)}{earlier.point && [earlier.point.thesis, earlier.point.audience, earlier.point.boundary].some(Boolean) ? <article className="md-earlier-note"><b>{t('此前的观点')}</b><pre>{[earlier.point.thesis, earlier.point.audience, earlier.point.boundary].filter(Boolean).join('\n\n')}</pre></article> : null}{earlier.outline?.title || earlier.outline?.text ? <article className="md-earlier-note"><b>{earlier.outline.title || t('文章提纲')}</b><pre>{earlier.outline.text}</pre></article> : null}</details> : null}
  </section>
}
