// 校验链接是否指向公开网络。图片地址来自不可信数据，不能让它访问本机或内网服务。
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { tr } from './i18n.js'

function isPrivateAddress(address) {
  if (address === '::1' || address === '::') return true
  const lower = address.toLowerCase()
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true
  let v4 = lower.startsWith('::ffff:') ? lower.slice(7) : lower
  // URL 解析器会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1
  const mapped = /^([\da-f]{1,4}):([\da-f]{1,4})$/.exec(v4)
  if (mapped) {
    const high = parseInt(mapped[1], 16)
    const low = parseInt(mapped[2], 16)
    v4 = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  if (isIP(v4) !== 4) return false
  const [a, b] = v4.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** 粘贴的链接可能来自任何地方，不能让它访问本机或内网服务。 */
export async function assertPublicUrl(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(tr('只支持 http 和 https 链接'))
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error(tr('不能抓取本机地址'))
  const records = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  if (records.some(record => isPrivateAddress(record.address))) throw new Error(tr('不能抓取内网地址'))
  return url
}
