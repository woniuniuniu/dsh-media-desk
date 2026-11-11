// 收件箱：今天的成稿状态、待处理的候选稿、手动素材。
import React from 'react'
import { composeNote, dispatchOps, reviseCandidate, runCompose, toast, useDesk } from './desk.js'
import { compact, composeStatus, dayKey, fmtDate, fmtTime, t, tweetLength } from './util.js'
import { Dialog, Empty, Icon } from './ui.jsx'

const PLACEHOLDER = '【此处填你的经历】'
const MAX_TWEET = 280
const STATUS_LABEL = { approved: '已通过', discarded: '已丢掉', sent: '已发出', expired: '已过期' }
const DISCARD_REASONS = [
  { reason: 'not_interested', label: '不感兴趣' },
  { reason: 'not_me', label: '写得不像我' },
  { reason: 'stale', label: '过时了' },
]

const fmtStamp = iso => `${fmtDate(iso)} ${fmtTime(iso)}`

function sortPending(candidates) {
  return candidates
    .filter(row => row.status === 'pending')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(b.createdAt).localeCompare(String(a.createdAt)))
}

function StatusBar() {
  const runs = useDesk(s => s.state.runs)
  const candidates = useDesk(s => s.state.candidates)
  const composeAt = useDesk(s => s.settings?.composeAt ?? '07:00')
  const [running, setRunning] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const status = composeStatus(runs, composeAt, new Date())
  const failed = status.kind === 'failed'
  let text
  if (status.kind === 'empty') text = t('今天没有新素材')
  else if (status.kind === 'done') text = t('今天 {time} 已出 {n} 条', { time: status.at ? fmtTime(status.at) : composeAt, n: candidates.filter(row => dayKey(row.createdAt) === dayKey(new Date())).length })
  else if (failed) text = t('今天成稿失败：{error}', { error: status.error })
  else text = t('今天还没到成稿时间（{time}）', { time: composeAt })

  const run = async (force) => {
    setConfirming(false)
    setRunning(true)
    const result = await runCompose({ force })
    setRunning(false)
    if (!result) return
    if (result.conflict) setConfirming(true)
    else if (result.error) toast(result.error, { error: true })
    else toast(t('出了 {n} 条', { n: result.created }))
  }

  return (
    <section className="md-inbox-status" aria-label={t('今天的成稿状态')}>
      <p className={failed ? 'is-failed' : ''} role="status">{running ? t('正在出稿，需要几十秒…') : text}</p>
      {failed && !running ? <button type="button" className="md-btn is-small" onClick={() => run(false)}>{t('重试')}</button> : null}
      <button type="button" className="md-btn" disabled={running} onClick={() => run(false)}>
        <Icon name="bolt" size={14} />{running ? t('出稿中…') : t('现在就出一批')}
      </button>
      {confirming ? (
        <Dialog title={t('再出一批？')} onClose={() => setConfirming(false)}>
          <p className="md-muted">{t('今天已经出过一批了，再出一批吗？')}</p>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setConfirming(false)}>{t('取消')}</button>
            <button type="button" className="md-btn is-primary" onClick={() => run(true)}>{t('再出一批')}</button>
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}

function Notices() {
  const notices = useDesk(s => s.state.runs.notices) ?? []
  if (!notices.length) return null
  return (
    <details className="md-inbox-fold">
      <summary>{t('{n} 条提示', { n: notices.length })}</summary>
      <ul>
        {[...notices].sort((a, b) => String(b.at).localeCompare(String(a.at))).map(row => (
          <li key={row.id}><time>{fmtStamp(row.at)}</time><span>{row.text}</span></li>
        ))}
      </ul>
    </details>
  )
}

function Sources({ candidate }) {
  const posts = useDesk(s => s.state.posts)
  const notes = useDesk(s => s.state.notes)
  const rows = (candidate.sourcePostIds ?? []).map(id => posts.find(post => post.id === id)).filter(Boolean)
  const note = candidate.sourceNoteId ? notes.find(row => row.id === candidate.sourceNoteId) : null
  if (!rows.length && !note) return null
  return (
    <details className="md-inbox-fold">
      <summary>{t('素材')}</summary>
      <ul className="md-inbox-sources">
        {rows.map(post => (
          <li key={post.id}>
            <b>@{post.handle}</b>
            <p>{post.text}</p>
            <small>
              {t('赞 {likes} · 回复 {replies} · 转发 {reposts}', { likes: compact(post.likes), replies: compact(post.replies), reposts: compact(post.reposts) })}
              {post.url ? <> · <a href={post.url} target="_blank" rel="noopener noreferrer">{t('原帖')}</a></> : null}
            </small>
          </li>
        ))}
        {note ? <li><b>{t('我的笔记')}</b><p>{note.text}</p></li> : null}
      </ul>
    </details>
  )
}

function Card({ candidate }) {
  const types = useDesk(s => s.state.voice?.types) ?? []
  const [draft, setDraft] = React.useState(candidate.text)
  const [busy, setBusy] = React.useState(false)
  const [discarding, setDiscarding] = React.useState(false)
  const [view, setView] = React.useState('')
  const [instruction, setInstruction] = React.useState('')
  const areaRef = React.useRef(null)

  React.useEffect(() => { setDraft(candidate.text) }, [candidate.text])
  React.useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [draft])

  const length = tweetLength(draft)
  const needsStory = draft.includes(PLACEHOLDER)
  const typeKnown = types.some(row => row.id === candidate.typeId)

  const revise = async (patch, clear) => {
    setBusy(true)
    const ok = await reviseCandidate(candidate.id, patch)
    setBusy(false)
    if (ok) {
      clear?.()
      toast(t('稿子已重写'))
    }
  }
  const saveText = () => {
    const next = draft.trim()
    if (!next || next === candidate.text) { if (!next) setDraft(candidate.text); return }
    dispatchOps([{ op: 'edit_candidate', id: candidate.id, text: next }], { label: t('改了正文') })
  }
  const onEnter = (submit) => (event) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submit() }
  }
  const submitView = () => { if (view.trim()) revise({ view: view.trim() }, () => setView('')) }
  const submitInstruction = () => { if (instruction.trim()) revise({ instruction: instruction.trim() }, () => setInstruction('')) }
  const discard = (reason) => {
    setDiscarding(false)
    dispatchOps([{ op: 'discard_candidate', id: candidate.id, ...(reason ? { reason } : {}) }], { label: t('丢掉了一条稿子') })
  }

  return (
    <article className={`md-inbox-card ${busy ? 'is-busy' : ''}`} aria-busy={busy}>
      <header>
        <h3>{candidate.title}</h3>
        <span className="md-inbox-tag">{candidate.form === 'quote' ? t('引用转发') : t('短推文')}</span>
        <select aria-label={t('类型')} value={candidate.typeId} disabled={busy} onChange={event => revise({ typeId: event.target.value })}>
          {typeKnown ? null : <option value={candidate.typeId}>{candidate.typeId}</option>}
          {types.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
      </header>

      <textarea ref={areaRef} className="md-inbox-text" aria-label={t('正文')} rows={3} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} onBlur={saveText} />
      <div className="md-inbox-meta">
        <span className={length > MAX_TWEET ? 'is-over' : ''}>{t('{n} / {max} 字', { n: length, max: MAX_TWEET })}</span>
        {needsStory ? <span className="md-inbox-need"><mark>{PLACEHOLDER}</mark>{t('这里需要你自己的经历')}</span> : null}
        {busy ? <span className="md-shimmer">{t('正在重写…')}</span> : null}
      </div>

      {candidate.view ? <p className="md-inbox-view">{t('你的看法：{view}', { view: candidate.view })}</p> : null}
      <input className="md-inbox-hero-input" aria-label={t('加一句我的看法')} placeholder={t('加一句你自己的看法，稿子会围绕它重写')} value={view} disabled={busy} onChange={event => setView(event.target.value)} onKeyDown={onEnter(submitView)} />

      <div className="md-inbox-actions">
        <button type="button" className="md-btn is-primary" disabled={busy} onClick={() => dispatchOps([{ op: 'approve_candidate', id: candidate.id }], { label: t('通过了一条稿子') })}>
          <Icon name="check" size={14} />{t('通过')}
        </button>
        <input aria-label={t('说一句来改')} placeholder={t('说一句来改，比如：再短一点')} value={instruction} disabled={busy} onChange={event => setInstruction(event.target.value)} onKeyDown={onEnter(submitInstruction)} />
        {discarding ? (
          <span className="md-inbox-discard">
            {DISCARD_REASONS.map(row => <button type="button" key={row.reason} className="md-btn is-small" onClick={() => discard(row.reason)}>{t(row.label)}</button>)}
            <button type="button" className="md-btn is-small" onClick={() => discard()}>{t('直接丢掉')}</button>
            <button type="button" className="md-btn is-small" aria-label={t('取消丢掉')} onClick={() => setDiscarding(false)}><Icon name="close" size={12} /></button>
          </span>
        ) : <button type="button" className="md-btn is-danger" disabled={busy} onClick={() => setDiscarding(true)}>{t('丢掉')}</button>}
      </div>

      <Sources candidate={candidate} />
      {candidate.reason ? (
        <details className="md-inbox-fold">
          <summary>{t('为什么选它')}</summary>
          <p>{candidate.reason}</p>
        </details>
      ) : null}
    </article>
  )
}

