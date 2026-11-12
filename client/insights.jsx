// 数据复盘。
import React from 'react'
import { ContentLabQueue } from './content-lab.jsx'
import { AccountBadge } from './accounts.jsx'
import { dispatchOps, getDesk, fetchInsights, learnSkills, openItem, setDesk, toast, useDesk } from './desk.js'
import { ConnectDialog } from './connect.jsx'
import { normalizePlatform } from '../src/platforms.js'
import { collectionTimestamp, COUNTERS, validCounter } from '../src/metrics.js'
import { lang, plural, t, useLang } from './i18n.js'
import { Icon, Segmented } from './ui.jsx'
const clip = (text, n) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text)
import { compact, platformChoices, displayItem, fmtDate, posterOf, dayKey } from './util.js'
const counterName = key => t(({ views: '播放', likes: '点赞', comments: '评论', shares: '转发', saves: '收藏' })[key] ?? '其他数据项')
const sourceName = source => source == null ? t('未知') : source === 'manual' ? t('手动录入') : source === 'demo' ? t('示例数据') : source
const reasonName = code => t(({ 'unknown-timestamp': '采集时间未知', 'invalid-timestamp': '采集时间格式无效', 'future-timestamp': '采集时间晚于当前时间', baseline: '首次记录，没有增量基线', 'cross-day': '跨日区间未计入日内增量', missing: '相邻记录缺少数据项', invalid: '相邻记录含无效数据', decrease: '累计数据下降', 'equal-time-conflict': '同一采集时间的数据冲突', 'no identifiable work': '无法确认对应作品', 'ambiguous externalId': '外部作品编号不唯一', 'linked item not in scope': '关联作品不在当前范围', 'missing/invalid platform': '平台缺失或无效', 'no linked snapshot': '没有关联的数据记录', 'missing/invalid fields': '数据项缺失或无效', 'collection-time-unknown': '采集时间未知', 'legacy-date-order-only': '仅按历史统计日期暂排', 'timed-and-undated-incomparable': '部分记录缺少采集时间，先后关系不确定', 'source-unknown': '来源未知', 'legacy-zero-provenance': '历史零值可能来自自动补零', 'retained-earlier-field': '部分数据沿用较早记录', 'invalid-counter': '含无效数据项', collection: '按采集时间选用', 'legacy-date': '按历史统计日期暂排', deterministic: '先后关系未知，按固定规则暂选', 'aggregate-overflow': '合计超出可精确表示范围', 'legacy-import-time-only': '仅有历史导入完成时间，采集时间未知', 'legacy-import-time': '按历史导入完成时间暂排', 'local-response-observed': '本机收到作品数据响应的时间', 'self-declared': '录入者声明的时间' })[code] ?? '其他原因')
const known = value => value == null ? t('未知') : compact(value)
const exact = value => value == null ? t('未知') : value.toLocaleString()

/** 带数量的文字：英文在 1 时用单数那条 key；{s} 给共用词典里写成 piece{s} 的那种。 */
function count(n, one, other, vars = {}) {
  return t(plural(n, one, other), { n: Number(n).toLocaleString(), s: n === 1 ? '' : 's', ...vars })
}

