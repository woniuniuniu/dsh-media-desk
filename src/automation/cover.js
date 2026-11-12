import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paintCover, WIDTH, HEIGHT } from '../cover-painter.js'
const ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets')
const TRUSTED_FONTS = ['/System/Library/Fonts/Supplemental/Songti.ttc', '/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc', '/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc']
const assetError = message => Object.assign(new Error(message), { code: 'ASSET_ERROR', status: 400 })
export async function resolveProductionAsset(src, filesDir) {
  const match = /^media-desk\/(files|assets)\/([\w.-]+)$/.exec(src ?? '')
  if (!match || match[2] === '.' || match[2] === '..') throw assetError('Cover/asset must be a plugin-owned local image.')
  const root = match[1] === 'files' ? filesDir : ASSETS_DIR
  const path = join(root, match[2])
  try {
    const rootInfo = await lstat(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error()
    const info = await lstat(path); const base = await realpath(root); const actual = await realpath(path)
    if (info.isSymbolicLink() || !info.isFile() || !actual.startsWith(base + sep) || info.size > 25000000) throw new Error()
    return path
  } catch { throw assetError('Local asset is missing, unsafe or too large.') }
}
export async function validateProductionAssets(production, filesDir) {
  const sources = new Map()
  for (const asset of [production.cover, ...production.images ?? [], ...production.shots ?? []]) if (asset?.src && !sources.has(asset.src)) sources.set(asset.src, await resolveProductionAsset(asset.src, filesDir))
  return sources
}
let renderer
async function nativeRenderer() {
  if (!renderer) renderer = import('@napi-rs/canvas').then(async canvas => {
    for (const path of TRUSTED_FONTS) { try { if ((await lstat(path)).isFile()) canvas.GlobalFonts.registerFromPath(path, 'Songti SC') } catch {} }
    return canvas
  }).catch(() => { renderer = null; throw assetError('Local cover renderer is unavailable on this platform.') })
  return renderer
}
export async function renderProductionCover(production, { filesDir }) {
  try {
    const { createCanvas, loadImage } = await nativeRenderer()
    const image = production.cover?.src ? await loadImage(await readFile(await resolveProductionAsset(production.cover.src, filesDir))) : undefined
    const canvas = paintCover(createCanvas(WIDTH, HEIGHT), { image, text: production.coverText || production.title || '' })
    return canvas.toBuffer('image/jpeg', 90)
  } catch (e) { if (e.code === 'ASSET_ERROR') throw e; throw assetError('Cover image could not be read or rendered.') }
}
