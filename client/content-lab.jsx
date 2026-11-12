import React from 'react'
import { getDesk, openItem, runVersionOperation, setDesk, useDesk } from './desk.js'
import { checkContentLabOperation, contentLabMedian, contentLabMetricOptions, contentLabScope, getContentLabOperation, readContentLab, runContentLabAction, useContentLabOperations } from './content-lab-state.js'
import { t, useLang } from './i18n.js'

const rubricNames = { 'general-script-v1': '通用口播脚本', 'general-article-v1': '通用文章', 'opinion-video-v1': '观点视频（主动选择）' }
const dimensionNames = { opening: '开头', clarity: '清晰度', substance: '内容支撑', structure: '结构', originality: '独特视角', payoff: '收尾兑现', speakability: '口语表达', readability: '阅读体验', claim: '观点', tension: '分歧张力', argument: '论证', evidence: '证据', delivery: '表达推进' }
const kindNames = { evaluation: '评估', forecast: '预测预览', prediction: '已锁定预测', publication: '实际发布登记', retrospective: '复盘记录' }
const statusNames = { 'awaiting-publication': '待登记实际发布', upcoming: '尚未到期', due: '已到期，可复盘', 'awaiting-data': '已到期，等待可靠数据', finished: '已完成', late: '已完成（迟到观测）' }
const buckets = ['<0.3x', '0.3x..<1x', '1x..<3x', '3x..<10x', '>=10x']
const bucketName = value => Number.isInteger(value) ? buckets[value] ?? t('未知') : value ?? t('未知')
const when = value => value ? new Date(value).toLocaleString() : t('未知')
const modelName = model => [model?.provider, model?.model].filter(Boolean).join(' / ')
const hours = ms => Number.isFinite(ms) ? (ms / 3600000).toFixed(2) : t('未知')
const recordName = record => t(kindNames[record.kind] ?? '记录')
const isPending = entry => entry && ['pending', 'unknown', 'checking'].includes(entry.status)

function OperationNotice({ accountId, itemId, action, onRecovered, captureRecovery }) {
  useContentLabOperations()
  const operation = getContentLabOperation(accountId, itemId, action)
  if (!operation) return null
  return <aside className={`md-lab-operation is-${operation.status}`} role={operation.status === 'failed' || operation.status === 'unknown' ? 'alert' : 'status'}>
    <strong>{t(operation.status === 'pending' ? '正在处理，请勿重复提交' : operation.status === 'checking' ? '正在核对结果' : operation.status === 'unknown' ? '结果待核对' : operation.existing ? '已找到原有记录，未新增结果' : operation.status === 'done' ? '结果已保存' : '操作尚未完成')}</strong>
    {operation.message ? <p>{operation.message}</p> : null}
    {operation.status !== 'blocked' ? <small>{t('核对编号')}: <code>{operation.requestId}</code>{operation.existing ? <><br />{t('原记录编号')}: <code>{operation.originalRequestId}</code><br />{t('原有记录及备注保持不变。')}</> : null}</small> : null}
    {operation.status === 'unknown' ? <button type="button" className="md-btn is-small" onClick={async () => { const accept = captureRecovery?.() ?? onRecovered; const result = await checkContentLabOperation(accountId, itemId, action); if (result?.record) accept?.(result.record.id) }}>{t('核对结果（不重新提交）')}</button> : null}
    {operation.status === 'done' && operation.result?.record?.id ? <button type="button" className="md-link-btn" onClick={() => onRecovered?.(operation.result.record.id)}>{t('查看已保存结果')}</button> : null}
  </aside>
}

