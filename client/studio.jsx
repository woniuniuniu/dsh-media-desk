import { AccountAssignment } from './accounts.jsx'
// 点开灵感后的工作区：左边对话，右边是一张稿面。稿面的格子一开始就排好，同时开工，一点点长满。
import React from 'react'
import { ChatPanel } from './chat.jsx'
import { downloadCover } from './cover.js'
import { cancelProduce, closeItem, dispatchOps, regenAsset, revealSaved, runProduce, saveProduced, setDesk, toast, useDesk, watchProduction } from './desk.js'
import { plural, t } from './i18n.js'
import { Icon, IconButton } from './ui.jsx'
import { SPRING_SNAP, SPRING_SOFT, STYLE_CATEGORIES, fmtDate, fmtWhen, reducedMotion, renderMarkdown, styleIcon, textLength, toLocalInput } from './util.js'

const isBusy = asset => ['pending', 'running'].includes(asset?.status)

function unescapeJson(text) {
  try {
    return JSON.parse(`"${text}"`)
  } catch {
    return text
  }
}

function AutoText({ value, onCommit, className, label, disabled }) {
  const [draft, setDraft] = React.useState(value ?? '')
  const ref = React.useRef(null)
  React.useEffect(() => setDraft(value ?? ''), [value])
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])
  return (
    <textarea ref={ref} rows={1} aria-label={label} className={className} value={draft} disabled={disabled}
      onChange={e => setDraft(e.target.value)} onBlur={() => { if (draft.trim() && draft !== (value ?? '')) onCommit(draft) }} />
  )
}

function askAbout(label, text = '') {
  setDesk({ chatQuote: { label, text }, studioDock: true })
}

/** 一张图。空的时候只有底色和淡淡的记号，不放文字。 */
function Plate({ asset, paper = false, mark = null, alt = '', onOpen, onRetry }) {
  const status = asset?.status ?? 'idle'
  const clickable = Boolean(asset?.src && onOpen)
  const retry = onRetry && ['failed', 'skipped', 'idle'].includes(status) && !asset?.src
  return (
    <div className={`md-plate ${paper ? 'is-paper' : 'is-wash'} ${clickable ? 'is-clickable' : ''}`} data-status={status} onClick={clickable ? onOpen : undefined} role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined} onKeyDown={clickable ? (event) => { if (event.key === 'Enter') onOpen(event) } : undefined} aria-label={clickable ? t('查看 {name}', { name: alt }).trim() : undefined}>
      {asset?.src ? <img key={asset.src} src={asset.src} alt={alt} draggable={false} /> : mark ? <span className="md-plate-mark" aria-hidden="true">{mark}</span> : null}
      {retry ? <button type="button" className="md-plate-failed" title={asset?.error} onClick={(event) => { event.stopPropagation(); onRetry() }}><Icon name="refresh" size={12} />{status === 'failed' ? t('没画成，重画') : t('画这张')}</button>
        : status === 'failed' ? <span className="md-plate-failed" title={asset.error}><Icon name="refresh" size={12} />{t('没画成')}</span> : null}
    </div>
  )
}

/** 进度：放在对话栏里，像助手在汇报。 */
function ProgressCard({ production, live, settings }) {
  const running = production.status === 'running'
  const ready = settings?.imageReady && production.withImages !== false
  const words = textLength(production.article || live?.text || '')
  const visuals = [production.cover, ...(production.images ?? [])].filter(Boolean)
  const shots = production.shots ?? []
  const count = list => list.filter(a => a.src).length
  const planned = production.stage !== 'brief'
  const steps = [
    { label: t('标题和封面字'), done: planned, active: !planned },
    { label: production.article ? t('脚本 {n} 字', { n: words, s: plural(words, '', 's') }) : words ? t('正在写 {n} 字', { n: words, s: plural(words, '', 's') }) : t('脚本'), done: Boolean(production.article), active: planned && !production.article },
    ...(ready ? [
      { label: t('封面和配图 {done}/{total}', { done: count(visuals), total: visuals.length || 1 + (settings?.imageCount ?? 2) }), done: planned && visuals.length > 0 && !visuals.some(isBusy), active: visuals.some(isBusy) },
      { label: t('分镜 {done}/{total}', { done: count(shots), total: shots.length || settings?.shotCount || 6 }), done: planned && shots.length > 0 && !shots.some(isBusy), active: shots.some(isBusy) },
    ] : []),
  ]
  return (
    <div className="md-progress-card">
      {steps.map((step, index) => (
        <div key={index} className={`md-progress-step ${step.done ? 'is-done' : step.active && running ? 'is-active' : ''}`}>
          <i>{step.done ? <Icon name="check" size={10} stroke={2.6} /> : null}</i>
          <span>{step.active && running ? <span className="md-shimmer">{step.label}</span> : step.label}</span>
        </div>
      ))}
      {running ? <button type="button" className="md-link-btn" onClick={() => cancelProduce(production.id)}>{t('取消')}</button> : null}
    </div>
  )
}

