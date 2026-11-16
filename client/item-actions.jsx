// 详情、看板、表格共用删除行为。成功依现有回执撤销，失败保持当前界面与编辑。
import React from 'react'
import { dispatchOps, setDesk, useDesk } from './desk.js'
import { t } from './i18n.js'
import { Icon } from './ui.jsx'

const deleting = new Set()
const running = value => ['pending', 'running'].includes(value?.status)

export function DeleteContentButton({ item, busy = false, dirty = false, compact = false }) {
  const articleBusy = useDesk(state => Boolean(state.articleBusy?.[item.id]))
  const pending = useDesk(state => Boolean(state.deletingItems?.[item.id]))
  const producing = busy || articleBusy || running(item.production) || [item.production?.cover, ...(item.production?.images || []), ...(item.production?.shots || [])].some(running)
  const title = item.production?.title || item.title || t('无标题')
  const remove = async event => {
    event?.stopPropagation()
    event?.preventDefault()
    if (dirty || producing || pending || deleting.has(item.id)) return false
    deleting.add(item.id)
    setDesk(state => ({ deletingItems: { ...state.deletingItems, [item.id]: true } }))
    try {
      const result = await dispatchOps([{ op: 'delete_item', id: item.id }], { label: t('删除《{title}》', { title }) })
      return Boolean(result && !result.errors?.length && result.state?.items && !result.state.items.some(row => row.id === item.id))
    } finally {
      deleting.delete(item.id)
      setDesk(state => ({ deletingItems: { ...state.deletingItems, [item.id]: false } }))
    }
  }
  return <button type="button" className={`md-delete-content ${compact ? 'is-compact' : ''}`} disabled={dirty || producing || pending} aria-label={t('删除内容：{title}', { title })} title={dirty ? t('请先保存修改，再删除内容。') : producing ? t('内容正在生成，完成后才能删除') : t('删除内容：{title}', { title })} onClick={remove} onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <Icon name="trash" size={14} /><span>{pending ? t('正在删除……') : compact ? t('删除') : t('删除内容')}</span>
  </button>
}
