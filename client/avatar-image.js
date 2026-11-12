const MAX_BYTES = 5 * 1024 * 1024
const TYPES = ['image/jpeg', 'image/png', 'image/webp']

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file)
  const src = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = src
    })
  } finally { URL.revokeObjectURL(src) }
}

export async function prepareAvatarImage(file) {
  if (!file || !TYPES.includes(file.type)) throw new Error('请选择 JPEG、PNG 或 WebP 图片。')
  if (!Number.isFinite(file.size) || file.size > MAX_BYTES || file.size <= 0) throw new Error('头像图片不能超过 5 MB。')
  let image
  try {
    image = await decodeImage(file)
    const width = image.width || image.naturalWidth, height = image.height || image.naturalHeight
    if (!(width > 0 && height > 0)) throw new Error('Invalid dimensions')
    const side = Math.min(width, height)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 256, 256)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .86))
    if (!blob || blob.type !== 'image/webp' || !blob.size) throw new Error('Encoding failed')
    return blob
  } catch {
    throw new Error('无法读取头像图片，请选择其他图片。')
  } finally { image?.close?.() }
}
