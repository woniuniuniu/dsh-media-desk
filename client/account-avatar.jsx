import React from 'react'
import { normalizeAccountAvatar } from '../src/avatar.js'

const COLORS = ['#d5d9ef', '#cbe4de', '#ead9c4', '#e5d1df', '#d6e1ba', '#cce0ec']

export function AccountAvatar({ account, size = 36 }) {
  let src = null
  try { src = normalizeAccountAvatar(account?.avatar ?? null) } catch { /* Old invalid values use the fallback. */ }
  const currentSource = React.useRef(src)
  currentSource.current = src
  const [failedSource, setFailedSource] = React.useState(null)
  const name = account?.handle || account?.title || account?.id || '?'
  const words = name.trim().split(/\s+/)
  const initials = (words.length > 1 ? words.map(word => Array.from(word)[0]).slice(0, 2) : Array.from(name).slice(0, 2)).join('').toLocaleUpperCase()
  const hash = Array.from(account?.id || name).reduce((value, character) => (value * 31 + character.codePointAt(0)) >>> 0, 0)
  return (
    <span className="md-account-avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * .34), backgroundColor: COLORS[hash % COLORS.length] }}>
      {src && failedSource !== src
        ? <img key={src} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => { if (currentSource.current === src) setFailedSource(src) }} />
        : initials}
    </span>
  )
}