function niceMax(value) {
  if (value <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find(n => n * pow >= value) ?? 10
  return step * pow
}

/** 单序列折线：十字准线 + 提示框，配一份可切换的表格。 */
function TrendChart({ daily: rows, field }) {
  const daily = rows.map(row => ({ ...row, value: row[field] }))
  const [hover, setHover] = React.useState(null)
  const box = React.useRef(null)
  const [size, setSize] = React.useState({ width: 640, height: 220 })
  React.useLayoutEffect(() => {
    const el = box.current
    if (!el) return undefined
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: Math.max(entry.contentRect.height, 140) }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const { width, height } = size
  const pad = { l: 44, r: 12, t: 12, b: 26 }
  const max = niceMax(Math.max(0, ...daily.map(d => d.value).filter(v => v != null)))
  const x = i => pad.l + (i / Math.max(daily.length - 1, 1)) * (width - pad.l - pad.r)
  const y = v => pad.t + (1 - v / max) * (height - pad.t - pad.b)
  let connected = false
  const line = daily.map((d, i) => {
    if (d.value == null) { connected = false; return '' }
    const gap = i > 0 && (Date.parse(d.date) - Date.parse(daily[i - 1].date)) > 86400000
    const part = `${connected && !gap ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(d.value).toFixed(1)}`
    connected = true
    return part
  }).filter(Boolean).join(' ')
  const ticks = [0, 0.5, 1].map(t => t * max)
  const labelEvery = Math.ceil(daily.length / Math.max(Math.floor(width / 72), 2))
  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left - pad.l) / (width - pad.l - pad.r)
    setHover(Math.max(0, Math.min(daily.length - 1, Math.round(ratio * (daily.length - 1)))))
  }
  const point = hover === null ? null : daily[hover]
  return (
    <div className="md-chart" ref={box}>
      <svg width={width} height={height} role="img" aria-label={t('已观测到的部分增量；缺口表示未知')} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map(tick => (
          <g key={tick}>
            <line x1={pad.l} x2={width - pad.r} y1={y(tick)} y2={y(tick)} className="md-chart-grid" />
            <text x={pad.l - 8} y={y(tick) + 4} textAnchor="end" className="md-chart-axis">{compact(tick)}</text>
          </g>
        ))}
        {daily.map((d, i) => (i % labelEvery === 0 ? <text key={d.date} x={x(i)} y={height - 6} textAnchor="middle" className="md-chart-axis">{Number(d.date.slice(5, 7))}/{Number(d.date.slice(8, 10))}</text> : null))}
        <path d={line} className="md-chart-line" pathLength="1" />
        {point?.value != null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} className="md-chart-cross" />
            <circle cx={x(hover)} cy={y(point.value)} r="4.5" className="md-chart-dot" />
          </g>
        ) : null}
      </svg>
      {point ? (
        <div className="md-chart-tip" style={{ left: Math.min(x(hover) + 12, width - 150), top: point.value == null ? 0 : Math.max(y(point.value) - 56, 0) }}>
          <small>{fmtDate(`${point.date}T12:00:00`)}</small>
          <b>{point.value == null ? t('未知') : field === 'views' ? count(point.value, '1 播放', '{n} 播放') : count(point.value, '1 互动', '{n} 互动')}</b>
          {field === 'views' ? <small>{point.engaged == null ? t('未知') : count(point.engaged, '1 互动', '{n} 互动')}</small> : null}
        </div>
      ) : null}
    </div>
  )
}

function addMetric(items, platform) {
  const accountId=getDesk().accountId
  const account=getDesk().state.accounts.find(a=>a.id===accountId)
  setDesk({
    dialog: {
      title: t('录入一条数据'),
      initial: { platform: platform || account?.platform || '公众号', date: dayKey(new Date()) },
      fields: [
        { name: 'itemId', label: t('对应内容'), type: 'select', options: [{ value: '', label: t('不关联内容') }, ...items.filter(i => !i.parentId).map(i => ({ value: i.id, label: displayItem(i).title.slice(0, 26) }))] },
        { name: 'platform', label: t('平台'), type: 'select', options: platformChoices().map(v => ({ value: v, label: t(v) })) },
        { name: 'date', label: t('日期'), type: 'date', required: true },
        { name: 'collectedAt', label: t('实际采集时间（可选，不清楚请留空）'), type: 'datetime-local' },
        { name: 'snapshotNote', label: t('请填写累计数据；空白项保持未知。来源标记为手动录入，由录入者声明。'), type: 'hidden' },
        { name: 'views', label: t('播放 / 阅读'), type: 'number' },
        { name: 'likes', label: t('点赞'), type: 'number' },
        { name: 'comments', label: t('评论'), type: 'number' },
        { name: 'shares', label: t('转发'), type: 'number' },
        { name: 'saves', label: t('收藏'), type: 'number' },
      ],
      onSubmit: (v) => {
        const counters = Object.fromEntries(COUNTERS.filter(key => v[key] !== undefined && String(v[key]).trim() !== '').map(key => [key, Number(v[key])]))
        if (Object.values(counters).some(value => !validCounter(value))) { toast(t('数据必须是非负整数，且不超过 9007199254740991。'), { error: true }); return }
        const collectedAt = v.collectedAt ? new Date(v.collectedAt).toISOString() : undefined
        dispatchOps([{ op: 'add_metric', itemId: v.itemId || null, platform: v.platform, date: new Date(`${v.date}T12:00:00`).toISOString(), ...counters, source: 'manual', ...(collectedAt ? { collectedAt } : {}) }], { label: t('录入数据'), accountId })
      },
    },
  })
}