function Handled() {
  const candidates = useDesk(s => s.state.candidates)
  const today = dayKey(new Date())
  const rows = candidates.filter(row => row.status !== 'pending' && dayKey(row.decidedAt ?? row.createdAt) === today)
  if (!rows.length) return null
  return (
    <details className="md-inbox-fold md-inbox-handled">
      <summary>{t('已处理（{n}）', { n: rows.length })}</summary>
      <ul>
        {rows.map(row => <li key={row.id}><span className="md-inbox-tag">{t(STATUS_LABEL[row.status] ?? row.status)}</span>{row.title}</li>)}
      </ul>
    </details>
  )
}

function Notes() {
  const notes = useDesk(s => s.state.notes).filter(row => !row.used)
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(() => new Set())
  const add = async (event) => {
    event.preventDefault()
    const body = text.trim()
    if (!body) return
    const data = await dispatchOps([{ op: 'add_note', text: body }], { label: t('记了一条想法') })
    if (data && !data.errors?.length) setText('')
  }
  const compose = async (id) => {
    setBusy(prev => new Set(prev).add(id))
    const ok = await composeNote(id)
    setBusy((prev) => { const next = new Set(prev); next.delete(id); return next })
    if (ok) toast(t('出了一条稿子'))
  }
  return (
    <section className="md-inbox-notes" aria-label={t('手动素材')}>
      <h2>{t('手动素材')}</h2>
      <form onSubmit={add}>
        <input aria-label={t('贴一段内容或记一条想法')} placeholder={t('贴一段内容或记一条想法')} value={text} onChange={event => setText(event.target.value)} />
        <button type="submit" className="md-btn" disabled={!text.trim()}>{t('记下')}</button>
      </form>
      {notes.length ? (
        <ul>
          {notes.map(row => (
            <li key={row.id}>
              <span>{row.text}</span>
              <button type="button" className="md-btn is-small" disabled={busy.has(row.id)} onClick={() => compose(row.id)}>{busy.has(row.id) ? t('出稿中…') : t('用它出一条')}</button>
              <button type="button" className="md-icon-btn" aria-label={t('删除这条笔记')} title={t('删除')} onClick={() => dispatchOps([{ op: 'delete_note', id: row.id }], { label: t('删除了笔记') })}><Icon name="trash" size={14} /></button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

export function InboxView() {
  const candidates = useDesk(s => s.state.candidates)
  const hasPosts = useDesk(s => s.state.posts.length > 0)
  const exchangeDir = useDesk(s => s.exchangeDir)
  const pending = sortPending(candidates)
  return (
    <div className="md-page">
      <div className="md-inbox">
        <StatusBar />
        <Notices />
        {pending.length ? (
          <div className="md-inbox-list">{pending.map(row => <Card key={row.id} candidate={row} />)}</div>
        ) : !candidates.length && !hasPosts ? (
          <Empty title={t('还没有素材')} hint={exchangeDir ? t('把帖子文件放进 {dir}/posts/，或在下面贴一段内容。', { dir: exchangeDir }) : t('把帖子文件放进交换文件夹的 posts/ 目录，或在下面贴一段内容。')} />
        ) : <Empty title={t('没有待处理的稿子')} />}
        <Handled />
        <Notes />
      </div>
    </div>
  )
}
