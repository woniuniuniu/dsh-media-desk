// Canonical values are shared by browser choices, prompts and automation schemas.
export const PLATFORMS = ['公众号', '小红书', '抖音', 'B站', '视频号', '快手', 'TikTok', 'Instagram', 'YouTube', 'X']
export const PLATFORM_EN = { 公众号: 'WeChat', 小红书: 'RedNote', 抖音: 'Douyin', B站: 'Bilibili', 视频号: 'WeChat Channels', 快手: 'Kuaishou', TikTok: 'TikTok', Instagram: 'Instagram', YouTube: 'YouTube', X: 'X' }
export const PLATFORM_ALIASES = {
  ...Object.fromEntries(PLATFORMS.flatMap(name => [[name.toLowerCase(), name], [PLATFORM_EN[name].toLowerCase(), name]])),
  xiaohongshu: '小红书', channels: '视频号', kwai: '快手', ig: 'Instagram', twitter: 'X',
}
export function normalizePlatform(value) {
  return PLATFORM_ALIASES[String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')]
}

/** Prefer complete English names, then canonical Chinese names. Avoid matching X in ordinary words. */
export function platformInText(text) {
  const value = String(text).toLowerCase()
  const aliases = Object.keys(PLATFORM_ALIASES).filter(name => name !== 'x' && /^[a-z ]+$/.test(name)).sort((a, b) => b.length - a.length)
  for (const alias of aliases) {
    if (new RegExp(`\\b${alias.replace(/ /g, '\\s+')}\\b`, 'i').test(value)) return PLATFORM_ALIASES[alias]
  }
  return PLATFORMS.find(name => /[^\x00-\x7f]/.test(name) && value.includes(name.toLowerCase()))
    ?? (/\bon X\b/.test(String(text)) ? 'X' : undefined)
}