/** 灵感的正文：墙上卡片里看得见的那段，进了工作区也要在。长的先收起几行。 */
function IdeaBody({ item, disabled }) {
  const body = item.body ?? ''
  const long = body.length > 90 || body.split('\n').length > 4
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => setOpen(false), [item.id])
  if (!body) return null
  return (
    <div className="md-idea-body-wrap">
      <div className={`md-idea-body-clip ${long && !open ? 'is-clipped' : ''}`} onFocus={() => setOpen(true)}>
        <AutoText className="md-idea-body" label={t('灵感正文')} value={body} disabled={disabled} onCommit={next => dispatchOps([{ op: 'update_item', id: item.id, body: next }], { label: t('修改正文'), silent: true })} />
      </div>
      {long ? <button type="button" className="md-link-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t('收起') : t('展开全文')}</button> : null}
    </div>
  )
}

const FORMAT_OPTIONS = [
  { id: 'script', label: '脚本', hint: '口播脚本：一句话一行，一段一段' },
  { id: 'article', label: '文章', hint: '文章：一个一个自然段' },
]

/** 对话栏顶部：这条灵感，以及唯一的入口。 */
function IdeaCard({ item, live, settings }) {
  const production = item.production
  const running = production?.status === 'running'
  const styles = useDesk(s => s.state.styles ?? [])
  const activeId = useDesk(s => item.accountId ? s.allState.accounts.find(a=>a.id===item.accountId)?.defaultStyleId : s.allState.activeStyleId)
  const [draw, setDraw] = React.useState(null)
  React.useEffect(() => setDraw(null), [item.id])
  // 单次选择优先，其次沿用这条成稿上次的选择，最后取设置里的默认值
  const withImages = draw ?? (production?.withImages !== undefined ? production.withImages : settings?.generateImages !== false)
  const canStart = !production || !['running', 'done'].includes(production.status)
  const format = useDesk(s => s.allState.accounts.find(a => a.id === item.accountId)?.draftFormat ?? s.allState.draftFormat) === 'article' ? 'article' : 'script'
  return (
    <div className="md-idea-card">
      <span className="md-idea-label">{t('灵感')} · {fmtDate(item.createdAt)}</span>
      <AutoText className="md-idea-text" label={t('灵感')} value={item.title} disabled={running} onCommit={title => dispatchOps([{ op: 'update_item', id: item.id, title }], { label: t('修改灵感'), silent: true })} />
      <AccountAssignment item={item} />
      <IdeaBody item={item} disabled={running} />
      {!running ? (
        <div className="md-style-pick" role="radiogroup" aria-label={t('体裁')}>
          <span>{t('体裁')}</span>
          <div className="md-format-seg">
            {FORMAT_OPTIONS.map(option => (
              <button type="button" key={option.id} role="radio" aria-checked={format === option.id} className={format === option.id ? 'is-on' : ''} title={t(option.hint)}
                onClick={() => { if (format !== option.id) dispatchOps([{ op: 'set_format', format: option.id, accountId: item.accountId ?? null }], { label: t('切换体裁'), silent: true, accountId: item.accountId ?? null }) }}>{t(option.label)}</button>
            ))}
          </div>
        </div>
      ) : null}
      {!running && production?.status === 'done' && (production.format ?? 'script') !== format ? <p className="md-idea-hint">{t('这篇是按另一种体裁写的，重新成稿后生效。')}</p> : null}
      {!running ? (
        <label className="md-style-pick is-follow">
          <span>{t('风格')}</span>
          <select aria-label={t('风格')} value={activeId ?? ''} onChange={e => dispatchOps([{ op: 'set_style', id: e.target.value || null, ...(item.accountId?{accountId:item.accountId}:{}) }], { label: t('切换风格'), silent: true, accountId:item.accountId??undefined })}>
            <option value="">{t('默认')}</option>
            {styles.some(style => !style.preset) ? <optgroup label={t('我的风格')}>{styles.filter(style => !style.preset).map(style => <option key={style.id} value={style.id}>{styleIcon(style)} {style.name}</option>)}</optgroup> : null}
            {STYLE_CATEGORIES.map(name => <optgroup key={name} label={t(name)}>{styles.filter(style => style.preset && style.category === name).map(style => <option key={style.id} value={style.id}>{styleIcon(style)} {style.name}</option>)}</optgroup>)}
          </select>
        </label>
      ) : null}
      {canStart ? (
        <div className="md-go-row">
          <button type="button" className="md-go" onClick={() => runProduce(item.id, { withImages })}>{t('一键成稿')}</button>
          <label className="md-go-option">
            <input type="checkbox" checked={withImages} onChange={e => setDraw(e.target.checked)} />
            {t('生成图片')}
          </label>
        </div>
      ) : null}
      {running ? <ProgressCard production={{ ...production, id: item.id }} live={live} settings={settings} /> : null}
      {production?.status === 'failed' ? <p className="md-idea-hint is-error">{production.error}</p> : null}
      {canStart && !withImages ? <p className="md-idea-hint">{t('这次只出文字版，之后仍可以单张补画。')}</p> : null}
      {canStart && withImages && !settings?.imageReady ? <p className="md-idea-hint">{t('接入生图模型后，封面和分镜也会画好。')}<button type="button" onClick={() => setDesk({ settingsOpen: true })}>{t('去接入')}</button></p> : null}
      {production?.notice ? <p className="md-idea-hint">{production.notice}</p> : null}
    </div>
  )
}

