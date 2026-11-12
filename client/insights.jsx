// 复盘：统计值均来自 Host，只负责展示。
import React from 'react'
import { fetchInsights, toast, useDesk } from './desk.js'
import { compact, insightLink, linePath, num1, pct, signed, t } from './util.js'
import { Empty } from './ui.jsx'

function TopPost({ row }) {
  const url = insightLink(row.url)
  return (
    <li>
      <p>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{row.text}</a> : row.text}</p>
      <small className="md-muted">{t('浏览 {views} · 点赞 {likes} · 回复 {replies} · 转发 {reposts}', { views: compact(row.views), likes: compact(row.likes), replies: compact(row.replies), reposts: compact(row.reposts) })}{row.typeName ? ` · ${row.typeName}` : ''}</small>
    </li>
  )
}

export function InsightsView() {
  const mineCount = useDesk(s => s.state.mine?.length ?? 0)
  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  React.useEffect(() => {
    if (!mineCount) return
    let active = true
    setLoading(true)
    fetchInsights().then(result => {
      if (!active) return
      if (result) setData(result)
      else toast(t('复盘数据刷新失败'), { error: true })
      setLoading(false)
    })
    return () => { active = false }
  }, [mineCount])
  if (!mineCount) return <div className="md-page"><Empty title={t('还没有复盘数据')} hint={t('这里的数据来自交换文件夹的 mine/ 目录，接上 Grok Bot 后才会有。')} /></div>
  if (loading && !data) return <div className="md-page"><p className="md-shimmer" role="status">{t('正在算…')}</p></div>
  if (!data) return <div className="md-page"><Empty title={t('复盘数据加载失败')} /></div>
  const { followers, totals, byType, top, replies, funnel, edits } = data
  return (
    <div className="md-page">
      <div className="md-insights">
        <section className="md-panel md-insights-section">
          <h3>{t('粉丝')}</h3>
          <strong className="md-insights-number">{compact(followers.now)}</strong>
          <p className="md-muted">{t('7 天 {n}', { n: signed(followers.delta7) })}　{t('30 天 {n}', { n: signed(followers.delta30) })}</p>
          {followers.series.length < 2 ? <p className="md-muted">{t('数据还不够画曲线')}</p> : <svg className="md-insights-chart" viewBox="0 0 600 120" role="img" aria-label={t('粉丝变化曲线')}><path d={linePath(followers.series, 600, 120)} fill="none" stroke="var(--accent)" strokeWidth="2" /></svg>}
        </section>
        <div className="md-insights-totals">
          {Object.entries({ d7: '最近 7 天', d30: '最近 30 天' }).map(([key, label]) => <section key={key} className="md-panel md-insights-section">
            <h3>{t(label)}</h3>
            <dl className="md-insights-metrics">{Object.entries({ posts: '发帖', replies: '回复', views: '浏览', likes: '点赞' }).map(([metric, name]) => <div key={metric}><dt>{t(name)}</dt><dd>{compact(totals[key][metric])}</dd></div>)}</dl>
          </section>)}
        </div>
        <section className="md-panel md-insights-section">
          <h3>{t('哪类内容更好')}</h3>
          {byType.length ? <div className="md-insights-table"><table><thead><tr>{['类型', '条数', '平均浏览', '平均互动'].map(label => <th scope="col" key={label}>{t(label)}</th>)}</tr></thead><tbody>{byType.map(row => <tr key={row.typeId}><td>{row.name}</td><td>{compact(row.posts)}</td><td>{num1(row.avgViews)}</td><td>{num1(row.avgEngagement)}</td></tr>)}</tbody></table></div> : <p className="md-muted">{t('还没有能对应到类型的内容')}</p>}
        </section>
        <section className="md-panel md-insights-section">
          <h3>{t('表现最好的 5 条')}</h3>
          <ul className="md-insights-top">{top.map(row => <TopPost key={row.id} row={row} />)}</ul>
        </section>
        <section className="md-panel md-insights-section">
          <h3>{t('回复')}</h3>
          <p>{t('起草 {n} 条，发出 {m} 条（{rate}），平均互动 {engagement}', { n: replies.drafted, m: replies.sent, rate: pct(replies.sentRate), engagement: num1(replies.avgEngagement) })}</p>
        </section>
        <section className="md-panel md-insights-section">
          <h3>{t('候选稿去向（30 天）')}</h3>
          <p>{t('出稿 {n}；通过 {a}；已发 {s}；丢弃 {d}（不感兴趣 {x}、不像我 {y}、过时了 {z}、没说原因 {w}）；过期 {e}', { n: funnel.drafted, a: funnel.approved, s: funnel.sent, d: funnel.discarded, x: funnel.discardReasons.not_interested, y: funnel.discardReasons.not_me, z: funnel.discardReasons.stale, w: funnel.discardReasons.none, e: funnel.expired })}</p>
        </section>
        <section className="md-panel md-insights-section">
          <h3>{t('修改习惯')}</h3>
          <p>{t('比对了 {n} 对草稿和实发内容', { n: edits.pairs })}</p>
          {edits.medianLengthRatio !== null ? <p>{t('实发长度大约是草稿的 {ratio}', { ratio: pct(edits.medianLengthRatio) })}</p> : null}
        </section>
      </div>
    </div>
  )
}
