// 文章是先核对资料、确认观点和提纲，再写作的独立工作区。
import React from 'react'
import { articleWorkspace, productionFor } from '../src/workflow.js'
import { articleAction, fetchArticleWorkflow, loadDesk, saveProduced, setDesk, toast, useDesk } from './desk.js'
import { t } from './i18n.js'
import { Icon } from './ui.jsx'
import { renderMarkdown } from './util.js'

const STEPS = [
  { id: 'sources', label: '资料与出处' },
  { id: 'point', label: '明确观点' },
  { id: 'outline', label: '确认提纲' },
  { id: 'writing', label: '写作修改' },
  { id: 'images', label: '配图' },
]
const clone = value => JSON.parse(JSON.stringify(value))

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

export function ArticleWorkflow({ item, onDirty = () => {}, onBusy = () => {} }) {
  const workspace = articleWorkspace(item)
  const production = productionFor(item, 'article')
  const settings = useDesk(state => state.settings)
  const items = useDesk(state => state.state.items)
  const serverAction = useDesk(state => state.articleBusy?.[item.id])
  const sources = useEditable(workspace.sources || [])
  const point = useEditable(workspace.point || { thesis: '', audience: '', boundary: '' })
  const outline = useEditable(workspace.outline || { title: '', text: '' })
  const draft = useEditable({ title: production?.title || item.title || '', text: production?.article || '' })
  const [active, setActive] = React.useState(workspace.stage || 'sources')
  const [busy, setBusy] = React.useState('')
  const [remoteBusy, setRemoteBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const [reference, setReference] = React.useState('')
  const lock = React.useRef(false)
  const alive = React.useRef(true)
  const previousStage = React.useRef(workspace.stage)
  const dirty = sources.dirty || point.dirty || outline.dirty || draft.dirty
  const assetBusy = [production?.cover, ...(production?.images || [])].some(image => ['pending', 'running'].includes(image?.status))
  const waiting = Boolean(busy || serverAction || remoteBusy || assetBusy)
  const sourcesReady = workspace.sourcesConfirmed && !sources.dirty
  const pointReady = sourcesReady && workspace.pointConfirmed && !point.dirty
  const outlineReady = pointReady && workspace.outlineConfirmed && !outline.dirty
  const hasDraft = Boolean(draft.value.text.trim())
  const hasImages = Boolean(production?.cover || production?.images?.length)
  const canPlan = workspace.draftFinalized && !workspace.draftStale && !dirty
  const canGenerate = canPlan && workspace.imagesPlanned && !workspace.imagesStale

  React.useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  React.useEffect(() => { onBusy(waiting); return () => onBusy(false) }, [waiting, onBusy])
  React.useEffect(() => {
    if (workspace.stage !== previousStage.current) setActive(workspace.stage)
    previousStage.current = workspace.stage
  }, [workspace.stage])
  React.useEffect(() => {
    alive.current = true
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
    return () => { stopped = true; alive.current = false; clearTimeout(timer) }
  }, [item.id])

  const perform = async steps => {
    if (lock.current || waiting) return false
    lock.current = true
    setBusy(steps.at(-1).action)
    setFailed(false)
    let revision = workspace.revision
    try {
      let last = null
      for (const step of steps) {
        const result = await articleAction(item.id, step.action, step.data || {}, revision)
        if (!result) { if (alive.current) setFailed(true); return false }
        last = result
        revision = result.workflow.revision
        if (!alive.current) continue
        const row = result.state?.items?.find(entry => entry.id === item.id)
        if (step.action === 'save_sources') sources.accept(result.workflow.sources)
        if (step.action === 'save_point' || step.action === 'suggest_point') point.accept(result.workflow.point)
        if (step.action === 'save_outline' || step.action === 'suggest_outline') outline.accept(result.workflow.outline)
        if (step.action === 'save_draft' || step.action === 'write') draft.accept({ title: row?.production?.title || draft.value.title, text: row?.production?.article ?? step.data?.text ?? draft.value.text })
      }
      if (alive.current && last?.workflow.stage) setActive(last.workflow.stage)
      return last
    } finally { lock.current = false; if (alive.current) setBusy('') }
  }
  const saveSources = { action: 'save_sources', data: { sources: sources.value } }
  const savePoint = { action: 'save_point', data: point.value }
  const saveOutline = { action: 'save_outline', data: outline.value }
  const saveDraft = { action: 'save_draft', data: draft.value }
  const saveAll = () => {
    const steps = [sources.dirty && saveSources, point.dirty && savePoint, outline.dirty && saveOutline, draft.dirty && saveDraft].filter(Boolean)
    if (steps.length) perform(steps)
  }
  const changeSource = (id, patch) => sources.change(sources.value.map(source => source.id === id ? { ...source, ...patch, ...('verified' in patch ? {} : { verified: false }) } : source))
  const addSource = (row = {}) => sources.change([...sources.value, { id: `source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, title: '', url: '', text: '', kind: 'reference', verified: false, ...row }])
  const allowed = { sources: true, point: sourcesReady, outline: pointReady, writing: outlineReady || hasDraft, images: canPlan || hasImages }
  const copy = async () => { try { await navigator.clipboard.writeText(`# ${draft.value.title}\n\n${draft.value.text}`); toast(t('文章已复制')) } catch (error) { toast(error.message, { error: true }) } }

  return <section className="md-article-workflow" aria-label={t('文章流程')} aria-busy={waiting}>
    <header className="md-aw-heading"><div><span className="md-idea-label">{t('文章流程')}</span><h1>{item.title || t('文章')}</h1></div><div className="md-aw-actions"><button type="button" className="md-pill" onClick={saveAll} disabled={!dirty || waiting}>{t('保存修改')}</button>{hasDraft ? <button type="button" className="md-pill" onClick={copy} disabled={waiting}>{t('复制文章')}</button> : null}{hasDraft && !dirty ? <button type="button" className="md-pill" disabled={waiting} onClick={async () => { if (lock.current) return; lock.current = true; setBusy('export'); try { await saveProduced(item.id) } finally { lock.current = false; if (alive.current) setBusy('') } }}>{t('保存到文件夹')}</button> : null}</div></header>
    <nav className="md-aw-steps" aria-label={t('文章步骤')}>{STEPS.map((step, index) => <button type="button" key={step.id} aria-current={active === step.id ? 'step' : undefined} disabled={waiting || !allowed[step.id]} onClick={() => setActive(step.id)}><span>{index + 1}</span>{t(step.label)}</button>)}</nav>
    {workspace.legacy ? <p className="md-aw-notice">{t('旧文章已保留，可直接修改正文或确认后配图。资料、观点和提纲仍需分别确认。')}</p> : null}
    {workspace.draftStale ? <p className="md-aw-notice">{t('上游内容已改动，旧正文与图片仍保留。请重新确认后生成新稿，或保存当前正文并定稿。')}</p> : null}
    {failed ? <p className="md-aw-error" role="alert">{t('本次操作未完成，输入已保留，可重试。')}</p> : null}
    {waiting ? <p className="md-aw-notice" role="status">{t('正在处理，请稍候……')}</p> : null}
    {dirty ? <p className="md-aw-dirty" role="status">{t('有未保存的修改')}</p> : null}

    {active === 'sources' ? <div className="md-aw-panel">
      <h2>{t('资料与出处')}</h2><p className="md-aw-description">{t('贴入可追溯的原文、来源链接或亲身经验；标明哪些已经人工核对。')}</p>
      {sources.value.map((source, index) => <fieldset key={source.id} className="md-aw-source" disabled={waiting}><legend>{t('资料 {n}', { n: index + 1 })}</legend>
        <div className="md-aw-two"><Field label="资料名称" value={source.title} onChange={value => changeSource(source.id, { title: value })} /><label className="md-aw-field"><span>{t('资料类型')}</span><select aria-label={t('资料类型')} value={source.kind} onChange={event => changeSource(source.id, { kind: event.target.value })}><option value="reference">{t('参考资料')}</option><option value="personal">{t('本人经验')}</option></select></label></div>
        <Field label="来源链接" type="url" value={source.url} onChange={value => changeSource(source.id, { url: value })} placeholder="https://" />
        <Field label="原文或经验记录" multiline rows={5} value={source.text} onChange={value => changeSource(source.id, { text: value })} />
        <div className="md-aw-actions"><label className="md-check"><input type="checkbox" checked={Boolean(source.verified)} onChange={event => changeSource(source.id, { verified: event.target.checked })} />{t('我已人工核对这条资料')}</label><button type="button" className="md-link-btn" onClick={() => sources.change(sources.value.filter(row => row.id !== source.id))}>{t('移除资料')}</button></div>
      </fieldset>)}
      <div className="md-aw-actions"><button type="button" className="md-pill" disabled={waiting} onClick={() => addSource()}>{t('添加资料')}</button><label className="md-aw-reference"><span>{t('从灵感引用')}</span><select aria-label={t('从灵感引用')} disabled={waiting} value={reference} onChange={event => setReference(event.target.value)}><option value="">{t('选择已有灵感')}</option>{items.filter(row => row.id !== item.id).map(row => <option key={row.id} value={row.id}>{row.title || row.id}</option>)}</select></label><button type="button" className="md-pill" disabled={!reference || waiting} onClick={() => { const row = items.find(entry => entry.id === reference); if (row) addSource({ title: row.title || '', text: row.body || '', url: row.url || '' }); setReference('') }}>{t('加入资料')}</button></div>
      <footer className="md-aw-actions"><button type="button" className="md-pill" disabled={waiting} onClick={() => perform([saveSources])}>{t('保存资料')}</button><button type="button" className="md-pill is-primary" disabled={waiting || !sources.value.some(row => row.text?.trim())} onClick={() => perform([saveSources, { action: 'confirm_sources' }])}>{t('确认资料，进入观点')}</button></footer>
    </div> : null}

    {active === 'point' ? <div className="md-aw-panel"><h2>{t('明确观点')}</h2><p className="md-aw-description">{t('先确定这篇文章要表达什么、写给谁，以及哪些话不该说过头。')}</p>
      <Field label="核心观点" multiline rows={4} value={point.value.thesis} disabled={waiting} onChange={value => point.change({ ...point.value, thesis: value })} />
      <Field label="目标读者" value={point.value.audience} disabled={waiting} onChange={value => point.change({ ...point.value, audience: value })} />
      <Field label="适用边界" multiline rows={3} value={point.value.boundary} disabled={waiting} onChange={value => point.change({ ...point.value, boundary: value })} />
      <footer className="md-aw-actions"><button type="button" className="md-pill" disabled={waiting} onClick={() => perform([savePoint])}>{t('保存观点')}</button><button type="button" className="md-pill" disabled={waiting || !sourcesReady} onClick={() => perform([...(point.dirty ? [savePoint] : []), { action: 'suggest_point' }])}>{t('请 AI 建议观点')}</button><button type="button" className="md-pill is-primary" disabled={waiting || !sourcesReady || !point.value.thesis?.trim()} onClick={() => perform([savePoint, { action: 'confirm_point' }])}>{t('确认观点，进入提纲')}</button></footer>
    </div> : null}

    {active === 'outline' ? <div className="md-aw-panel"><h2>{t('确认提纲')}</h2><p className="md-aw-description">{t('检查各段要解决的问题、使用的证据和论述顺序，再开始写全文。')}</p>
      <Field label="文章标题" value={outline.value.title} disabled={waiting} onChange={value => outline.change({ ...outline.value, title: value })} />
      <Field label="文章提纲" multiline rows={12} value={outline.value.text} disabled={waiting} onChange={value => outline.change({ ...outline.value, text: value })} />
      <footer className="md-aw-actions"><button type="button" className="md-pill" disabled={waiting} onClick={() => perform([saveOutline])}>{t('保存提纲')}</button><button type="button" className="md-pill" disabled={waiting || !pointReady} onClick={() => perform([...(outline.dirty ? [saveOutline] : []), { action: 'suggest_outline' }])}>{t('请 AI 建议提纲')}</button><button type="button" className="md-pill is-primary" disabled={waiting || !pointReady || !outline.value.title?.trim() || !outline.value.text?.trim()} onClick={() => perform([saveOutline, { action: 'confirm_outline' }])}>{t('确认提纲，进入写作')}</button></footer>
    </div> : null}

    {active === 'writing' ? <div className="md-aw-panel"><div className="md-aw-panel-head"><h2>{t('写作修改')}</h2><button type="button" className="md-pill" onClick={() => setPreview(value => !value)}>{preview ? t('编辑正文') : t('预览正文')}</button></div>
      <p className="md-aw-description">{outlineReady ? t('提纲已确认，可以生成初稿，再按你的判断修改。') : t('已有正文可以继续修改；新的 AI 全文需先确认资料、观点和提纲。')}</p>
      <Field label="文章标题" value={draft.value.title} disabled={waiting} onChange={value => draft.change({ ...draft.value, title: value })} />
      {preview ? <div className="md-prose md-aw-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.value.text) }} /> : <Field label="文章正文" multiline rows={20} value={draft.value.text} disabled={waiting} onChange={value => draft.change({ ...draft.value, text: value })} />}
      <footer className="md-aw-actions"><button type="button" className="md-pill" disabled={waiting || !outlineReady || draft.dirty} onClick={() => perform([{ action: 'write' }])}>{hasDraft ? t('按确认提纲重新写作') : t('按确认提纲生成初稿')}</button><button type="button" className="md-pill" disabled={waiting || !hasDraft} onClick={() => perform([saveDraft])}>{t('保存正文')}</button><button type="button" className="md-pill is-primary" disabled={waiting || !hasDraft || sources.dirty || point.dirty || outline.dirty} onClick={() => perform([saveDraft, { action: 'finalize' }])}>{t('确认正文，进入配图')}</button></footer>
      {hasImages ? <details className="md-aw-retained"><summary>{t('保留的配图')}</summary><ImageList production={production} /></details> : null}
    </div> : null}

    {active === 'images' ? <div className="md-aw-panel"><h2>{t('配图')}</h2><p className="md-aw-description">{t('只按已确认的正文规划文章封面和配图，再由你明确点击生成。文字稿可以单独完成。')}</p>
      {!canPlan ? <p className="md-aw-notice">{t('正文尚未定稿或已经改动，请先保存并确认正文。原有图片仍然保留。')}</p> : null}
      {!settings?.imageReady ? <p className="md-aw-notice">{t('尚未配置生图，文字稿仍可复制或保存。')}<button type="button" className="md-link-btn" onClick={() => setDesk({ settingsOpen: true })}>{t('去接入')}</button></p> : null}
      <div className="md-aw-actions"><button type="button" className="md-pill" disabled={waiting || !canPlan} onClick={() => perform([{ action: 'plan_images' }])}>{t('按定稿规划配图')}</button><button type="button" className="md-pill is-primary" disabled={waiting || !canGenerate || !settings?.imageReady} onClick={() => perform([{ action: 'generate_images' }])}>{t('生成文章配图')}</button><button type="button" className="md-pill" disabled={waiting || !hasDraft || dirty} onClick={copy}>{t('完成文字稿')}</button></div>
      <ImageList production={production} />
    </div> : null}
    <VersionHistory workspace={workspace} images={active === 'images'} />
  </section>
}