/** 视频封面：画面叠大字。没有画面时是一张渐变的纯文字封面。 */
function Poster({ production, item, onOpen, onRetry }) {
  const src = production?.cover?.src ?? (!production ? item.media?.poster ?? (item.media?.src && item.kind !== 'video' ? item.media.src : null) : null)
  const text = production?.stage === 'brief' ? '' : production?.coverText || production?.title || ''
  const status = production?.cover?.status ?? 'idle'
  return (
    <div className={`md-poster ${src ? '' : 'is-type'}`} data-status={status} onClick={production?.cover?.src ? onOpen : undefined} role={production?.cover?.src ? 'button' : undefined}>
      {src ? <img key={src} src={src} alt={t('视频封面')} draggable={false} /> : null}
      {text ? <b>{text}</b> : null}
      {onRetry && ['failed', 'skipped'].includes(status) ? <button type="button" className="md-plate-failed" title={production?.cover?.error} onClick={(event) => { event.stopPropagation(); onRetry() }}><Icon name="refresh" size={12} />{status === 'failed' ? t('封面没画成，重画') : t('画封面')}</button> : null}
    </div>
  )
}

function Stat({ icon, value, unit }) {
  return <span className="md-hero-stat"><Icon name={icon} size={13} /><b>{value}</b>{unit}</span>
}