/** Legacy date remains a stat date. Optional itemId/collectedAt/source columns are explicit. */
export function parseCsv(text) {
  const ops = []
  const errors = []
  let header = null
  String(text).trim().split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    const cols = line.split(/[,，\t]/).map(c => c.trim())
    if (index === 0 && !/\d/.test(cols[0])) { header = cols[0].toLowerCase() === 'date' ? cols : null; return }
    const names = header ?? ['date', 'platform', ...COUNTERS, 'itemId', 'collectedAt', 'source']
    const values = Object.fromEntries(names.map((name, i) => [name, cols[i] ?? '']))
    const date = new Date(values.date)
    const platform = normalizePlatform(values.platform)
    const counters = Object.fromEntries(COUNTERS.filter(key => values[key]?.trim()).map(key => [key, Number(values[key])]))
    if (Number.isNaN(date.getTime()) || !platform) {
      errors.push(index + 1)
      return
    }
    if (Object.values(counters).some(value => !validCounter(value)) || (values.collectedAt && !collectionTimestamp(values.collectedAt))) { errors.push(index + 1); return }
    ops.push({ op: 'add_metric', platform, date: date.toISOString(), ...counters, ...(values.itemId ? { itemId: values.itemId } : {}), ...(values.collectedAt ? { collectedAt: values.collectedAt } : {}), ...(values.source ? { source: values.source } : {}) })
  })
  return { ops, errors }
}

function importCsv() {
  const accountId=getDesk().accountId
  setDesk({
    dialog: {
      title: t('粘贴 CSV 数据'),
      submitLabel: t('导入'),
      fields: [{ name: 'csv', label: t('列顺序：日期、平台、播放、点赞、评论、转发、收藏、内容编号、采集时间、来源。最后三列可选；空白数据保持未知，采集时间须带时区。'), type: 'textarea', rows: 7, required: true, placeholder: t('2026-10-30,公众号,3200,120,18,40,66') }],
      onSubmit: (values) => {
        const { ops, errors } = parseCsv(values.csv ?? '')
        const done = count(ops.length, '导入 1 条数据', '导入 {n} 条数据')
        if (ops.length) dispatchOps(ops, { label: done, silent: true, accountId })
        toast(errors.length ? t('导入 {n} 条，第 {rows} 行格式不对', { n: ops.length, rows: errors.slice(0, 5).join(t('、')) }) : done, { error: errors.length > 0, undo: !errors.length && ops.length > 0 })
      },
    },
  })
}

function Metric({ label, value, unit, wide }) {
  return <div className={`md-metric ${wide ? 'is-wide' : ''}`}><dt>{label}</dt><dd>{value}{unit ? <small>{unit}</small> : null}</dd></div>
}

