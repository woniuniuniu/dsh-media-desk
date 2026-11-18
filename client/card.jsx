// 灵感卡片：散落、瀑布流复用同一张卡。
import React from 'react'
import { setDesk, useDesk } from './desk.js'
import { t } from './i18n.js'
import { Icon } from './ui.jsx'
import { KIND_LABEL, STATUS_LABEL, displayItem, hash, relativeDay } from './util.js'

export function Media({ item, autoPlay = false, controls = false, onFirstFrame }) {
  const ref = React.useRef(null)
  const [broken, setBroken] = React.useState(false)
  const videoKind = item.kind === 'video'
  // 浏览器可在 DOM 移除后继续加载媒体；清理捕获的节点，主动释放后台连接。
  React.useEffect(() => {
    const media = ref.current
    if (!media) return
    // StrictMode 会清理后重放 setup；恢复刚才主动移除的 src。
    const src = !videoKind || autoPlay || controls ? item.media?.src : undefined
    if (src && media.getAttribute('src') !== src) media.setAttribute('src', src)
    return () => {
      if (videoKind) media.pause()
      media.removeAttribute('srcset')
      media.removeAttribute('src')
      if (videoKind) media.load()
    }
  }, [videoKind])
  React.useEffect(() => {
    const video = ref.current
    if (!video || item.kind !== 'video') return
    if (autoPlay) video.play().catch(() => {})
    else {
      video.pause()
    }
  }, [autoPlay, controls, item.kind, item.media?.src])
  if (!item.media || broken) return <div className="md-media-fallback"><span>{item.title.slice(0, 1)}</span></div>
  const ratio = item.media.w && item.media.h ? { aspectRatio: `${item.media.w} / ${item.media.h}` } : undefined
  if (item.kind === 'video') {
    return <video ref={ref} className="md-media" style={ratio} src={autoPlay || controls ? item.media.src : undefined} poster={item.media.poster} muted={!controls} loop playsInline controls={controls} preload="none" onError={() => setBroken(true)} />
  }
  return <img ref={ref} className="md-media" style={ratio} src={item.media.src} alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(true)} onLoad={onFirstFrame} />
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export function Card({ item: raw, onOpen }) {
  const item = displayItem(raw)
  const inverted = item.pinned
  const running = item.production?.status === 'running'
  const [hover, setHover] = React.useState(false)
  const focused = useDesk(s => Boolean(s.focusId))
  React.useEffect(() => { if (focused) setHover(false) }, [focused])
  const hasMedia = Boolean(item.media) && ['image', 'video', 'web'].includes(item.kind)
  const lines = hash(item.id) % 2 === 0

  return (
    <article
      className={`md-card kind-${item.kind} ${inverted ? 'is-inverted' : ''} ${item.status === 'published' ? 'is-published' : ''}`}
      data-card={item.id}
      tabIndex={0}
      role="button"
      aria-label={t('{kind}：{title}', { kind: t(KIND_LABEL[item.kind]), title: item.title })}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={event => onOpen?.(raw, event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen?.(raw, event)
        }
      }}
    >
      {hasMedia ? (
        <div className="md-card-media" data-media={item.id}>
          {focused ? <div className="md-media-fallback" aria-hidden="true"><span>{item.title.slice(0, 1)}</span></div> : <Media item={item} autoPlay={hover} />}
          {item.kind === 'video' ? <span className="md-card-play"><Icon name="play" size={12} fill /></span> : null}
        </div>
      ) : null}

      {item.kind === 'quote' ? (
        <blockquote className="md-card-quote">{item.title}</blockquote>
      ) : item.kind === 'note' ? (
        <div className="md-card-note">
          {item.rel ? <span className="md-card-rel">{item.rel}</span> : null}
          <h3>{item.title}</h3>
          {item.body ? <p className={lines ? 'is-ruled' : ''}>{item.body}</p> : null}
        </div>
      ) : (
        <div className="md-card-caption"><h3>{item.title}</h3></div>
      )}

      <footer className="md-card-foot">
        <span className={`md-dot status-${item.status}`} title={t(STATUS_LABEL[item.status])} />
        <span className="md-card-source">{item.kind === 'web' && item.url ? hostOf(item.url) : item.source || t(KIND_LABEL[item.kind])}</span>
        <span className="md-card-time">{running ? <span className="md-shimmer">{t('正在成稿')}</span> : item.production?.status === 'done' ? t('已成稿') : item.scheduledAt && item.status !== 'published' ? relativeDay(item.scheduledAt) : ''}</span>
      </footer>
    </article>
  )
}

export function openCapture(tab = 'text') {
  setDesk({ capture: { tab } })
}