/** 主视觉：渐变底、大标题、数字，右边是视频封面和配图的拼贴。 */
function HeroTile({ item, live, onView }) {
  const settings = useDesk(s => s.settings)
  const production = item.production
  const running = production?.status === 'running'
  const liveTitle = production?.stage === 'brief' && live?.title ? unescapeJson(live.title) : null
  const title = liveTitle ?? production?.title ?? item.title
  const words = textLength(production?.article || live?.text || '')
  const shots = production?.shots ?? []
  const seconds = shots.reduce((sum, shot) => sum + (shot.seconds ?? 0), 0)
  const images = production?.images ?? []
  const done = production?.status === 'done'
  const pictures = [production?.cover, ...images].filter(a => a?.src).length
  const showFigures = (settings?.imageReady && production?.withImages !== false) || images.some(a => a?.src)
  const [saving, setSaving] = React.useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(`# ${production.title}\n\n${production.article}`)
    toast(production.format === 'article' ? t('文章已复制') : t('脚本已复制'))
  }
  const save = async () => {
    setSaving(true)
    await saveProduced(item.id)
    setSaving(false)
  }
  const again = () => setDesk({
    dialog: {
      title: t('重新成稿'),
      submitLabel: t('重新生成'),
      initial: { withImages: production?.withImages !== false },
      fields: [
        { name: 'note', label: t('现在的文章、封面和分镜会被替换，也会再消耗一次模型额度。'), type: 'hidden' },
        { name: 'withImages', label: t('同时生成封面、配图和分镜图'), type: 'checkbox' },
      ],
      onSubmit: values => runProduce(item.id, { withImages: values.withImages !== false }),
    },
  })
  const figures = images.length ? images : [null, null].slice(0, settings?.imageCount ?? 2)
  return (
    <section className={`md-tile md-tile-hero ${running ? 'is-running' : ''}`}>
      <div className="md-hero-copy">
        <AutoText className={`md-hero-title ${production ? '' : 'is-idle'}`} label={t('标题')} value={title} disabled={!done} onCommit={next => dispatchOps([{ op: 'update_production', id: item.id, title: next }], { label: t('修改标题'), silent: true })} />
        <div className="md-hero-stats">
          {words ? <Stat icon="pen" value={words} unit={t('字', { s: plural(words, '', 's') })} /> : null}
          {shots.length ? <Stat icon="film" value={shots.length} unit={t('镜', { s: plural(shots.length, '', 's') })} /> : null}
          {seconds ? <Stat icon="clock" value={seconds} unit={t('秒')} /> : null}
          {pictures ? <Stat icon="image" value={pictures} unit={t('张图', { s: plural(pictures, '', 's') })} /> : null}
        </div>
        {done ? (
          <div className="md-hero-actions">
            <button type="button" className="md-pill is-primary" onClick={copy}><Icon name="copy" size={14} />{production?.format === 'article' ? t('复制文章') : t('复制脚本')}</button>
            <button type="button" className="md-pill" onClick={save} disabled={saving}><Icon name="save" size={14} />{saving ? t('保存中…') : t('保存')}</button>
            <button type="button" className="md-pill" onClick={() => downloadCover({ src: production.cover?.src, text: production.coverText || production.title }, production.title).catch(err => toast(err.message, { error: true }))}><Icon name="image" size={14} />{t('下载封面')}</button>
            <label className="md-pill md-date-pill">
              <Icon name="calendar" size={14} />{item.scheduledAt ? fmtWhen(item.scheduledAt) : t('排期')}
              <input type="datetime-local" aria-label={t('排期')} value={toLocalInput(item.scheduledAt)} onClick={(event) => { try { event.currentTarget.showPicker() } catch { /* 不支持时用原生交互 */ } }} onChange={(event) => {
                const when = event.target.value ? new Date(event.target.value).toISOString() : null
                dispatchOps([{ op: 'schedule_item', id: item.id, scheduledAt: when }], { label: t('修改排期'), silent: true })
              }} />
            </label>
          </div>
        ) : null}
      </div>
      <div className="md-collage">
        <div className="md-collage-main"><Poster production={production} item={item} onOpen={() => onView('cover')} onRetry={settings?.imageReady && production?.status === 'done' && production.cover ? () => regenAsset(item.id, 'cover') : undefined} /></div>
        {showFigures ? figures.map((image, i) => <div key={i} className={`md-collage-side is-${i}`}><Plate asset={image} alt={image?.caption ?? t('配图 {n}', { n: i + 1 })} onOpen={image?.src ? () => onView(`image:${i}`) : undefined} onRetry={image && settings?.imageReady && production?.status === 'done' ? () => regenAsset(item.id, `image:${i}`) : undefined} /></div>) : null}
      </div>
      <div className="md-hero-corner">
        {production?.savedAt ? <IconButton icon="folder" label={t('打开保存的文件夹')} onClick={() => revealSaved(item.id)} /> : null}
        {done ? <IconButton icon="refresh" label={t('重新成稿')} onClick={again} /> : null}
        <IconButton icon="gear" label={t('设置')} onClick={() => setDesk({ settingsOpen: true })} />
        <IconButton icon="trash" label={t('删除这条灵感')} onClick={() => {
          dispatchOps([{ op: 'delete_item', id: item.id }], { label: t('删除《{title}》', { title: item.title.slice(0, 10) }) })
          closeItem()
        }} />
      </div>
    </section>
  )
}

