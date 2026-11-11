// Compose the same cover in the browser and local automation.
import { t } from './i18n.js'
import { paintCover } from '../src/cover-painter.js'

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(t('封面图读取失败')))
    image.src = src
  })
}

export async function composeCover({ src, text }) {
  const canvas = document.createElement('canvas')
  return paintCover(canvas, { image: src ? await loadImage(src) : undefined, text })
}

export async function coverDataUrl(options) {
  const canvas = await composeCover(options)
  return canvas.toDataURL('image/jpeg', 0.9)
}

export async function downloadCover(options, name) {
  const url = await coverDataUrl(options)
  const link = document.createElement('a')
  link.href = url
  link.download = `${String(name).replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 40) || t('视频封面')}.jpg`
  link.click()
}