function CoveragePanel({ coverage: c, timeline, rateCoverage }) {
  if (!c) return null
  return <section className="md-tile md-i-coverage">
    <header className="md-tile-head"><h2>{t('数据覆盖情况')}</h2></header>
    <p><strong>{c.withData} / {c.published}</strong> {t('有数据的作品 / 已发布作品')} · {c.withViews} {t('篇有播放数据')} · {c.complete} {t('篇最新记录含五项数值（历史零值待核实）')} · {c.completeCounters ?? c.complete} {t('篇五项均有数值（含沿用历史值，历史零值待核实）')}</p>
    <p>{c.rawRecords} {t('条原始记录')} · {c.uniqueWorks} {t('组不同作品与平台')} · {c.excludedRecords} {t('条无法确认作品的记录未计入汇总')}</p>
    <p>{t('有记录的数据项')}: {COUNTERS.map(key => `${counterName(key)}: ${c.fieldCounts?.[key] ?? 0}`).join(' · ')}</p>
    <p>{t('最近确认的采集时间')} ({t(c.latestCollectedAtScope === 'all selected valid fields' ? '全部选用的有效数据项' : '仅采集时间明确的数据项')}): <strong>{c.latestCollectedAt ?? t('未知')}</strong></p>
    <p>{c.unknownTimeRecords} {t('条记录的采集时间未知')} ({c.unknownTimeWorks} {t('组作品与平台')}) · {c.unknownSourceRecords} {t('条记录的来源未知')}</p>
    <p className="md-muted">{t('来源由录入者声明，统计日期和保存时间不能证明采集时间。采集时间明确的记录优先；这不代表无采集时间的记录一定更早。')}</p>
    <p className="md-muted">{t('Monid 采集时间表示本机收到作品数据响应的时刻，不保证平台在该时刻刷新计数。历史导入完成时间仅用于暂排，不能作为采集时间。')}</p>
    {c.legacyZeroRecords > 0 ? <p className="md-muted">{t('历史零值说明：旧版本可能自动补零，现已无法区分实测零值；原始数值予以保留。')} ({c.legacyZeroRecords})</p> : null}
    {rateCoverage ? <p className="md-muted">{rateCoverage.matchedWorks} / {rateCoverage.totalWorks} {t('组作品与平台可计算互动率：播放须大于零，且四项互动与播放来自同一条记录。')}</p> : null}
    <p className="md-muted">{t('只有相邻且采集时间可靠的记录才能计算增量；首次记录为未知基线。缺项、无效值、下降或同一时间冲突都会中断计算。跨日差值单列保留，不计入某一天；日内增量只是部分观测。')}</p>
    {timeline?.reasons ? <p>{t('趋势缺口与排除原因')}: {Object.entries(timeline.reasons).map(([reason, n]) => `${reasonName(reason)}: ${n}`).join(' · ') || t('无')}</p> : null}
    {c.excludedReasons?.length ? <p>{c.excludedReasons.map(row => `${reasonName(row.reason)}: ${row.count}`).join(' · ')}</p> : null}
    <details open={c.missingWorksCount > 0}>
      <summary>{t('数据不完整的已发布作品')} ({c.missingWorksCount})</summary>
      <ul>{(c.missingWorks ?? []).slice(0, 30).map(row => <li key={`${row.id}:${row.platform}`}>
        <strong>{row.title}</strong> · {t(row.platform) || t('未知')} — {reasonName(row.reason)}； {t('最新选用记录中缺失或无效的数据项')}: {row.missingFields.map(counterName).join('、')}; {t('沿用的历史数据项')}: {row.retainedFields?.map(counterName).join('、') || t('无')}; {t('来源')}: {sourceName(row.source)}; {t('最近确认的采集时间')}: {row.latestCollectedAt ?? t('未知')}
      </li>)}</ul>
      {(c.missingEntriesCount ?? c.missingWorksCount) > 30 ? <p>{t('仅显示前 30 组数据不完整的作品与平台。')} ({c.missingEntriesCount ?? c.missingWorksCount} {t('组')})</p> : null}
    </details>
  </section>
}

