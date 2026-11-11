import React from 'react'
import { accountCounts, allAccountCounts, applyAccountsCsv } from '../src/accounts.js'
import { dispatchOps, loadDesk, selectAccount, useDesk } from './desk.js'
import { Dialog } from './ui.jsx'
import { platformChoices } from './util.js'
import { t } from './i18n.js'

export const accountLabel = account => account
  ? `${t(account.platform)} · ${account.handle || account.title || account.id}${account.group ? ` · ${account.group}` : ''} · ${account.id}`
  : t('未归属')

function AccountForm({ account, onClose, styles }) {
  const [values, setValues] = React.useState({
    platform: '抖音', handle: '', group: '', url: '', positioning: '', audience: '', defaultStyleId: '', note: '', ...account,
  })
  const [busy, setBusy] = React.useState(false)
  const set = (name, value) => setValues(v => ({ ...v, [name]: value }))
  const field = (name, label, textarea = false) => (
    <label className="md-field">
      <span>{t(label)}</span>
      {textarea
        ? <textarea rows={3} value={values[name] ?? ''} onChange={e => set(name, e.target.value)} />
        : <input required={name === 'handle'} type={name === 'url' ? 'url' : 'text'} value={values[name] ?? ''} onChange={e => set(name, e.target.value)} />}
    </label>
  )
  const submit = async event => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    const op = {
      op: account ? 'update_account' : 'add_account',
      ...(account ? { id: account.id } : {}),
      ...Object.fromEntries(['platform', 'handle', 'group', 'url', 'positioning', 'audience', 'note'].map(key => [key, values[key]])),
      defaultStyleId: values.defaultStyleId || null,
    }
    const result = await dispatchOps([op], { accountId: undefined, label: t('保存账号') })
    setBusy(false)
    if (result && !result.errors.length) onClose()
  }
  return (
    <Dialog title={t(account ? '编辑账号' : '添加账号')} onClose={onClose} width={560}>
      <form className="md-form" onSubmit={submit}>
        <label className="md-field">
          <span>{t('平台')}</span>
          <select value={values.platform} onChange={e => set('platform', e.target.value)}>
            {platformChoices().map(platform => <option key={platform} value={platform}>{t(platform)}</option>)}
          </select>
        </label>
        {field('handle', '账号名称')}
        {field('group', '分组')}
        {field('url', '主页链接')}
        {field('positioning', '账号定位', true)}
        {field('audience', '目标受众', true)}
        <label className="md-field">
          <span>{t('默认风格')}</span>
          <select value={values.defaultStyleId ?? ''} onChange={e => set('defaultStyleId', e.target.value)}>
            <option value="">{t('默认')}</option>
            {styles.map(style => <option key={style.id} value={style.id}>{style.name}</option>)}
          </select>
        </label>
        {field('note', '备注', true)}
        <p className="md-muted">{t('账号档案用于内容管理，无需平台登录或模型。')}</p>
        <button className="md-btn is-primary" disabled={busy}>{t('保存账号')}</button>
      </form>
    </Dialog>
  )
}