export function ContentLabRecord({ record }) {
  if (!record) return null
  const evaluation = record.kind === 'prediction' ? record.evaluation : record.kind === 'evaluation' ? record : null
  const forecast = record.kind === 'prediction' ? record.forecast : record.kind === 'forecast' ? record : null
  return <div className="md-lab-record">
    <div className="md-lab-badges"><span>{recordName(record)}</span><span>{t('未校准预设')}</span>{evaluation?.blindness === 'historical-nonblind' ? <span className="is-warning">{t('历史评估，不符合发布前盲预测条件')}</span> : null}</div>
    {record.model ? <p className="md-muted">{t('评审模型')}: {modelName(record.model)}</p> : null}
    {evaluation ? <>
      <div className="md-lab-score"><strong>{evaluation.composite}</strong><span>/ 100 · {t(rubricNames[evaluation.rubricId] ?? '评估标准')}</span></div>
      {evaluation.model && record.kind === 'prediction' ? <p>{t('评审模型')}: {modelName(evaluation.model)}</p> : null}
      <p className="md-muted">{t('独立输入仅包含所选版本和标准，不代表模型完全不了解历史。')}</p>
      <dl className="md-lab-dimensions">{(evaluation.dimensions ?? []).map(dimension => <div key={dimension.id}><dt>{t(dimensionNames[dimension.id] ?? evaluation.rubric?.dimensions?.find(d => d.id === dimension.id)?.name ?? dimension.id)} <strong>{dimension.score} / 5</strong></dt><dd>{dimension.reason}{dimension.evidence ? <blockquote>{dimension.evidence}</blockquote> : null}<small>{t('模型自评信心（不是实测准确率）')}: {Math.round(dimension.confidence * 100)}%</small></dd></div>)}</dl>
    </> : null}
    {forecast ? <>
      <h4>{t('预测窗口')}: {forecast.horizonDays} {t('天')}</h4>
      <p><strong>{forecast.bet}</strong></p><p>{forecast.reason}</p>
      <p className="md-muted">{t('同账号、平台、体裁和窗口：选用最近 {selected} 篇，可用历史共 {available} 篇。', { selected: forecast.baseline?.count ?? 0, available: forecast.baseline?.totalEligibleCount ?? 0 })}</p>
      <p className="md-muted">{t('每篇取到期后六小时内最早的可靠观测；这是近时累计数据，不是精确到期测量。')}</p>
      {forecast.probabilities ? <>
        <p>{t('历史播放中位数')}: {contentLabMedian(forecast.baseline)}{forecast.baseline?.medianViewsApproximate ? <small>{t('近似显示值')}: {forecast.baseline.medianViews ?? t('未知')}</small> : null}</p>
        <ul className="md-lab-probabilities" aria-label={t('相对历史中位数的概率')} >{(forecast.buckets ?? buckets).map((bucket, index) => <li key={bucket}><span>{bucket}</span><meter min="0" max="1" value={forecast.probabilities[index]} /><strong>{(forecast.probabilities[index] * 100).toFixed(1)}%</strong></li>)}</ul>
        {(forecast.topBuckets?.length ?? 0) > 1 ? <p>{t('最高概率并列，无唯一预测档位')}: {forecast.topBuckets.map(bucketName).join(' · ')}</p> : null}
        <p className="md-muted">{t('概率为未校准的相对判断，不承诺播放量。')}</p>
      </> : <p className="md-lab-caution">{t('仅定性：可比历史少于三篇或中位数为零，暂无数字概率或流量估计。')}</p>}
      {record.kind === 'prediction' ? <p>{t('锁定时间')}: {when(record.lockedAt)} · {t('锁定后不可修改')}</p> : null}
    </> : null}
    {record.kind === 'publication' ? <><p>{t('本人声明的实际发布时间')}: {when(record.publishedAt)}</p><p>{t('复盘到期时间')}: {when(record.dueAt)}</p>{record.url ? <a href={record.url} target="_blank" rel="noreferrer">{t('作品链接')}</a> : null}<p>{t('此记录是本人声明，未核验平台发布状态。')}</p></> : null}
    {record.manuscriptMatch === 'mismatch' || record.publicationManuscriptMatch === 'mismatch' ? <p className="md-lab-caution" role="alert">{t('登记时稿件与锁定版本不同，此记录不能用于预测校准。')}{record.registrationCreativeSha256 ? <small>{t('登记稿件校验值')}: {record.registrationCreativeSha256}</small> : null}</p> : null}
    {record.kind === 'retrospective' ? <>
      <p>{t('实际观测时间')}: {when(record.actuals?.collectedAt)}</p><p>{t('发布后 {hours} 小时，较到期时间晚 {late} 小时', { hours: hours(record.elapsedMs), late: hours(record.latenessMs) })}</p>
      {record.timing === 'late' ? <p className="md-lab-caution">{t('迟到累计观测，不是精确到期数据')}</p> : null}
      <p>{t('播放 / 阅读')}: {record.actuals?.views ?? t('未知')} · {t('比较状态')}: {t(({ 'unique-top-probability': '可比较', 'tied-top-probability': '最高概率并列，无唯一预测档位', 'missing-frozen-policy': '缺少当时的比较规则', 'not-quantitatively-comparable': '暂无有效定量比较' })[record.comparisonStatus] ?? '暂无有效定量比较')}</p>
      <p>{t('实际档位')}: {bucketName(record.observedBucket)} · {t('当时赋予的概率')}: {record.assignedProbability == null ? t('未知') : `${(record.assignedProbability * 100).toFixed(1)}%`}</p>
      <p>{t('预测命中')}: {record.bucketHit == null ? t('不适用（数据不足或最高概率并列）') : t(record.bucketHit ? '是' : '否')}</p>
      <p>{record.narrative?.summary}</p><p>{record.narrative?.learning}</p>{record.notes ? <p>{t('当时备注')}: {record.notes}</p> : null}<p className="md-muted">{t('已保存复盘为只读；后来的备注不会替换原记录。')}</p>
    </> : null}
  </div>
}

