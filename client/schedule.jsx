// 排期：月历 + 右侧「接下来要发的」。已通过的稿子按排期时间落在日历上，已发的灰显在发出那天。
import React from 'react'
import { dispatchOps, fileUrl, makeImage, useDesk } from './desk.js'
import { SentComparison } from './inbox.jsx'
import { Dialog, Empty, IconButton } from './ui.jsx'
import { dayKey, fmtTime, intentUrl, isDue, moveToDay, recentSent, relativeDay, t, toLocalInput, upcomingList } from './util.js'

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DRAG_TYPE = 'text/x-desk-candidate'

const calendarDay = row => (row.status === 'sent' ? (row.sentAt ?? row.decidedAt) : row.scheduledAt)

function Chip({ row }) {
  const sent = row.status === 'sent'
  const due = isDue(row)
  return (
    <div>
      <span
        className={`md-cal-chip ${sent ? 'is-sent' : ''} ${due ? 'is-due' : ''}`}
        draggable={!sent}
        title={`${fmtTime(calendarDay(row))} ${row.title || row.text}`}
        onDragStart={(event) => { event.dataTransfer.setData(DRAG_TYPE, row.id); event.dataTransfer.effectAllowed = 'move' }}
      >
        <span className="md-cal-chip-text"><time>{fmtTime(calendarDay(row))}</time><span>{row.title || row.text}</span></span>
        {sent ? <span className="md-inbox-tag md-cal-chip-sent">{t('已发')}</span> : null}
      </span>
    </div>
  )
}