export function InsightsView() {
  useLang()
  const items = useDesk(s => s.state.items)
  const metrics = useDesk(s => s.state.metrics)
  const skills = useDesk(s => s.state.skills)
  const [result, setResult] = React.useState(null)
  const [platform, setPlatform] = React.useState('')
  const [show, setShow] = React.useState('chart')
  const [connecting, setConnecting] = React.useState(false)
  const accounts = useDesk(s => s.state.accounts)
  const accountId = useDesk(s => s.accountId)
  const workspaceRevision = useDesk(s => s.workspaceRevision)
  const scopeKey = JSON.stringify({ accountId, platform, workspaceRevision })
  const data = result?.scopeKey === scopeKey && result.items === items && result.metrics === metrics ? result.data : null
  React.useEffect(() => {
    let alive = true
    fetchInsights(platform || undefined, accountId).then((next) => {
      if (alive) setResult({ scopeKey, items, metrics, data: next })
    }).catch(err => { if (alive) toast(err.message, { error: true }) })
    return () => { alive = false }
  }, [metrics, items, platform, accountId, scopeKey])
  const kuaishou = (platform || accounts.find(account => account.id === accountId)?.platform) === '快手'
  const filters = (
    <div className="md-insights-filter">
      <label>{t('平台筛选')} <select aria-label={t('复盘平台筛选')} value={platform} onChange={event => setPlatform(event.target.value)}>
        <option value="">{t('全部平台')}</option>
        {platformChoices().map(value => <option key={value} value={value}>{t(value)}</option>)}
      </select></label>
      {kuaishou ? <p className="md-muted">{t('快手支持手动录入、CSV 和 API 数据复盘；暂不支持 Monid 自动抓取。')}</p> : null}
    </div>
  )
  if (!data) return <div className="md-board-page">{filters}<ContentLabQueue /><div className="md-tile md-i-hero" /></div>
  // 有真实数据后，不再把示例规则当建议
  const proposed = skills.filter(s => s.status === 'proposed' && (data.hasSample || !s.sample))
  // 有的平台公开接口读不到播放量，这时统一按互动来比
  const hasViews = data.views != null
  const barKey = data.platforms.every(p => p.views != null) ? 'views' : 'engaged'
  const maxBar = Math.max(1, ...data.platforms.map(p => p[barKey]).filter(v => v != null))
  const realAccounts = accounts.some(row => row.externalId)
  const dialog = connecting ? <ConnectDialog onClose={() => setConnecting(false)} /> : null
  const best = data.top[0]
  const bestItem = best && items.find(i => i.id === best.id)
  const heroPic = bestItem && posterOf(displayItem(bestItem))
  const actions = (
    <div className="md-hero-actions">
      {kuaishou ? null : <button type="button" className="md-pill is-primary" onClick={() => setConnecting(true)}><Icon name="user" size={14} />{t('导入账号数据')}</button>}
      <button type="button" className="md-pill" onClick={() => addMetric(platform ? items.filter(item => item.platform === platform) : items, platform)}><Icon name="plus" size={14} />{t('录入数据')}</button>
      <button type="button" className="md-pill" onClick={importCsv}><Icon name="upload" size={14} />{t('粘贴 CSV')}</button>
    </div>
  )
  return (
    <div className="md-board-page">
      {filters}
      <ContentLabQueue />
      <div className="md-insights">
        <section className="md-tile md-i-hero">
          <div className="md-hero-copy">
            <h1 className="md-i-line">
              {t('作品累计数据')}: <b>{exact(data.views)}</b> {t('播放')} · <b>{data.coverage?.withData ?? data.top.length} / {data.published ?? 0}</b> {t('有数据的作品 / 已发布作品')}{best ? t('，') : t('。')}
              {best ? <><br />{t('表现最好的是')} {heroPic ? <img className="md-inline-pic" src={heroPic} alt="" draggable={false} /> : null} <b>{clip(best.title, lang() === 'en' ? 30 : 14)}</b>{t('。')}</> : null}
            </h1>
            {actions}
          </div>
          <dl className="md-metrics">
            <Metric label={t('互动率')} value={data.engagementRate == null ? t('未知') : (data.engagementRate * 100).toFixed(1)} unit={data.engagementRate == null ? '' : '%'} />
            <Metric label={t('总互动')} value={known(data.engaged)} unit={data.engagedPartial ? t('部分') : ''} />
            {realAccounts && data.followers ? <Metric label={t('粉丝')} value={compact(data.followers)} /> : <Metric label={lang() === 'en' ? t('平台（数量）') : '平台'} value={data.platforms.length} unit={t('个')} />}
          </dl>
          {data.hasSample ? <span className="md-i-sample">{t('示例数据')}</span> : null}
        </section>

        {data.overflowFields?.length ? <p className="md-muted">{t('部分合计超出可精确表示范围，显示为未知；原始数据保持不变。')}</p> : null}
        <CoveragePanel coverage={data.coverage} timeline={data.timeline} rateCoverage={data.rateCoverage} />

        <section className="md-tile md-i-trend">
          <header className="md-tile-head">
            <h2>{t('已观测增量（部分）')}</h2>
            <span className="md-grow" />
            <Segmented label={t('显示方式')} value={show} onChange={setShow} options={[{ value: 'chart', label: t('图') }, { value: 'table', label: t('表') }]} />
          </header>
          {!data.daily.length ? <p className="md-muted">{t('尚无可计算的增量趋势。累计数据和覆盖情况仍显示在上方。')}</p> : show === 'chart' ? <div className="md-i-chart"><TrendChart daily={data.daily} field={hasViews ? 'views' : 'engaged'} /></div> : (
            <div className="md-i-table">
              <table className="md-table is-plain">
                <thead><tr><th>{t('日期')}</th>{hasViews ? <th className="is-num">{t('播放')}</th> : null}<th className="is-num">{t('互动')}</th></tr></thead>
                <tbody>{[...data.daily].reverse().map(d => <tr key={d.date}><td>{lang() === 'en' ? fmtDate(`${d.date}T12:00:00`) : d.date}</td>{hasViews ? <td className="is-num">{exact(d.views)}</td> : null}<td className="is-num">{exact(d.engaged)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </section>

        <section className="md-tile md-i-platforms">
          <header className="md-tile-head"><h2>{t('平台分布')}</h2><span className="md-tile-meta">{barKey === 'views' ? t('播放') : t('互动')}</span></header>
          <ul className="md-bars" aria-label={barKey === 'views' ? t('各平台播放') : t('各平台互动')}>
            {data.platforms.map(platform => (
              <li key={platform.platform} title={t('{platform}：{views} 播放，{likes} 赞，{saves} 收藏', { platform: t(platform.platform), views: exact(platform.views), likes: exact(platform.likes), saves: exact(platform.saves) })}>
                <span>{t(platform.platform)}</span>
                <b>{known(platform[barKey])}</b>
                <span className="md-bar-track"><i style={{ width: platform[barKey] == null ? '0%' : `${(platform[barKey] / maxBar) * 100}%` }} /></span>
              </li>
            ))}
          </ul>
        </section>

        <section className="md-tile md-i-top">
          <header className="md-tile-head"><h2>{t('表现最好的内容')}</h2></header>
          <ol className="md-top">
            {data.top.slice(0, 5).map((row, index) => {
              const item = items.find(i => i.id === row.id)
              const poster = item && posterOf(displayItem(item))
              return (
                <li key={row.streamKey ?? `${row.id}:${row.platform}`}>
                  <button type="button" onClick={() => openItem(row.id)}>
                    <span className="md-top-rank">{index + 1}</span>
                    <span className="md-thumb">{poster ? <img src={poster} alt="" loading="lazy" /> : null}</span>
                    <span className="md-top-title"><strong>{row.title}</strong>{item?<AccountBadge item={item} />:null}<small>{t(row.platform)} · {t('{likes} 赞 · {saves} 收藏', { likes: known(row.likes), saves: known(row.saves) })}</small><small>{t('来源')}: {sourceName(row.source)} · {t('最近确认的采集时间')}: {row.latestCollectedAt ?? t('未知')}</small>{row.warnings?.length ? <small>{row.warnings.map(reasonName).join(' · ')}</small> : null}</span>
                    <b>{known(row.views)}</b>
                  </button>
                  <details><summary>{t('查看各项数据的来源')}</summary><ul>{COUNTERS.map(key => <li key={key}>{counterName(key)}: {exact(row[key])} · {t('来源')}: {sourceName(row.provenance?.[key]?.source)} · {t('采集时间')}: {row.provenance?.[key]?.collectedAt ?? t('未知')} · {row.provenance?.[key]?.ordering ? reasonName(row.provenance[key].ordering) : t('未知')}</li>)}</ul></details>
                </li>
              )
            })}
          </ol>
        </section>

        <section className="md-tile md-i-advice">
          <header className="md-tile-head">
            <h2>{t('给你的建议')}</h2>
            <span className="md-grow" />
            <button type="button" className="md-pill is-small" onClick={learnSkills}><Icon name="spark" size={13} />{t('重新分析')}</button>
          </header>
          <div className="md-i-advice-list">
            <p className="md-muted">{t('已有建议的依据是历史记录，可能使用旧统计方法。“重新分析”只新增尚未提出的建议，不会重算或改写已有规则。')}</p>
            {proposed.length ? proposed.slice(0, 4).map(skill => (
              <div key={skill.id} className="md-i-tip">
                <strong>{skill.name}</strong>
                <p>{skill.evidence ?? skill.rule}</p>
                <button type="button" className="md-pill is-small" onClick={() => dispatchOps([{ op: 'update_skill', id: skill.id, status: 'active' }], { label: t('启用规则「{name}」', { name: skill.name }) })}>{t('写进规则')}</button>
              </div>
            )) : <p className="md-muted">{t('点「重新分析」，从现有数据里找出值得坚持的做法。')}</p>}
          </div>
        </section>
      </div>
      {dialog}
    </div>
  )
}