export function ContentLabStudio({ item }) {
  useLang(); const operationRevision = useContentLabOperations()
  const scope = contentLabScope(item), accountId = item.accountId ?? null
  const editing = useDesk(s => Boolean(s.articleEditing[item.id]))
  const metrics = useDesk(s => s.allState.metrics), identityItems = useDesk(s => s.allState.items)
  const focus = useDesk(s => s.contentLabFocus)
  const versions = item.contentVersions ?? []
  const [versionId, setVersionId] = React.useState(() => versions.at(-1)?.id ?? '')
  const [format, setFormat] = React.useState('script'), [rubricId, setRubricId] = React.useState('general-script-v1')
  const [horizon, setHorizon] = React.useState(3), [selected, setSelected] = React.useState(null)
  const [listing, setListing] = React.useState(null), [detail, setDetail] = React.useState(null), [error, setError] = React.useState('')
  const [refresh, setRefresh] = React.useState(0), [reviewed, setReviewed] = React.useState(false)
  const [publishedAt, setPublishedAt] = React.useState(() => { const value = getContentLabOperation(accountId, item.id, 'publish')?.input.publishedAt; if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23) }), [useNow, setUseNow] = React.useState(false), [url, setUrl] = React.useState(() => getContentLabOperation(accountId, item.id, 'publish')?.input.url ?? '')
  const [metricId, setMetricId] = React.useState(() => getContentLabOperation(accountId, item.id, 'retro')?.input.metricId ?? ''), [notes, setNotes] = React.useState(() => getContentLabOperation(accountId, item.id, 'retro')?.input.notes ?? '')
  const [selectionRevision, setSelectionRevision] = React.useState(0)
  const selectionEpoch = React.useRef(0), instance = React.useRef({ scope })
  if (instance.current.scope !== scope) { selectionEpoch.current++; instance.current = { scope } }
  const selection = React.useRef(null); selection.current = selected
  const selectedVersion = versions.find(v => v.id === versionId)
  const current = () => instance.current.scope === scope && contentLabScope(item) === scope
  const entries = listing?.scope === scope ? listing.items : []
  const loaded = detail?.scope === scope && detail.id === selected && detail.item === item ? detail.data : null
  const record = loaded?.record
  const full = loaded && !loaded.truncated
  const invalidateSelection = () => { selectionEpoch.current++; setSelectionRevision(n => n + 1); return selectionEpoch.current }
  const viewRecord = async id => { invalidateSelection(); setSelected(id); selection.current = id; setReviewed(false); setError('') }
  const captureRecovery = () => { const epoch = invalidateSelection(); return id => { if (current() && selectionEpoch.current === epoch) viewRecord(id) } }
  React.useEffect(() => {
    let alive = true
    readContentLab({ accountId, itemId: item.id, limit: 100 }).then(data => { if (alive && current()) setListing({ scope, ...data }) }).catch(err => { if (alive && current()) setError(err.message) })
    return () => { alive = false }
  }, [scope, refresh, operationRevision])
  React.useEffect(() => {
    if (!selected) return undefined
    let alive = true; const epoch = selectionEpoch.current
    setReviewed(false)
    readContentLab({ accountId, itemId: item.id, view: 'detail', recordId: selected, maxChars: 100000 }).then(data => { if (alive && current() && selection.current === selected && selectionEpoch.current === epoch) setDetail({ scope, id: selected, item, data }) }).catch(err => { if (alive && current() && selection.current === selected && selectionEpoch.current === epoch) setError(err.message) })
    return () => { alive = false }
  }, [scope, selected, item, refresh, selectionRevision])
  React.useEffect(() => { if (focus?.itemId === item.id && focus.recordId) viewRecord(focus.recordId) }, [focus, scope])
  const act = async intent => {
    const epoch = invalidateSelection()
    const result = await runContentLabAction(item.id, accountId, intent)
    if (current() && selectionEpoch.current === epoch) { setRefresh(n => n + 1); if (result?.record) viewRecord(result.record.id) }
  }
  const busy = action => isPending(getContentLabOperation(accountId, item.id, action))
  const prediction = record?.kind === 'prediction' ? record : null
  const relations = prediction && loaded.currentRelations?.predictionId === prediction.id ? loaded.currentRelations : null
  const publication = relations?.publication
  const completed = (relations?.retrospectiveCount ?? 0) > 0
  const eligibleMetrics = prediction && publication ? contentLabMetricOptions(metrics, identityItems, { ...prediction, dueAt: publication.dueAt }) : []
  const chosenMetric = eligibleMetrics.find(row => row.metric.id === metricId)
  return <details className="md-versions md-content-lab" open>
    <summary>{t('内容评估与复盘')}<span>{t('先评估，再预览，最后锁定')}</span></summary>
    <p className="md-muted">{t('评估、预测预览和复盘分别调用一次当前模型；查看、锁定和登记不调用模型。')}</p>
    <div className="md-lab-controls">
      <label>{t('所选保存版本')}<select aria-label={t('所选保存版本')} value={versionId} onChange={event => { invalidateSelection(); setVersionId(event.target.value); selection.current = null; setSelected(null); setReviewed(false) }}>{versions.map(version => <option key={version.id} value={version.id}>V{version.number}{version.name ? ` · ${version.name}` : ''} · {when(version.createdAt)}</option>)}</select></label>
      <label>{t('评估体裁')}<select aria-label={t('评估体裁')} value={format} onChange={event => { invalidateSelection(); const next = event.target.value; setFormat(next); setRubricId(next === 'article' ? 'general-article-v1' : 'general-script-v1') }}><option value="script">{t('脚本')}</option><option value="article">{t('文章')}</option></select></label>
      <label>{t('评估标准')}<select aria-label={t('评估标准')} value={rubricId} onChange={event => { invalidateSelection(); setRubricId(event.target.value) }}>{Object.entries(rubricNames).filter(([id]) => format === 'article' ? id === 'general-article-v1' : id !== 'general-article-v1').map(([id, name]) => <option key={id} value={id}>{t(name)}</option>)}</select></label>
      {!versions.length ? <button type="button" className="md-btn is-small" disabled={editing} onClick={async () => { const epoch = invalidateSelection(); const result = await runVersionOperation(item.id, { op: 'save_version' }); if (current() && selectionEpoch.current === epoch && result && !result.errors?.length) { const saved = getDesk().state.items.find(row => row.id === item.id)?.contentVersions?.at(-1); if (saved) setVersionId(saved.id) } }}>{t('先保存当前版本')}</button> : <button type="button" className="md-btn is-small" disabled={!selectedVersion || editing || busy('evaluate')} onClick={() => act({ action: 'evaluate', versionId, format, rubricId })}>{t('评估所选版本')}</button>}
    </div>
    {selectedVersion ? <p>{t('所选保存版本')}: V{selectedVersion.number}{selectedVersion.name ? ` · ${selectedVersion.name}` : ''} · {when(selectedVersion.createdAt)}</p> : null}
    {editing ? <p className="md-lab-caution">{t('请先完成或取消文章编辑，再操作版本。')}</p> : null}
    {['evaluate', 'forecast', 'lock', 'publish', 'retro'].map(action => <OperationNotice key={action} accountId={accountId} itemId={item.id} action={action} onRecovered={viewRecord} captureRecovery={captureRecovery} />)}
    {error ? <p role="alert" className="md-lab-caution">{error}<button type="button" className="md-link-btn" onClick={() => { setError(''); setRefresh(n => n + 1) }}>{t('重新读取')}</button></p> : null}
    {entries.length ? <nav className="md-lab-history" aria-label={t('评估与复盘历史')}>{[...entries].reverse().map(row => <button key={row.id} type="button" aria-pressed={selected === row.id} onClick={() => viewRecord(row.id)}>{t(row.kind === 'evaluation' ? '查看评估' : kindNames[row.kind] ?? '记录')} · {when(row.createdAt)}</button>)}</nav> : <p className="md-muted">{t('尚无评估记录。模型只会在你点击操作后运行。')}</p>}
    {listing?.scope === scope && listing.nextOffset != null ? <button type="button" className="md-link-btn" onClick={async () => { try { const data = await readContentLab({ accountId, itemId: item.id, limit: 100, offset: listing.nextOffset }); if (current()) setListing(previous => previous?.scope === scope ? { ...previous, items: [...previous.items, ...data.items], nextOffset: data.nextOffset } : previous) } catch (err) { if (current()) setError(err.message) } }}>{t('更多记录')}</button> : null}
    {loaded?.truncated ? <p className="md-lab-caution" role="alert">{t('记录过大，仅返回部分预览，无法在此锁定或登记。请使用有界接口分段核对原记录。')}</p> : null}
    {full ? <section className="md-lab-detail" aria-label={t('评估记录详情')}><ContentLabRecord record={record} />
      {record.contentVersionId ? <p className="md-muted">{t('评估保存版本')}: {(() => { const v = versions.find(row => row.id === record.contentVersionId); return v ? `V${v.number}${v.name ? ` · ${v.name}` : ''} · ${when(v.createdAt)}` : t('已归档版本') })()}</p> : null}
      {record.kind === 'evaluation' ? <div className="md-lab-stage"><label>{t('预测窗口（天）')}<input type="number" min="1" max="30" value={horizon} onChange={event => { invalidateSelection(); setHorizon(Number(event.target.value)) }} /></label><button type="button" className="md-btn is-small" disabled={editing || busy('forecast') || !Number.isInteger(horizon) || horizon < 1 || horizon > 30} onClick={() => act({ action: 'forecast', evaluationId: record.id, horizonDays: horizon })}>{t('生成预测预览')}</button></div> : null}
      {record.kind === 'forecast' ? <div className="md-lab-stage"><label className="md-lab-confirm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />{t('我已阅读完整预测预览，确认锁定后不可修改')}</label>{!loaded.currentEligibility?.lockable ? <p className="md-lab-caution">{t('此预览已失效或已有发布、数据记录；请保存并评估当前未发布版本。')}</p> : null}<button type="button" className="md-btn is-small" disabled={!reviewed || editing || busy('lock') || !loaded.currentEligibility?.lockable || selectedVersion?.id !== record.contentVersionId} onClick={() => act({ action: 'lock', forecastId: record.id })}>{t('锁定发布前预测')}</button></div> : null}
      {prediction && !relations ? <p className="md-lab-caution">{t('关联发布与复盘状态尚未确认，请重新读取后操作。')}<button type="button" className="md-link-btn" onClick={() => setRefresh(n => n + 1)}>{t('重新读取')}</button></p> : null}
      {prediction && relations && !publication ? <div className="md-lab-stage"><h4>{t('登记实际发布（本人确认）')}</h4><p className="md-muted">{t('请在平台实际发布后登记；排期时间不是实际发布时间。此操作不会向平台发帖。')}</p><label>{t('本人声明的实际发布时间')}<input type="datetime-local" step="1" value={publishedAt} disabled={useNow} onChange={event => setPublishedAt(event.target.value)} /></label><label className="md-lab-confirm"><input type="checkbox" checked={useNow} onChange={event => setUseNow(event.target.checked)} />{t('确认以提交时的当前时刻登记实际发布')}</label><label>{t('作品链接（可选）')}<input type="url" value={url} onChange={event => setUrl(event.target.value)} /></label><button type="button" className="md-btn is-small" disabled={editing || busy('publish') || (!useNow && (!publishedAt || !Number.isFinite(Date.parse(publishedAt))))} onClick={() => act({ action: 'publish', predictionId: prediction.id, publishedAt: useNow ? new Date().toISOString() : new Date(publishedAt).toISOString(), ...(url.trim() ? { url: url.trim() } : {}) })}>{t('登记实际发布（本人确认）')}</button></div> : null}
      {prediction && publication ? <div className="md-lab-stage"><p>{t('本人声明的实际发布时间')}: {when(publication.publishedAt)} · {t('复盘到期时间')}: {when(publication.dueAt)}</p>{publication.manuscriptMatch === 'mismatch' ? <p className="md-lab-caution">{t('登记时稿件与锁定版本不同，此记录不能用于预测校准。')}</p> : null}{completed ? <p>{t('已有复盘，请在历史中查看只读记录。')}{relations.latestRetrospectiveId ? <button type="button" className="md-link-btn" onClick={() => viewRecord(relations.latestRetrospectiveId)}>{t('查看已保存复盘')}</button> : null}</p> : <><label>{t('选择实际观测记录')}<select aria-label={t('选择实际观测记录')} value={metricId} onChange={event => setMetricId(event.target.value)}><option value="">{t('请选择，不自动使用最新累计值')}</option>{eligibleMetrics.map((row, index) => <option key={`${row.metric.id}:${index}`} value={row.metric.id} disabled={!row.eligible}>{row.metric.id} · {when(row.metric.collectedAt)} · {row.reason} · {t('播放')}: {row.views ?? t('未知')}</option>)}</select></label>{!eligibleMetrics.length ? <p>{t('尚无匹配数据，请先在复盘页录入可靠的实际采集时间。')}</p> : null}{chosenMetric ? <p>{t('实际观测时间')}: {when(chosenMetric.metric.collectedAt)} · {chosenMetric.reason}</p> : null}<label>{t('复盘备注')}<textarea maxLength={4000} rows={3} value={notes} onChange={event => setNotes(event.target.value)} /></label><button type="button" className="md-btn is-small" disabled={editing || busy('retro') || !chosenMetric?.eligible || Date.parse(publication.dueAt) > Date.now()} onClick={() => act({ action: 'retro', predictionId: prediction.id, metricId, notes })}>{t('保存到期复盘')}</button></>}</div> : null}
    </section> : selected && !loaded && !error ? <p role="status">{t('正在读取记录')}</p> : null}
  </details>
}