function Calendar({ rows }) {
  const [cursor, setCursor] = React.useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [over, setOver] = React.useState(null)
  const y = cursor.getFullYear()
  const m = cursor.getMonth()
  const first = new Date(y, m, 1).getDay()
  const cells = []
  for (let i = 0; i < 42; i += 1) cells.push(new Date(y, m, i - first + 1))
  const shown = cells[28].getMonth() !== m ? cells.slice(0, 28) : cells[35].getMonth() === m ? cells : cells.slice(0, 35)
  const byDay = React.useMemo(() => {
    const map = new Map()
    for (const row of rows) {
      const when = calendarDay(row)
      if (!when) continue
      const key = dayKey(when)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(row)
    }
    for (const list of map.values()) list.sort((a, b) => Date.parse(calendarDay(a)) - Date.parse(calendarDay(b)))
    return map
  }, [rows])
  const today = dayKey(new Date())
  const drop = (event, date) => {
    event.preventDefault()
    setOver(null)
    const id = event.dataTransfer.getData(DRAG_TYPE)
    const row = rows.find(item => item.id === id)
    if (!row || row.status !== 'approved' || dayKey(row.scheduledAt) === dayKey(date)) return
    dispatchOps([{ op: 'reschedule_candidate', id, scheduledAt: moveToDay(row.scheduledAt, date) }], { label: t('修改排期') })
  }
  return (
    <section className="md-panel md-cal-tile" aria-label={t('发帖日历')}>
      <header className="md-cal-head">
        <div className="md-cal-num">{String(m + 1).padStart(2, '0')}</div>
        <div className="md-cal-month"><span>{y}</span></div>
        <span style={{ flex: 1 }} />
        <IconButton icon="chevL" label={t('上个月')} onClick={() => setCursor(new Date(y, m - 1, 1))} />
        <button type="button" className="md-btn is-small" onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>{t('今天')}</button>
        <IconButton icon="chevR" label={t('下个月')} onClick={() => setCursor(new Date(y, m + 1, 1))} />
      </header>
      <div className="md-cal-weeks">{WEEK.map(w => <span key={w}>{t(w)}</span>)}</div>
      <div className="md-cal-grid" role="grid" style={{ '--rows': shown.length / 7 }}>
        {shown.map((date) => {
          const key = dayKey(date)
          const list = byDay.get(key) ?? []
          return (
            <div
              key={key}
              role="gridcell"
              className={`md-cal-cell ${date.getMonth() !== m ? 'is-outside' : ''} ${key === today ? 'is-today' : ''} ${over === key ? 'is-over' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setOver(key) }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOver(o => (o === key ? null : o)) }}
              onDrop={event => drop(event, date)}
            >
              <div className="md-cal-cell-top"><span className="md-cal-date">{date.getDate()}</span></div>
              <div className="md-cal-posts">
                {list.slice(0, 2).map(row => <Chip key={row.id} row={row} />)}
                {list.length > 2 ? <span className="md-cal-more">{t('还有 {n} 条', { n: list.length - 2 })}</span> : null}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function RescheduleDialog({ row, onClose }) {
  const [value, setValue] = React.useState(toLocalInput(row.scheduledAt))
  const submit = async (event) => {
    event.preventDefault()
    const when = new Date(value)
    if (Number.isNaN(when.getTime())) return
    const data = await dispatchOps([{ op: 'reschedule_candidate', id: row.id, scheduledAt: when.toISOString() }], { label: t('改了发帖时间') })
    if (data && !data.errors?.length) onClose()
  }
  return (
    <Dialog title={t('改时间')} onClose={onClose} width={360}>
      <form className="md-form" onSubmit={submit}>
        <label className="md-field">
          <span>{t('发帖时间')}</span>
          <input type="datetime-local" required value={value} onChange={event => setValue(event.target.value)} />
        </label>
        <div className="md-form-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="md-btn" onClick={onClose}>{t('取消')}</button>
          <button type="submit" className="md-btn is-primary" disabled={!value}>{t('保存')}</button>
        </div>
      </form>
    </Dialog>
  )
}

function UpcomingCard({ row }) {
  const [asking, setAsking] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const due = isDue(row)
  const image = async () => {
    setBusy(true)
    await makeImage(row.id)
    setBusy(false)
  }
  return (
    <li className={`md-sched-card ${due ? 'is-due' : ''}`}>
      <div className="md-sched-when">
        {due ? <span className="md-sched-due">{t('该发了')}</span> : null}
        <span>{relativeDay(row.scheduledAt)} {fmtTime(row.scheduledAt)}</span>
      </div>
      <p className="md-sched-text">{row.text}</p>
      {row.image ? (
        <div className="md-sched-image">
          <img src={fileUrl(row.image)} alt={t('配图')} loading="lazy" />
          <a href={fileUrl(row.image)} download={row.image}>{t('下载图片')}</a>
        </div>
      ) : null}
      {row.image || busy ? <small className="md-muted">{t('发帖链接不能自带图片，需要在 X 里手动添加')}</small> : null}
      <div className="md-sched-actions">
        <a className="md-btn is-primary is-small" href={intentUrl(row)} target="_blank" rel="noopener noreferrer" onClick={() => setAsking(true)}>{t('去 X 发布')}</a>
        <button type="button" className="md-btn is-small" onClick={() => dispatchOps([{ op: 'mark_sent', id: row.id }], { label: t('标记为已发') })}>{t('已发')}</button>
        <button type="button" className="md-btn is-small" onClick={() => setEditing(true)}>{t('改时间')}</button>
        <button type="button" className="md-btn is-small" onClick={() => dispatchOps([{ op: 'unapprove_candidate', id: row.id }], { label: t('撤回了一条稿子') })}>{t('撤回')}</button>
        <button type="button" className="md-btn is-small" disabled={busy} aria-busy={busy} onClick={image}>{busy ? t('配图中…') : row.image ? t('重新配图') : t('配一张图')}</button>
      </div>
      {!row.image && !busy ? <small className="md-muted">{t('发帖链接不能自带图片，需要在 X 里手动添加')}</small> : null}
      {asking ? (
        <div className="md-sched-confirm" role="group" aria-label={t('发出去了吗？')}>
          <span>{t('发出去了吗？')}</span>
          <button type="button" className="md-btn is-small is-primary" onClick={() => { setAsking(false); dispatchOps([{ op: 'mark_sent', id: row.id }], { label: t('标记为已发') }) }}>{t('已发')}</button>
          <button type="button" className="md-btn is-small" onClick={() => setAsking(false)}>{t('还没')}</button>
        </div>
      ) : null}
      {editing ? <RescheduleDialog row={row} onClose={() => setEditing(false)} /> : null}
    </li>
  )
}

function Rail({ rows }) {
  const list = upcomingList(rows)
  const now = new Date()
  const sent = recentSent(rows, now)
  // 该发了的排最前，其余按时间升序
  const ordered = [...list.filter(row => isDue(row, now)), ...list.filter(row => !isDue(row, now))]
  return (
    <aside className="md-panel md-sched-rail" aria-label={t('接下来要发的')}>
      <header><h2>{t('接下来要发的')}</h2><span className="md-tile-meta md-muted">{t('拖日历上的条目可改日期')}</span></header>
      {ordered.length ? <ul className="md-sched-list">{ordered.map(row => <UpcomingCard key={row.id} row={row} />)}</ul> : <Empty title={t('还没有排期')} hint={t('在收件箱通过稿子后，会出现在这里。')} />}
      {sent.length ? <section aria-label={t('已发')}>
        <h3>{t('已发')}</h3>
        <ul className="md-sched-list">{sent.map(row => <li key={row.id} className="md-sched-card">
          <div className="md-sched-when"><span className="md-inbox-tag">{t('已发')}</span><time>{relativeDay(calendarDay(row))} {fmtTime(row.sentAt ?? row.decidedAt)}</time></div>
          <p className="md-sched-text">{row.text}</p>
          <SentComparison row={row} />
        </li>)}</ul>
      </section> : null}
    </aside>
  )
}

export function ScheduleView() {
  const candidates = useDesk(s => s.state.candidates)
  const rows = candidates.filter(row => (row.status === 'approved' && row.scheduledAt) || (row.status === 'sent' && calendarDay(row)))
  return (
    <div className="md-page">
      <div className="md-schedule">
        <Calendar rows={rows} />
        <Rail rows={rows} />
      </div>
    </div>
  )
}
