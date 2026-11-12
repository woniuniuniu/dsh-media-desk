import React from 'react'
import { dismissExportRecovery, runVersionOperation, useDesk } from './desk.js'
import { t } from './i18n.js'

export function VersionHistory({ item }) {
  const [name, setName] = React.useState('')
  const [selected, setSelected] = React.useState(null)
  const [pending, setPending] = React.useState(false)
  const editing = useDesk(s => Boolean(s.articleEditing[item.id]))
  const recovery = useDesk(s => s.exportRecoveries?.[item.id])
  const versions = item.contentVersions ?? []
  const version = versions.find(v => v.id === selected)
  const content = version?.content
  const act = async operation => {
    setPending(true)
    try {
      const result = await runVersionOperation(item.id, operation)
      if (result && !result.errors?.length && operation.op === 'save_version') setName('')
    } finally { setPending(false) }
  }
  return <>
    {recovery && recovery.accountId === (item.accountId ?? null) ? <aside className="md-versions md-export-recovery" role="alert">
      <strong>{t('导出结果待核对')}</strong>
      <p>{t('文件已保留，保存记录尚未确认。请先检查导出文件，不要重复导出。')}</p>
      <p>{recovery.versionNumber ? `V${recovery.versionNumber}` : ''}{recovery.versionName ? ` · ${recovery.versionName}` : ''}</p>
      <pre>{recovery.path}</pre>
      <button type="button" className="md-btn is-small" onClick={() => dismissExportRecovery(item.id)}>{t('关闭提示')}</button>
    </aside> : null}
    <details className="md-versions">
    <summary>{t('内容版本')} <span>{versions.length}</span></summary>
    <div className="md-version-save">
      <input aria-label={t('版本名称（可选）')} placeholder={t('版本名称（可选）')} maxLength={80} value={name} onChange={event => setName(event.target.value)} />
      <button type="button" className="md-btn is-small" disabled={pending || editing} onClick={() => act({ op: 'save_version', name })}>{t('保存版本')}</button>
    </div>
    {editing ? <p>{t('请先完成或取消文章编辑，再操作版本。')}</p> : null}
    {!versions.length ? <p>{t('保存后可查看并恢复历史内容。')}</p> : <ol className="md-version-list">{[...versions].reverse().map(v => <li key={v.id}><button type="button" aria-pressed={selected === v.id} onClick={() => setSelected(v.id)}>V{v.number}{v.name ? ` · ${v.name}` : ''} <time dateTime={v.createdAt}>{new Date(v.createdAt).toLocaleString()}</time></button></li>)}</ol>}
    {content ? <section className="md-version-preview" aria-label={t('历史版本预览')}>
      <h3>V{version.number}{version.name ? ` · ${version.name}` : ''}</h3>
      <h4>{t('灵感')}</h4><pre>{content.title}{content.body ? `\n\n${content.body}` : ''}</pre>
      {Object.entries(content.drafts ?? {}).map(([format, draft]) => <div key={format}><h4>{t(format === 'script' ? '脚本草稿' : '文章草稿')}</h4><pre>{draft.text}</pre></div>)}
      {content.production ? <><h4>{t('成稿')}</h4><pre>{content.production.title}{'\n\n'}{content.production.article}</pre><h4>{t('封面大字')}</h4><pre>{content.production.coverText}</pre>{content.production.shots?.length ? <pre>{content.production.shots.map((shot, i) => `${i + 1}. ${shot.visual ?? ''}\n${shot.voice ?? ''}`).join('\n\n')}</pre> : null}</> : null}
      <p>{t('恢复前会先保存当前内容，所有历史版本都会保留。')}</p>
      <button type="button" className="md-btn is-small" disabled={pending || editing} onClick={() => act({ op: 'restore_version', versionId: version.id })}>{t('恢复这个版本')}</button>
    </section> : null}
    </details>
  </>
}