export function ContentLabQueue() {
  useLang(); const operationRevision = useContentLabOperations()
  const accountId = useDesk(s => s.accountId), workspaceRevision = useDesk(s => s.workspaceRevision), items = useDesk(s => s.state.items)
  const scope = JSON.stringify([accountId, workspaceRevision]), [listing, setListing] = React.useState(null), [error, setError] = React.useState(null), [refresh, setRefresh] = React.useState(0), [selected, setSelected] = React.useState(null), [detail, setDetail] = React.useState(null)
  const scopeRef = React.useRef(scope); scopeRef.current = scope
  React.useEffect(() => {
    let alive = true
    readContentLab({ ...(accountId !== undefined ? { accountId } : {}), view: 'queue', limit: 100 }).then(data => { if (alive && scopeRef.current === scope) { setListing({ scope, ...data }); setError(null) } }).catch(err => { if (alive && scopeRef.current === scope) setError({ scope, message: err.message }) })
    return () => { alive = false }
  }, [scope, refresh, operationRevision])
  React.useEffect(() => {
    if (selected?.scope !== scope) return undefined
    let alive = true
    readContentLab({ ...(accountId !== undefined ? { accountId } : {}), view: 'detail', recordId: selected.id, maxChars: 100000 }).then(data => { if (alive && scopeRef.current === scope) setDetail({ scope, id: selected.id, ...data }) }).catch(err => { if (alive && scopeRef.current === scope) setError({ scope, message: err.message }) })
    return () => { alive = false }
  }, [scope, selected])
  return <section className="md-tile md-content-lab md-lab-queue"><header className="md-tile-head"><h2>{t('预测与到期复盘')}</h2><button type="button" className="md-link-btn" onClick={() => setRefresh(n => n + 1)}>{t('刷新')}</button></header><p className="md-muted">{t('按实际发布时间计算到期；不会自动抓取、发布或运行模型。')}</p>
    {error?.scope === scope ? <p role="alert">{error.message}</p> : null}
    {listing?.scope === scope ? listing.items.length ? <ul>{[...listing.items].reverse().map(row => { const item = items.find(work => work.id === row.itemId && (work.accountId ?? null) === row.accountId); return <li key={row.id}><div><strong>{item?.production?.title ?? item?.title ?? t('已归档作品')}</strong><span className={`md-lab-status is-${row.status}`}>{t(statusNames[row.status] ?? '未知')}</span><small>{row.dueAt ? `${t('复盘到期时间')}: ${when(row.dueAt)}` : t('先登记实际发布时间')}</small></div><div><button type="button" className="md-btn is-small" onClick={() => setSelected({ scope, id: row.retrospectiveId ?? row.publicationId ?? row.id })}>{t('查看记录')}</button>{item ? <button type="button" className="md-btn is-small" onClick={() => { openItem(item.id); setDesk({ contentLabFocus: { itemId: item.id, recordId: row.id } }) }}>{t('打开内容处理')}</button> : <span>{t('记录保留在原账号，只读归档')}</span>}</div></li> })}</ul> : <p>{t('尚无已锁定预测。请在内容页打开作品，从保存版本开始评估。')}</p> : <p>{t('正在读取记录')}</p>}
    {listing?.scope === scope && listing.nextOffset != null ? <button type="button" className="md-link-btn" onClick={async () => { try { const data = await readContentLab({ ...(accountId !== undefined ? { accountId } : {}), view: 'queue', limit: 100, offset: listing.nextOffset }); if (scopeRef.current === scope) setListing(previous => previous?.scope === scope ? { ...previous, items: [...previous.items, ...data.items], nextOffset: data.nextOffset } : previous) } catch (err) { if (scopeRef.current === scope) setError({ scope, message: err.message }) } }}>{t('更多记录')}</button> : null}
    {detail?.scope === scope && selected?.scope === scope && detail.id === selected.id ? <div className="md-lab-detail"><button type="button" className="md-link-btn" onClick={() => setSelected(null)}>{t('关闭详情')}</button>{detail.truncated ? <p role="alert">{t('记录过大，仅显示元数据，完整记录未加载。')}</p> : <ContentLabRecord record={detail.record} />}</div> : null}
  </section>
}
