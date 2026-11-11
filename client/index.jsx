// dsh-x-desk 浏览器半片：侧栏入口 + main 全局面板。
import React from 'react'
import { InboxView } from './inbox.jsx'
import { loadDesk, setDesk, undo, useDesk } from './desk.js'
import { ModelButton, ModelPicker } from './modelpick.jsx'
import { ScheduleView } from './schedule.jsx'
import { SettingsDialog } from './settings.jsx'
import { StyleView } from './style.jsx'
import css from './styles.css'
import { t } from './util.js'
import { FormDialog, Icon, IconButton, Toast } from './ui.jsx'

const PANEL_ID = 'x-desk'

const NAV = [
  { id: 'inbox', label: '收件箱' },
  { id: 'schedule', label: '排期' },
  { id: 'style', label: '风格' },
]

const VIEWS = { inbox: InboxView, schedule: ScheduleView, style: StyleView }

function Desk() {
  const ready = useDesk(s => Boolean(s.state))
  const error = useDesk(s => s.error)
  const view = useDesk(s => s.view)
  const canUndo = useDesk(s => s.canUndo)
  const rootRef = React.useRef(null)
  const [width, setWidth] = React.useState(1600)
  const narrow = width < 1020

  React.useEffect(() => { loadDesk() }, [])
  React.useEffect(() => {
    const el = rootRef.current
    if (!el) return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    const onKey = (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable
      if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey && !typing && canUndo) {
        event.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canUndo])

  const Active = VIEWS[view] ?? InboxView
  return (
    <div className={`md-root ${narrow ? 'is-narrow' : ''} ${width < 780 ? 'is-compact' : ''}`} ref={rootRef}>
      <style>{css}</style>
      <div className="md-ambient" aria-hidden="true"><i /><i /><i /></div>
      <div className="md-main">
        <header className="md-topbar" data-window-drag="">
          <nav className="md-nav" aria-label={t('工作台导航')}>
            {NAV.map(entry => (
              <button type="button" key={entry.id} className={view === entry.id ? 'is-on' : ''} aria-current={view === entry.id ? 'page' : undefined} onClick={() => setDesk({ view: entry.id })}>{t(entry.label)}</button>
            ))}
          </nav>
          <span style={{ flex: 1 }} />
          {canUndo ? <IconButton icon="undo" label={t('撤销上一步')} onClick={undo} /> : null}
          {ready ? <ModelButton /> : null}
          <IconButton icon="gear" label={t('设置')} onClick={() => setDesk({ settingsOpen: true })} />
        </header>
        <main className="md-content" key={view}>
          {error ? (
            <div className="md-page"><p className="md-muted">{t('工作台加载失败：{error}', { error })}</p><button type="button" className="md-btn" onClick={loadDesk}>{t('重试')}</button></div>
          ) : ready ? <Active /> : <div className="md-loading"><span className="md-shimmer">{t('正在加载…')}</span></div>}
        </main>
      </div>
      <FormDialog />
      {ready ? <SettingsDialog /> : null}
      {ready ? <ModelPicker /> : null}
      <Toast />
    </div>
  )
}

function PanelIcon({ size }) {
  return <Icon name="scatter" size={size} />
}

export const inject = ['slots']

export function apply(ctx) {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Desk))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 5,
    label: () => t('自媒体工作台'),
  }, PanelIcon))
}