/** 把配图插回文章：优先放到对应小标题那一节的末尾。 */
function ArticleBody({ production, text, onView, proseClass = 'md-prose' }) {
  const sections = React.useMemo(() => text.split(/\n(?=##\s)/).map(part => ({ text: part, heading: /^##\s+(.+)/.exec(part)?.[1]?.trim() ?? '' })), [text])
  const images = production?.images ?? []
  const placed = React.useMemo(() => {
    const map = new Map()
    images.forEach((image, i) => {
      if (!image.src) return
      let at = sections.findIndex(s => image.anchor && s.heading === image.anchor)
      if (at < 0) at = Math.min(sections.length - 1, Math.round(((i + 1) * sections.length) / (images.length + 1)))
      if (!map.has(at)) map.set(at, [])
      map.get(at).push({ image, i })
    })
    return map
  }, [images, sections])
  return (
    <div className="md-article">
      {sections.map((section, index) => (
        <React.Fragment key={index}>
          {/* renderMarkdown 会先转义，模型输出里的 HTML 不会执行 */}
          <div className={proseClass} dangerouslySetInnerHTML={{ __html: renderMarkdown(section.text) }} />
          {(placed.get(index) ?? []).map(({ image, i }) => (
            <figure key={i} className="md-article-figure">
              <Plate asset={image} alt={image.caption} onOpen={() => onView(`image:${i}`)} />
              {image.caption ? <figcaption>{image.caption}</figcaption> : null}
            </figure>
          ))}
        </React.Fragment>
      ))}
    </div>
  )
}

function ArticleTile({ item, live, open, onToggle, onView, tileRef }) {
  const production = item.production
  const running = production?.status === 'running'
  const scroller = React.useRef(null)
  const [editing, setEditing] = React.useState(false)
  const [picked, setPicked] = React.useState(null)
  const article = production?.article ?? ''
  const [draft, setDraft] = React.useState(article)
  React.useEffect(() => setDraft(article), [article])
  const text = article || (live?.text ?? '').replace(/^\s*#\s+.*\n?/, '')
  const streaming = running && !article
  React.useEffect(() => {
    if (streaming && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [text, streaming])
  // 写完之后回到开头，从第一句读起
  React.useEffect(() => {
    if (article && scroller.current) scroller.current.scrollTop = 0
  }, [Boolean(article)]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    if (draft !== article) dispatchOps([{ op: 'update_production', id: item.id, article: draft }], { label: t('修改文章'), silent: true })
    setEditing(false)
  }
  const copy = async () => {
    await navigator.clipboard.writeText(`# ${production?.title || item.title}\n\n${article}`)
    toast(production?.format === 'article' ? t('文章已复制') : t('脚本已复制'))
  }
  // 选中一段，交给助手改
  const onMouseUp = () => {
    const selection = window.getSelection()
    const value = selection?.toString().trim()
    if (!value || value.length < 4 || !article || !scroller.current?.contains(selection.anchorNode)) {
      setPicked(null)
      return
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    const box = tileRef.current.getBoundingClientRect()
    setPicked({ text: value, x: Math.max(70, Math.min(rect.left - box.left + rect.width / 2, box.width - 70)), y: rect.top - box.top })
  }
  const words = textLength(text)
  // 正在写和写好的稿子看它自己的体裁；还没写的看当前选的
  const chosen = useDesk(s => s.allState.accounts.find(a => a.id === item.accountId)?.draftFormat ?? s.allState.draftFormat)
  const isArticle = (production?.format ?? chosen) === 'article'
  const name = isArticle ? t('文章') : t('脚本')
  const heading = production?.title || item.title
  const proseClass = `md-prose ${isArticle ? 'is-article' : 'is-script'}`
  return (
    <>
      <header className="md-tile-head">
        <h2>{name}</h2>
        <span className="md-grow" />
        {article ? (
          <>
            {editing ? <button type="button" className="md-btn is-small" onClick={save}><Icon name="check" size={13} />{t('完成')}</button> : <IconButton icon="edit" label={t('直接修改')} onClick={() => setEditing(true)} />}
            <IconButton icon="copy" label={isArticle ? t('复制文章') : t('复制脚本')} onClick={copy} />
            <IconButton icon={open ? 'close' : 'expand'} label={open ? t('收起') : t('放大阅读')} onClick={onToggle} />
          </>
        ) : null}
      </header>
      {editing ? (
        <textarea className="md-article-edit" aria-label={name} value={draft} onChange={e => setDraft(e.target.value)} onBlur={save} />
      ) : text ? (
        <div className="md-article-scroll" ref={scroller} onMouseUp={onMouseUp} onScroll={() => setPicked(null)}>
          <h1 className="md-article-title">{heading}</h1>
          {open ? <ArticleBody production={production} text={text} onView={onView} proseClass={proseClass} /> : <div className={proseClass} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
        </div>
      ) : (
        <div className={`md-skeleton ${running ? '' : 'is-still'}`} aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} />)}</div>
      )}
      {picked ? (
        <button type="button" className="md-pick" style={{ left: picked.x, top: picked.y }} onMouseDown={e => e.preventDefault()} onClick={() => {
          askAbout(t('这段'), picked.text)
          setPicked(null)
          window.getSelection()?.removeAllRanges()
        }}><Icon name="chat" size={12} />{t('让助手改这段')}</button>
      ) : null}
      {words && streaming ? <span className="md-tile-foot">{t('{n} 字', { n: words, s: plural(words, '', 's') })}</span> : null}
    </>
  )
}

function ShotsTile({ item, live, count, open, onToggle, onView }) {
  const imageReady = useDesk(s => s.settings?.imageReady)
  const shots = item.production?.shots ?? []
  const visuals = live?.visuals ?? []
  // 策划案还在写的时候，分镜说明已经一格一格出现了
  const cells = shots.length ? shots : Array.from({ length: count }, (_, i) => ({ no: i + 1, visual: visuals[i] ? unescapeJson(visuals[i]) : '', status: item.production?.status === 'running' ? 'pending' : 'idle' }))
  const copy = async () => {
    const table = shots.map((s, i) => t('{no}. {shot}｜{sec} 秒\n画面：{visual}\n口播：{voice}', { no: i + 1, shot: t(s.shot), sec: s.seconds, visual: s.visual, voice: s.voice })).join('\n\n')
    await navigator.clipboard.writeText(table)
    toast(t('分镜脚本已复制'))
  }
  const total = shots.reduce((sum, shot) => sum + (shot.seconds ?? 0), 0)
  return (
    <>
      <header className="md-tile-head">
        <h2>{t('分镜头脚本')}</h2>
        {total ? <span className="md-tile-meta">{t('约 {n} 秒', { n: total })}</span> : null}
        <span className="md-grow" />
        {shots.length ? (
          <>
            <IconButton icon="copy" label={t('复制分镜脚本')} onClick={copy} />
            <IconButton icon={open ? 'close' : 'expand'} label={open ? t('收起') : t('放大')} onClick={onToggle} />
          </>
        ) : null}
      </header>
      <div className="md-shots" style={{ '--rows2': Math.ceil(cells.length / 2), '--rows3': Math.ceil(cells.length / 3) }}>
        {cells.map((shot, index) => (
          <figure key={index} className="md-shot">
            <Plate asset={shot} paper alt={shot.visual} mark={String(shot.no ?? index + 1).padStart(2, '0')} onOpen={shot.src ? () => onView(`shot:${index}`) : undefined} onRetry={imageReady && item.production?.status === 'done' && shot.prompt !== undefined ? () => regenAsset(item.id, `shot:${index}`) : undefined} />
            <figcaption>
              <span className="md-shot-meta"><b>{String(shot.no ?? index + 1).padStart(2, '0')}</b>{shot.shot ? ` ${t(shot.shot)} · ${t('{n} 秒', { n: shot.seconds })}` : ''}</span>
              <p>{shot.voice || shot.visual}</p>
            </figcaption>
          </figure>
        ))}
      </div>
    </>
  )
}

function assetList(production) {
  return [
    ...(production?.cover?.src || production?.cover ? [{ target: 'cover', asset: production.cover, label: t('视频封面') }] : []),
    ...(production?.images ?? []).map((asset, i) => ({ target: `image:${i}`, asset, label: t('配图 {n}', { n: i + 1 }), note: asset.caption })),
    ...(production?.shots ?? []).map((asset, i) => ({ target: `shot:${i}`, asset, label: t('第 {n} 镜', { n: i + 1 }), note: [asset.visual, asset.voice].filter(Boolean).join(' · '), paper: true })),
  ]
}

/** 查看大图：左右键切换，可以重画、下载，或者让助手改。 */
function Viewer({ item, target, onChange, onClose }) {
  const imageReady = useDesk(s => s.settings?.imageReady)
  const list = assetList(item.production).filter(row => row.asset?.src || isBusy(row.asset))
  const index = Math.max(0, list.findIndex(row => row.target === target))
  const current = list[index]
  const ref = React.useRef(null)
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
      if (event.key === 'ArrowRight' && list[index + 1]) onChange(list[index + 1].target)
      if (event.key === 'ArrowLeft' && list[index - 1]) onChange(list[index - 1].target)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, list, onChange, onClose])
  React.useLayoutEffect(() => {
    if (reducedMotion()) return
    ref.current?.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: SPRING_SNAP.duration, easing: SPRING_SNAP.easing })
  }, [])
  if (!current) return null
  return (
    <div className="md-viewer" role="dialog" aria-label={current.label} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="md-viewer-card" ref={ref}>
        <div className={`md-viewer-image ${current.paper ? 'is-paper' : ''}`}>
          {current.asset.src ? <img key={current.asset.src} src={current.asset.src} alt={current.label} /> : null}
          {isBusy(current.asset) ? <span className="md-viewer-busy"><span className="md-shimmer">{t('正在重画…')}</span></span> : null}
        </div>
        <footer>
          <div className="md-viewer-text"><b>{current.label}</b>{current.note ? <span>{current.note}</span> : null}</div>
          <IconButton icon="chevL" label={t('上一张')} disabled={!list[index - 1]} onClick={() => list[index - 1] && onChange(list[index - 1].target)} />
          <IconButton icon="chevR" label={t('下一张')} disabled={!list[index + 1]} onClick={() => list[index + 1] && onChange(list[index + 1].target)} />
          <button type="button" className="md-pill" onClick={() => { askAbout(current.label); onClose() }}><Icon name="chat" size={13} />{t('让助手改')}</button>
          {imageReady ? <button type="button" className="md-pill" disabled={isBusy(current.asset)} onClick={() => regenAsset(item.id, current.target)}><Icon name="refresh" size={13} />{t('重画')}</button> : null}
          {current.asset.src ? <a className="md-pill" href={current.asset.src} download><Icon name="save" size={13} />{t('下载')}</a> : null}
          <IconButton icon="close" label={t('关闭')} onClick={onClose} />
        </footer>
      </div>
    </div>
  )
}

function Sheet({ item, live }) {
  const settings = useDesk(s => s.settings)
  const [open, setOpen] = React.useState(null)
  const [viewing, setViewing] = React.useState(null)
  const bento = React.useRef(null)
  const tiles = React.useRef({})
  const articleRef = React.useRef(null)
  const origin = React.useRef(null)
  const closing = React.useRef(false)

  const expand = (name) => {
    const box = bento.current.getBoundingClientRect()
    const rect = tiles.current[name].getBoundingClientRect()
    origin.current = { left: `${rect.left - box.left}px`, top: `${rect.top - box.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }
    setOpen(name)
  }
  const collapse = React.useCallback(() => {
    setOpen((name) => {
      if (!name || closing.current) return name
      const el = tiles.current[name]
      if (reducedMotion() || !el || !origin.current) return null
      closing.current = true
      const box = bento.current.getBoundingClientRect()
      const animation = el.animate([{ left: '0px', top: '0px', width: `${box.width}px`, height: `${box.height}px` }, origin.current], { duration: SPRING_SNAP.duration, easing: SPRING_SNAP.easing, fill: 'forwards' })
      animation.onfinish = () => {
        closing.current = false
        animation.cancel()
        setOpen(null)
      }
      return name
    })
  }, [])
  const toggle = name => (open === name ? collapse() : expand(name))

  // 格子从原位放大到铺满
  React.useLayoutEffect(() => {
    if (!open || reducedMotion()) return
    const box = bento.current.getBoundingClientRect()
    tiles.current[open]?.animate([origin.current, { left: '0px', top: '0px', width: `${box.width}px`, height: `${box.height}px` }], { duration: SPRING_SOFT.duration, easing: SPRING_SOFT.easing })
  }, [open])

  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape' && !viewing) {
        event.preventDefault()
        collapse()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, viewing, collapse])

  const tile = name => ({
    ref: (el) => {
      tiles.current[name] = el
      if (name === 'article') articleRef.current = el
    },
    className: `md-tile md-tile-${name} ${open === name ? 'is-open' : ''}`,
  })
  return (
    <div className="md-sheet">
      <div className={`md-bento ${open ? 'has-open' : ''}`} ref={bento}>
        <HeroTile item={item} live={live} onView={setViewing} />
        <section {...tile('article')}>
          <ArticleTile item={item} live={live} open={open === 'article'} onToggle={() => toggle('article')} onView={setViewing} tileRef={articleRef} />
        </section>
        <section {...tile('shots')}>
          <ShotsTile item={item} live={live} count={settings?.shotCount ?? 6} open={open === 'shots'} onToggle={() => toggle('shots')} onView={setViewing} />
        </section>
      </div>
      {viewing ? <Viewer item={item} target={viewing} onChange={setViewing} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}

const DONE_SUGGESTIONS = ['标题再短一点', '语气轻松一点', '开场再抓人一点', '封面大字更有冲击力']

export function Studio() {
  const id = useDesk(s => s.focusId)
  const item = useDesk(s => s.state?.items.find(i => i.id === s.focusId))
  const origin = useDesk(s => s.sheetOrigin)
  const live = useDesk(s => s.live[s.focusId])
  const settings = useDesk(s => s.settings)
  const chatOpen = useDesk(s => s.studioDock)
  const ref = React.useRef(null)
  const production = item?.production
  const running = production?.status === 'running'
  const watching = running || [production?.cover, ...(production?.images ?? []), ...(production?.shots ?? [])].some(isBusy)

  React.useEffect(() => {
    if (id && watching) return watchProduction(id)
    return undefined
  }, [id, watching])

  // 从卡片的位置展开成整个工作区
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!id || !el || reducedMotion()) return
    if (origin) {
      const box = el.getBoundingClientRect()
      const inset = `inset(${origin.y - box.top}px ${box.right - origin.x - origin.w}px ${box.bottom - origin.y - origin.h}px ${origin.x - box.left}px round 20px)`
      el.animate([{ clipPath: inset }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }], { duration: SPRING_SOFT.duration, easing: SPRING_SOFT.easing })
    } else {
      el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'ease-out' })
    }
    // 只在切换灵感时播放
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  React.useEffect(() => {
    if (!id) return undefined
    const onKey = (event) => {
      // 有格子放大或大图打开时，Esc 只收回它们
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.md-tile.is-open,.md-viewer') && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) closeItem()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id])

  // 打开的这条被删掉或撤销掉时，退回灵感墙，不留空白页
  React.useEffect(() => { if (id && !item) closeItem() }, [id, item])
  if (!item) return null
  return (
    <div className={`md-studio ${chatOpen ? 'chat-open' : ''}`} ref={ref} role="dialog" aria-label={t('灵感')}>
      <div className="md-studio-chat">
        <ChatPanel
          itemId={item.id}
          head={(
            <>
              <IconButton icon="chevL" label={t('返回灵感')} onClick={closeItem} />
              <h2>{t('成稿')}</h2>
            </>
          )}
          top={<IdeaCard item={item} live={live} settings={settings} />}
          suggestions={production?.status === 'done' ? DONE_SUGGESTIONS.map(row => t(row)) : []}
          placeholder={running ? t('正在成稿，马上就好') : production?.status === 'done' ? t('想怎么改，直接说') : t('补充点想法，或者直接说要什么')}
          disabled={running}
          intro={false}
        />
      </div>
      <button type="button" className="md-chat-toggle" aria-label={t('打开对话')} onClick={() => setDesk(s => ({ studioDock: !s.studioDock }))}><Icon name="chat" size={16} /></button>
      <Sheet key={item.id} item={item} live={live} />
    </div>
  )
}