export function RootAccountsView() {
  const state = useDesk(s => s.allState)
  const [query, setQuery] = React.useState('')
  const [platform, setPlatform] = React.useState('')
  const [group, setGroup] = React.useState('')
  const [archived, setArchived] = React.useState(false)
  const [editing, setEditing] = React.useState(null)
  const [bulk, setBulk] = React.useState(false)
  const [csv, setCsv] = React.useState('')
  const [errors, setErrors] = React.useState([])
  const [bulkBusy, setBulkBusy] = React.useState(false)
  const [page, setPage] = React.useState(0)
  const counts = React.useMemo(() => allAccountCounts(state), [state])
  const rows = state.accounts.filter(account => (archived || !account.archived)
    && (!platform || account.platform === platform)
    && (!group || account.group === group)
    && accountLabel(account).toLowerCase().includes(query.toLowerCase()))
  const visible = rows.slice(page * 50, page * 50 + 50)
  const groups = [...new Set(state.accounts.map(account => account.group).filter(Boolean))]
  React.useEffect(() => setPage(0), [query, platform, group, archived])
  React.useEffect(() => { if (page > 0 && page * 50 >= rows.length) setPage(Math.max(0, Math.ceil(rows.length / 50) - 1)) }, [page, rows.length])
  const addCsv = async () => {
    if (bulkBusy) return
    setBulkBusy(true)
    try {
      const result = await applyAccountsCsv(csv, op => dispatchOps([op], { accountId: undefined, silent: true }))
      setErrors(result.errors.length ? result.errors.map(error => `${error.row}: ${error.message}`) : [t('批量添加完成')])
      setCsv(result.remaining)
    } finally { setBulkBusy(false) }
  }
  return (
    <div className="md-page">
      <header className="md-page-head">
        <div><h1>{t('账号')}</h1><p className="md-page-sub">{t('按账号管理内容、排期、风格与复盘')}</p></div>
        <span style={{ flex: 1 }} />
        <button className="md-btn" onClick={loadDesk}>{t('刷新')}</button>
        <button className="md-btn" onClick={() => { setBulk(true); setErrors([]) }}>{t('批量添加')}</button>
        <button className="md-btn is-primary" onClick={() => setEditing({})}>{t('添加账号')}</button>
      </header>
      <div className="md-account-scopes">
        {[{ id: undefined, label: '全部账号', count: accountCounts(state, undefined) }, { id: null, label: '未归属', count: counts.get(null) ?? {} }].map(entry => (
          <button type="button" className="md-account-scope" key={entry.label} onClick={() => selectAccount(entry.id)}>
            <strong>{t(entry.label)}</strong>
            <span>{t('内容 {n} 条 · 已发布 {published} · 待发布 {scheduled}', { n: entry.count.items ?? 0, published: entry.count.published ?? 0, scheduled: entry.count.scheduled ?? 0 })}</span>
          </button>
        ))}
      </div>
      <div className="md-account-filters">
        <input aria-label={t('搜索账号')} placeholder={t('搜索账号')} value={query} onChange={e => setQuery(e.target.value)} />
        <select aria-label={t('平台筛选')} value={platform} onChange={e => setPlatform(e.target.value)}>
          <option value="">{t('全部平台')}</option>{platformChoices().map(value => <option key={value} value={value}>{t(value)}</option>)}
        </select>
        <select aria-label={t('分组筛选')} value={group} onChange={e => setGroup(e.target.value)}>
          <option value="">{t('全部分组')}</option>{groups.map(value => <option key={value}>{value}</option>)}
        </select>
        <label><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} />{t('显示已归档')}</label>
      </div>
      <div className="md-table-wrap">
        <table className="md-table">
          <thead><tr>{['账号名称', '平台', '分组', '内容', '已发布', '待发布', '默认风格', '操作'].map(key => <th key={key}>{t(key)}</th>)}</tr></thead>
          <tbody>
            {visible.map(account => {
              const count = counts.get(account.id) ?? {}
              return (
                <tr key={account.id} onClick={() => selectAccount(account.id)} className="md-account-row">
                  <td>
                    <button className="md-text-btn" onClick={event => { event.stopPropagation(); selectAccount(account.id) }}>{account.handle || account.id}</button>
                    <small className="md-account-id">{account.id}{account.archived ? ` · ${t('已归档')}` : ''}</small>
                  </td>
                  <td>{t(account.platform)}</td><td>{account.group || '—'}</td>
                  <td>{count.items ?? 0}</td><td>{count.published ?? 0}</td><td>{count.scheduled ?? 0}</td>
                  <td>{state.styles.find(style => style.id === account.defaultStyleId)?.name ?? '—'}</td>
                  <td onClick={event => event.stopPropagation()}>
                    <button className="md-btn" aria-label={`${t('编辑账号')} ${account.id}`} onClick={() => setEditing(account)}>{t('编辑')}</button>{' '}
                    <button className="md-btn" onClick={() => dispatchOps([{ op: 'update_account', id: account.id, archived: !account.archived }], { accountId: undefined })}>{t(account.archived ? '恢复' : '归档')}</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="md-account-filters">
          <button className="md-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>{t('上一页')}</button>
          <span>{page + 1} / {Math.max(1, Math.ceil(rows.length / 50))} · {rows.length}</span>
          <button className="md-btn" disabled={(page + 1) * 50 >= rows.length} onClick={() => setPage(p => p + 1)}>{t('下一页')}</button>
        </div>
        {!rows.length ? <p className="md-muted">{t('没有匹配的账号')}</p> : null}
      </div>
      {editing ? <AccountForm key={editing.id ?? 'new'} account={editing.id ? editing : null} styles={state.styles} onClose={() => setEditing(null)} /> : null}
      {bulk ? (
        <Dialog title={t('批量添加账号')} onClose={() => setBulk(false)} width={660}>
          <div className="md-form">
            <p>{t('CSV：平台,账号名称,分组,主页链接,账号定位,目标受众,备注。每次最多100行。')}</p>
            <label className="md-field"><textarea rows={8} aria-label={t('账号CSV')} value={csv} onChange={e => setCsv(e.target.value)} /></label>
            <button className="md-btn is-primary" disabled={bulkBusy} onClick={addCsv}>{t('添加有效行')}</button>
            {errors.map((error, index) => <p key={index}>{error}</p>)}
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

export function AccountProfileView() {
  const state = useDesk(s => s.state)
  const id = useDesk(s => s.accountId)
  const account = state.accounts.find(row => row.id === id)
  const [editing, setEditing] = React.useState(false)
  return (
    <div className="md-page">
      <header className="md-page-head">
        <div><h1>{t('账号档案')}</h1><p className="md-page-sub">{account ? accountLabel(account) : t(id === null ? '未归属' : '全部账号')}</p></div>
        <span style={{ flex: 1 }} />
        {account ? <button type="button" className="md-btn is-primary" onClick={() => setEditing(true)}>{t('编辑账号')}</button> : null}
      </header>
      {account ? (
        <dl className="md-account-profile">
          {['platform', 'handle', 'group', 'url', 'positioning', 'audience', 'defaultStyleId', 'note'].map((key, index) => (
            <div key={key}><dt>{t(['平台', '账号名称', '分组', '主页链接', '账号定位', '目标受众', '默认风格', '备注'][index])}</dt><dd>{key === 'platform' ? t(account.platform) : key === 'defaultStyleId' ? state.styles.find(style => style.id === account.defaultStyleId)?.name ?? t('默认') : account[key] || '—'}</dd></div>
          ))}
        </dl>
      ) : <p className="md-muted">{t('这是内容汇总范围，没有独立账号档案。请返回账号列表选择一个具体账号。')}</p>}
      {editing && account ? <AccountForm key={account.id} account={account} styles={state.styles} onClose={() => setEditing(false)} /> : null}
    </div>
  )
}

export function AccountAssignment({ item }) {
  const accounts = useDesk(s => s.allState.accounts)
  const busy = item.production?.status === 'running'
    || [item.production?.cover, ...item.production?.images ?? [], ...item.production?.shots ?? []].some(asset => asset && ['running', 'pending'].includes(asset.status))
  return (
    <label className="md-style-pick">
      <span>{t('所属账号')}</span>
      <select aria-label={t('所属账号')} value={item.accountId ?? ''} disabled={busy} onChange={e => dispatchOps([{ op: 'assign_items', ids: [item.id], accountId: e.target.value || null, updatePlatform: true }], { label: t('分配账号') })}>
        <option value="">{t('未归属')}</option>
        {accounts.filter(account => !account.archived || account.id === item.accountId).map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
      </select>
    </label>
  )
}

export function AccountBadge({ item }) {
  const account = useDesk(s => s.allState.accounts.find(a => a.id === item.accountId))
  return <small className="md-account-id" title={accountLabel(account)}>{account ? `${t(account.platform)} · ${account.handle || account.id}` : t('未归属')}</small>
}
