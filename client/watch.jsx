// 账号名单：互动档（回复、转发的对象）和选题档（找选题的来源），写进交换文件夹给 Grok Bot 读。
import React from 'react'
import { dispatchOps, toast, useDesk } from './desk.js'
import { extractHandle, t } from './util.js'
import { Empty, Icon, Segmented } from './ui.jsx'

const TIERS = [
  { value: 'engage', label: '互动', range: '5 到 8 个', hint: '建议 5 到 8 个' },
  { value: 'topic', label: '选题', range: '20 到 30 个', hint: '建议 20 到 30 个' },
]

function Row({ row }) {
  const [note, setNote] = React.useState(row.note ?? '')
  React.useEffect(() => { setNote(row.note ?? '') }, [row.note])
  const saveNote = () => {
    if (note.trim() === (row.note ?? '')) return
    dispatchOps([{ op: 'update_watch', id: row.id, note: note.trim() }], { label: t('改了账号备注'), silent: true })
  }
  return (
    <li className="md-watch-row">
      <b>@{row.handle}</b>
      <Segmented
        label={t('档位')}
        value={row.tier}
        options={TIERS.map(tier => ({ value: tier.value, label: t(tier.label) }))}
        onChange={tier => { if (tier !== row.tier) dispatchOps([{ op: 'update_watch', id: row.id, tier }], { label: t('换了账号档位') }) }}
      />
      <input aria-label={t('备注')} placeholder={t('备注')} maxLength={200} value={note} onChange={event => setNote(event.target.value)} onBlur={saveNote} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur() }} />
      <button type="button" className="md-icon-btn" aria-label={t('删除 @{handle}', { handle: row.handle })} title={t('删除')} onClick={() => dispatchOps([{ op: 'delete_watch', id: row.id }], { label: t('删除了账号') })}><Icon name="trash" size={14} /></button>
    </li>
  )
}

export function WatchView() {
  const watch = useDesk(s => s.state.watch) ?? []
  const [input, setInput] = React.useState('')
  const [tier, setTier] = React.useState('topic')
  const counts = { engage: watch.filter(row => row.tier === 'engage').length, topic: watch.filter(row => row.tier === 'topic').length }

  const add = async (event) => {
    event.preventDefault()
    const handle = extractHandle(input)
    if (!handle) { toast(t('账号名不对：只能是 1 到 15 位字母、数字或下划线，也可以粘贴主页链接'), { error: true }); return }
    const data = await dispatchOps([{ op: 'add_watch', handle, tier }], { label: t('加了一个账号') })
    if (data && !data.errors?.length) setInput('')
  }

  return (
    <section className="md-watch" aria-label={t('账号名单')}>
      <div className="md-panel md-watch-intro">
        <p><b>{t('互动档')}</b>{t('：值得回复、转发的账号，建议 5 到 8 个。')}</p>
        <p><b>{t('选题档')}</b>{t('：用来找选题、看动向的账号，建议 20 到 30 个。')}</p>
        <p className="md-muted">{t('这份名单会写进交换文件夹，供 Grok Bot 读取。')}</p>
        <p className="md-watch-counts">
          {TIERS.map(row => <span key={row.value}>{t(row.label)} {counts[row.value]}（{row.hint}）</span>)}
        </p>
      </div>
      <form className="md-watch-add" onSubmit={add}>
        <input aria-label={t('账号名或主页链接')} placeholder={t('账号名或主页链接，如 @name、https://x.com/name')} value={input} onChange={event => setInput(event.target.value)} />
        <Segmented label={t('新账号的档位')} value={tier} options={TIERS.map(row => ({ value: row.value, label: t(row.label) }))} onChange={setTier} />
        <button type="submit" className="md-btn is-primary" disabled={!input.trim()}><Icon name="plus" size={14} />{t('添加')}</button>
      </form>
      {watch.length ? (
        <ul className="md-watch-list">{watch.map(row => <Row key={row.id} row={row} />)}</ul>
      ) : <Empty title={t('还没有账号')} hint={t('先加几个想盯的账号。')} />}
    </section>
  )
}
