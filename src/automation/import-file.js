import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { imageSize } from 'image-size'
import { invalid } from './errors.js'

const IMAGE_LIMIT = 25_000_000
const VIDEO_LIMIT = 250_000_000
const formats = {
  '.jpg': ['image', 'image/jpeg', 'jpg'], '.jpeg': ['image', 'image/jpeg', 'jpg'],
  '.png': ['image', 'image/png', 'png'], '.webp': ['image', 'image/webp', 'webp'], '.gif': ['image', 'image/gif', 'gif'],
  '.mp4': ['video', 'video/mp4', 'mp4'], '.mov': ['video', 'video/quicktime', 'mov'], '.webm': ['video', 'video/webm', 'webm'],
}
const assetError = () => Object.assign(new Error('Local media is unavailable, unsupported, invalid, changed during import, or exceeds the import limits.'), { code: 'ASSET_ERROR' })
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino
const unchanged = (a, b) => identity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const dimensionsValid = ({ width, height }) => Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 40_000_000
let activeImports = 0

async function readAt(fd, length, position) {
  const bytes = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await fd.read(bytes, offset, length - offset, position + offset)
    if (!bytesRead) throw assetError()
    offset += bytesRead
  }
  return bytes
}

// Native decoders deliberately tolerate some incomplete files. Require the
// format's bounded chunks/segments and terminator before asking one to decode.
function validateImageStructure(bytes, type) {
  if (type === 'png') {
    let at = 8; let chunks = 0; let image = false
    while (at < bytes.length) {
      if (bytes.length - at < 12) throw assetError()
      const length = bytes.readUInt32BE(at); const name = bytes.toString('ascii', at + 4, at + 8)
      if (length > bytes.length - at - 12 || !/^[A-Za-z]{4}$/.test(name)) throw assetError()
      if (chunks++ === 0 && (name !== 'IHDR' || length !== 13)) throw assetError()
      at += length + 12
      if (name === 'IDAT') image = true
      if (name === 'IEND') { if (length !== 0 || !image || at !== bytes.length) throw assetError(); return }
    }
  } else if (type === 'jpg') {
    let at = 2; let scan = false; let sawScan = false
    if (bytes.readUInt16BE(0) !== 0xffd8) throw assetError()
    while (at < bytes.length) {
      if (scan) while (at < bytes.length && bytes[at] !== 0xff) at++
      if (bytes[at++] !== 0xff) throw assetError()
      while (bytes[at] === 0xff) at++
      const marker = bytes[at++]
      if (scan && (marker === 0 || marker >= 0xd0 && marker <= 0xd7) || marker === 1) continue
      if (marker === 0xd9) { if (!sawScan || at !== bytes.length) throw assetError(); return }
      if (!marker || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || bytes.length - at < 2) throw assetError()
      const length = bytes.readUInt16BE(at)
      if (length < 2 || length > bytes.length - at) throw assetError()
      at += length; scan = marker === 0xda; sawScan ||= scan
    }
  } else if (type === 'gif') {
    if (bytes.length < 14 || !/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) throw assetError()
    const tableSize = packed => packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0
    let at = 13 + tableSize(bytes[10]); let image = false
    const blocks = () => {
      while (at < bytes.length) { const length = bytes[at++]; if (length === 0) return; if (length > bytes.length - at) throw assetError(); at += length }
      throw assetError()
    }
    while (at < bytes.length) {
      const marker = bytes[at++]
      if (marker === 0x3b) { if (!image || at !== bytes.length) throw assetError(); return }
      if (marker === 0x21) { if (at >= bytes.length) throw assetError(); at++; blocks() }
      else if (marker === 0x2c) {
        if (bytes.length - at < 9 || !dimensionsValid({ width: bytes.readUInt16LE(at + 4), height: bytes.readUInt16LE(at + 6) })) throw assetError()
        at += 9 + tableSize(bytes[at + 8])
        if (at >= bytes.length || bytes[at] < 2 || bytes[at] > 8) throw assetError()
        at++; blocks(); image = true
      } else throw assetError()
    }
  } else if (type === 'webp') {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw assetError()
    let at = 12; let image = false
    while (at < bytes.length) {
      if (bytes.length - at < 8) throw assetError()
      const name = bytes.toString('ascii', at, at + 4); const length = bytes.readUInt32LE(at + 4)
      if (length > bytes.length - at - 8) throw assetError()
      at += 8 + length + (length & 1)
      if (['VP8 ', 'VP8L', 'ANMF'].includes(name) && length > 0) image = true
    }
    if (at === bytes.length && image) return
  }
  throw assetError()
}

function vint(bytes, offset, keepMarker = false) {
  const first = bytes[offset]
  if (!first) throw assetError()
  let length = 1; let marker = 0x80
  while (!(first & marker)) { length++; marker >>= 1 }
  if (length > (keepMarker ? 4 : 8) || offset + length > bytes.length) throw assetError()
  let value = BigInt(keepMarker ? first : first & (marker - 1))
  for (let i = 1; i < length; i++) value = value * 256n + BigInt(bytes[offset + i])
  return { length, value }
}

async function bmffBoxes(fd, start, end, budget) {
  const result = []
  for (let at = start; at < end;) {
    if (++budget.count > 4096 || end - at < 8) throw assetError()
    const header = await readAt(fd, Math.min(16, end - at), at)
    let length = header.readUInt32BE(0); let headerLength = 8
    if (length === 1) { if (header.length < 16) throw assetError(); const wide = header.readBigUInt64BE(8); if (wide > BigInt(end - at)) throw assetError(); length = Number(wide); headerLength = 16 }
    if (length === 0) length = end - at
    if (length < headerLength || length > end - at) throw assetError()
    result.push({ type: header.toString('ascii', 4, 8), offset: at, start: at + headerLength, end: at + length })
    at += length
  }
  return result
}

function requiredBox(boxes, type) {
  const matches = boxes.filter(box => box.type === type)
  if (matches.length !== 1) throw assetError()
  return matches[0]
}

async function fullBox(fd, box, version0, version1 = version0) {
  if (box.end - box.start < 4) throw assetError()
  const version = (await readAt(fd, 1, box.start))[0]
  if (version > 1 || box.end - box.start < (version ? version1 : version0)) throw assetError()
}

function unsignedTable(fd, start, count, width) {
  let first = -1; let cached = Buffer.alloc(0)
  return async index => {
    if (index < 0 || index >= count) throw assetError()
    if (first < 0 || index < first || (index - first) * width >= cached.length) {
      first = Math.floor(index / (65536 / width)) * (65536 / width)
      cached = await readAt(fd, Math.min(count - first, 65536 / width) * width, start + first * width)
    }
    return width === 8 ? cached.readBigUInt64BE((index - first) * width) : cached.readUInt32BE((index - first) * width)
  }
}

function mediaRange(offset, length, extents) {
  if (!Number.isSafeInteger(length) || length < 0 || length > VIDEO_LIMIT) throw assetError()
  const start = BigInt(offset); const end = start + BigInt(length)
  if (!extents.some(extent => start >= BigInt(extent.start) && end <= BigInt(extent.end))) throw assetError()
}

async function sampleSizes(fd, box) {
  const header = await readAt(fd, 12, box.start); const count = header.readUInt32BE(8)
  const fixed = box.type === 'stsz' ? header.readUInt32BE(4) : 0
  const bits = box.type === 'stsz' ? 32 : header[7]
  return { count, async sum(first, length) {
    if (first < 0 || first + length > count) throw assetError()
    if (fixed) { const result = fixed * length; if (!Number.isSafeInteger(result) || result > VIDEO_LIMIT) throw assetError(); return result }
    let result = 0
    for (let at = first; at < first + length;) {
      const samples = Math.min(first + length - at, 65536 * 8 / bits)
      const byteStart = Math.floor(at * bits / 8); const byteEnd = Math.ceil((at + samples) * bits / 8)
      const bytes = await readAt(fd, byteEnd - byteStart, box.start + 12 + byteStart)
      for (let index = at; index < at + samples; index++) {
        const offset = Math.floor(index * bits / 8) - byteStart
        result += bits === 32 ? bytes.readUInt32BE(offset) : bits === 16 ? bytes.readUInt16BE(offset) : bits === 8 ? bytes[offset] : index & 1 ? bytes[offset] & 15 : bytes[offset] >> 4
        if (result > VIDEO_LIMIT) throw assetError()
      }
      at += samples
    }
    return result
  } }
}

async function validateChunkReferences(fd, boxes, descriptions, extents) {
  const offsets = boxes.filter(box => ['stco', 'co64'].includes(box.type)); const sizes = boxes.filter(box => ['stsz', 'stz2'].includes(box.type))
  if (offsets.length !== 1 || sizes.length !== 1) throw assetError()
  const chunks = (await readAt(fd, 8, offsets[0].start)).readUInt32BE(4)
  const mapping = requiredBox(boxes, 'stsc'); const runs = (await readAt(fd, 8, mapping.start)).readUInt32BE(4)
  const samples = await sampleSizes(fd, sizes[0])
  if (!chunks) { if (runs || samples.count) throw assetError(); return samples.count }
  if (!runs || runs > chunks) throw assetError()
  const offsetAt = unsignedTable(fd, offsets[0].start + 8, chunks, offsets[0].type === 'co64' ? 8 : 4)
  const runAt = unsignedTable(fd, mapping.start + 8, runs * 3, 4)
  let sample = 0
  for (let run = 0; run < runs; run++) {
    const first = await runAt(run * 3); const perChunk = await runAt(run * 3 + 1); const description = await runAt(run * 3 + 2)
    const next = run + 1 < runs ? await runAt((run + 1) * 3) : chunks + 1
    if (run === 0 && first !== 1 || !perChunk || !description || description > descriptions || next <= first || next > chunks + 1) throw assetError()
    for (let chunk = first - 1; chunk < next - 1; chunk++) {
      mediaRange(await offsetAt(chunk), await samples.sum(sample, perChunk), extents)
      sample += perChunk
    }
  }
  if (sample !== samples.count) throw assetError()
  return sample
}

async function validateSampleTable(fd, boxes, video, budget, extents) {
  const description = requiredBox(boxes, 'stsd')
  await fullBox(fd, description, 8)
  const count = (await readAt(fd, 8, description.start)).readUInt32BE(4)
  const entries = await bmffBoxes(fd, description.start + 8, description.end, budget)
  if (!count || count !== entries.length) throw assetError()
  for (const entry of entries) {
    if (entry.end - entry.start < (video ? 78 : 8)) throw assetError()
    if (video) { const data = await readAt(fd, 28, entry.start); if (!data.readUInt16BE(6) || !data.readUInt16BE(24) || !data.readUInt16BE(26)) throw assetError() }
  }
  for (const type of ['stts', 'stsc']) requiredBox(boxes, type)
  if (!boxes.some(box => ['stco', 'co64'].includes(box.type)) || !boxes.some(box => ['stsz', 'stz2'].includes(box.type))) throw assetError()
  const strides = { stts: 8, stsc: 12, stco: 4, co64: 8, ctts: 8, stss: 4 }
  for (const box of boxes) {
    const length = box.end - box.start
    if (strides[box.type]) {
      await fullBox(fd, box, 8)
      if (length !== 8 + (await readAt(fd, 8, box.start)).readUInt32BE(4) * strides[box.type]) throw assetError()
    } else if (box.type === 'stsz' || box.type === 'stz2') {
      await fullBox(fd, box, 12); const data = await readAt(fd, 12, box.start); const count = data.readUInt32BE(8)
      const bits = box.type === 'stsz' ? data.readUInt32BE(4) ? 0 : 32 : data[7]
      if (box.type === 'stz2' && ![4, 8, 16].includes(bits) || length !== 12 + Math.ceil(count * bits / 8)) throw assetError()
    }
  }
  return { descriptions: count, samples: await validateChunkReferences(fd, boxes, count, extents) }
}

async function validateMovie(fd, movie, budget, extents) {
  const children = await bmffBoxes(fd, movie.start, movie.end, budget)
  await fullBox(fd, requiredBox(children, 'mvhd'), 100, 112)
  const tracks = children.filter(box => box.type === 'trak')
  if (!tracks.length) throw assetError()
  let video = false; const trackInfo = new Map(); const defaults = new Map()
  for (const track of tracks) {
    const parts = await bmffBoxes(fd, track.start, track.end, budget)
    const trackHeader = requiredBox(parts, 'tkhd'); await fullBox(fd, trackHeader, 84, 96)
    const identity = await readAt(fd, 24, trackHeader.start); const trackId = identity.readUInt32BE(identity[0] ? 20 : 12)
    if (!trackId || trackInfo.has(trackId)) throw assetError()
    const media = requiredBox(parts, 'mdia'); const mediaParts = await bmffBoxes(fd, media.start, media.end, budget)
    await fullBox(fd, requiredBox(mediaParts, 'mdhd'), 24, 36)
    const handler = requiredBox(mediaParts, 'hdlr'); await fullBox(fd, handler, 24)
    const isVideo = (await readAt(fd, 12, handler.start)).toString('ascii', 8, 12) === 'vide'
    const info = requiredBox(mediaParts, 'minf'); const infoParts = await bmffBoxes(fd, info.start, info.end, budget)
    if (isVideo) await fullBox(fd, requiredBox(infoParts, 'vmhd'), 12)
    const table = requiredBox(infoParts, 'stbl')
    const samples = await validateSampleTable(fd, await bmffBoxes(fd, table.start, table.end, budget), isVideo, budget, extents)
    trackInfo.set(trackId, { ...samples, video: isVideo })
    video ||= isVideo
  }
  if (!video) throw assetError()
  const extendsMovie = children.filter(box => box.type === 'mvex')
  if (extendsMovie.length > 1) throw assetError()
  if (extendsMovie.length) for (const box of await bmffBoxes(fd, extendsMovie[0].start, extendsMovie[0].end, budget)) if (box.type === 'trex') {
    await fullBox(fd, box, 24); const bytes = await readAt(fd, 24, box.start); const id = bytes.readUInt32BE(4); const description = bytes.readUInt32BE(8)
    if (bytes[0] || box.end - box.start !== 24 || !trackInfo.has(id) || defaults.has(id) || !description || description > trackInfo.get(id).descriptions) throw assetError()
    defaults.set(id, { description, size: bytes.readUInt32BE(16) })
  }
  return { tracks: trackInfo, defaults }
}

async function fragmentTrack(fd, box, moof, first, movie) {
  const length = box.end - box.start
  if (length < 8 || length > 32) throw assetError()
  const bytes = await readAt(fd, length, box.start); const flags = bytes.readUInt32BE(0) & 0xffffff; const id = bytes.readUInt32BE(4)
  if (bytes[0] || flags & ~0x03003b || !movie.tracks.has(id)) throw assetError()
  const result = { id, size: movie.defaults.get(id)?.size, description: movie.defaults.get(id)?.description ?? 1, empty: Boolean(flags & 0x010000) }
  let at = 8
  if (flags & 1) { if (length - at < 8) throw assetError(); result.base = bytes.readBigUInt64BE(at); at += 8 }
  else if (flags & 0x020000 || first) result.base = BigInt(moof.offset)
  else throw assetError() // Implicit base chaining across multiple traf boxes is unsupported.
  for (const [flag, key] of [[2, 'description'], [8, 'duration'], [16, 'size'], [32, 'flags']]) if (flags & flag) {
    if (length - at < 4) throw assetError(); result[key] = bytes.readUInt32BE(at); at += 4
  }
  if (at !== length || !result.description || result.description > movie.tracks.get(id).descriptions) throw assetError()
  return result
}

async function fragmentRun(fd, box, track, previous, extents) {
  await fullBox(fd, box, 8)
  const header = await readAt(fd, Math.min(16, box.end - box.start), box.start)
  const flags = header.readUInt32BE(0) & 0xffffff; const count = header.readUInt32BE(4)
  if (flags & ~0x000f05 || track.empty && count) throw assetError()
  let at = 8; let start = previous ?? track.base
  if (flags & 1) { if (header.length - at < 4) throw assetError(); start = track.base + BigInt(header.readInt32BE(at)); at += 4 }
  if (flags & 4) at += 4
  const stride = [0x100, 0x200, 0x400, 0x800].filter(flag => flags & flag).length * 4
  if (box.end - box.start !== at + count * stride) throw assetError()
  let size = 0
  if (flags & 0x200) {
    const sizeOffset = flags & 0x100 ? 4 : 0
    for (let sample = 0; sample < count;) {
      const length = Math.min(count - sample, Math.floor(65536 / stride)); const data = await readAt(fd, length * stride, box.start + at + sample * stride)
      for (let i = 0; i < length; i++) { size += data.readUInt32BE(i * stride + sizeOffset); if (size > VIDEO_LIMIT) throw assetError() }
      sample += length
    }
  } else { if (count && track.size === undefined) throw assetError(); size = count * (track.size ?? 0) }
  if (count) mediaRange(start, size, extents)
  return { end: start + BigInt(size), count }
}

async function validateFragments(fd, boxes, movie, extents, budget) {
  let videoSamples = [...movie.tracks.values()].some(track => track.video && track.samples > 0)
  for (const moof of boxes.filter(box => box.type === 'moof')) {
    const children = await bmffBoxes(fd, moof.start, moof.end, budget)
    await fullBox(fd, requiredBox(children, 'mfhd'), 8)
    const tracks = children.filter(box => box.type === 'traf')
    if (!tracks.length) throw assetError()
    for (const [index, box] of tracks.entries()) {
      const parts = await bmffBoxes(fd, box.start, box.end, budget)
      const track = await fragmentTrack(fd, requiredBox(parts, 'tfhd'), moof, index === 0, movie)
      const decodeTimes = parts.filter(part => part.type === 'tfdt'); if (decodeTimes.length > 1) throw assetError()
      if (decodeTimes.length) await fullBox(fd, decodeTimes[0], 8, 12)
      const runs = parts.filter(part => part.type === 'trun'); if (!runs.length && !track.empty) throw assetError()
      let previous
      for (const run of runs) {
        const result = await fragmentRun(fd, run, track, previous, extents); previous = result.end
        if (movie.tracks.get(track.id).video && result.count) videoSamples = true
      }
    }
  }
  if (!videoSamples) throw assetError()
}

async function ebmlElements(fd, start, end, budget, allowUnknownCluster = false) {
  const result = []
  for (let at = start; at < end;) {
    if (++budget.count > 4096) throw assetError()
    const head = await readAt(fd, Math.min(12, end - at), at)
    const id = vint(head, 0, true); const length = vint(head, id.length)
    const content = at + id.length + length.length
    const unknown = length.value === (1n << BigInt(7 * length.length)) - 1n
    if (unknown && !(allowUnknownCluster && id.value === 0x1f43b675n) || !unknown && length.value > BigInt(end - content)) throw assetError()
    const next = unknown ? end : content + Number(length.value)
    result.push({ id: id.value, start: content, end: next }); at = next
  }
  return result
}

function requiredElement(elements, id) {
  const matches = elements.filter(element => element.id === id)
  if (matches.length !== 1) throw assetError()
  return matches[0]
}

async function ebmlUnsigned(fd, element) {
  const length = element.end - element.start
  if (length < 1 || length > 8) throw assetError()
  let value = 0n
  for (const byte of await readAt(fd, length, element.start)) value = value * 256n + BigInt(byte)
  return value
}

async function validateWebm(fd, size) {
  const head = await readAt(fd, Math.min(size, 12), 0)
  if (head.length < 5 || head.readUInt32BE(0) !== 0x1a45dfa3) throw assetError()
  const header = vint(head, 4); const end = 4 + header.length + Number(header.value)
  if (end > 65536 || end > size - 5) throw assetError()
  const budget = { count: 0 }; const children = await ebmlElements(fd, 4 + header.length, end, budget)
  const docType = requiredElement(children, 0x4282n)
  if (docType.end - docType.start !== 4 || (await readAt(fd, 4, docType.start)).toString('ascii') !== 'webm') throw assetError()
  const segmentHeader = await readAt(fd, Math.min(12, size - end), end)
  if (segmentHeader.readUInt32BE(0) !== 0x18538067) throw assetError()
  const length = vint(segmentHeader, 4); const start = end + 4 + length.length
  const unknown = length.value === (1n << BigInt(7 * length.length)) - 1n
  if (!unknown && length.value !== BigInt(size - start)) throw assetError()
  const elements = await ebmlElements(fd, start, size, budget, true)
  const info = requiredElement(elements, 0x1549a966n); const infoParts = await ebmlElements(fd, info.start, info.end, budget)
  if (!infoParts.length) throw assetError()
  for (const part of infoParts) if (part.id === 0x2ad7b1n && !await ebmlUnsigned(fd, part)) throw assetError()
  const tracks = requiredElement(elements, 0x1654ae6bn); const trackParts = await ebmlElements(fd, tracks.start, tracks.end, budget)
  const entries = trackParts.filter(part => part.id === 0xaen)
  if (!entries.length) throw assetError()
  let video = false
  for (const entry of entries) {
    const parts = await ebmlElements(fd, entry.start, entry.end, budget)
    if (!await ebmlUnsigned(fd, requiredElement(parts, 0xd7n))) throw assetError()
    const type = await ebmlUnsigned(fd, requiredElement(parts, 0x83n)); const codec = requiredElement(parts, 0x86n)
    if (codec.end <= codec.start || codec.end - codec.start > 100) throw assetError()
    if (type === 1n) { if (!(await readAt(fd, codec.end - codec.start, codec.start)).toString('ascii').startsWith('V_')) throw assetError(); video = true }
  }
  const clusters = elements.filter(element => element.id === 0x1f43b675n)
  if (!video || !clusters.length) throw assetError()
  for (const cluster of clusters) {
    const parts = await ebmlElements(fd, cluster.start, cluster.end, budget)
    await ebmlUnsigned(fd, requiredElement(parts, 0xe7n))
  }
}

async function validateVideo(fd, size, extension) {
  if (extension === '.webm') return validateWebm(fd, size)
  // Bounded metadata/container checks, not codec or frame validation.
  const budget = { count: 0 }; const boxes = await bmffBoxes(fd, 0, size, budget)
  const fileTypes = boxes.filter(box => box.type === 'ftyp')
  if (fileTypes.length > 1 || !fileTypes.length && extension !== '.mov') throw assetError()
  if (fileTypes.length) {
    const box = fileTypes[0]; const length = box.end - box.start
    if (length < 8 || length > 4096 || length % 4 !== 0) throw assetError()
    const primary = (await readAt(fd, 4, box.start)).toString('ascii')
    if (!(extension === '.mov' ? primary === 'qt  ' : /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash|MSNV)$/.test(primary))) throw assetError()
  }
  const extents = boxes.filter(box => box.type === 'mdat' && box.end > box.start)
  if (!extents.length) throw assetError()
  const movie = await validateMovie(fd, requiredBox(boxes, 'moov'), budget, extents)
  await validateFragments(fd, boxes, movie, extents, budget)
}

async function removeOwned(path, created) {
  try { const current = await lstat(path, { bigint: true }); if (current.isFile() && identity(created, current)) await unlink(path) } catch { /* Retain an orphan if ownership or cleanup cannot be established. */ }
}

/** One host-local file, one exact-byte private copy, then the caller's serialized Store commit. */
export async function importLocalFile({ path, filesDir, imagesOnly = false }, commit) {
  if (!isAbsolute(path) || path.includes('\0')) throw invalid('path must be an absolute local file path on the workbench host.')
  if (activeImports >= 2) throw Object.assign(new Error('Two local media imports are already active. Inspect those requests before starting another.'), { code: 'BUSY' })
  activeImports++
  let source; let destination; let target; let created; let committed = false
  try {
    const extension = extname(path).toLowerCase(); const format = formats[extension]
    if (!format || imagesOnly && format[0] !== 'image') throw assetError()
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) throw assetError()
    source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const snapshot = await source.stat({ bigint: true })
    const limit = format[0] === 'image' ? IMAGE_LIMIT : VIDEO_LIMIT
    if (!snapshot.isFile() || !unchanged(before, snapshot) || snapshot.size <= 0n || snapshot.size > BigInt(limit)) throw assetError()
    const size = Number(snapshot.size)
    let dimensions = {}
    let imageBytes
    if (format[0] === 'image') {
      imageBytes = await readAt(source, size, 0)
      const header = imageSize(imageBytes)
      if (header.type !== format[2] || !dimensionsValid(header)) throw assetError()
      validateImageStructure(imageBytes, format[2])
      const { loadImage } = await import('@napi-rs/canvas')
      const decoded = await loadImage(imageBytes)
      if (!dimensionsValid(decoded)) throw assetError()
      dimensions = { w: decoded.width, h: decoded.height }
    } else await validateVideo(source, size, extension)
    const directory = await lstat(filesDir, { bigint: true })
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw assetError()
    const canonicalDir = await realpath(filesDir)
    if (!identity(directory, await lstat(canonicalDir, { bigint: true }))) throw assetError()
    const filename = `${randomUUID()}.${format[2]}`
    target = join(canonicalDir, filename)
    destination = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = await destination.stat({ bigint: true })
    if (!identity(directory, await lstat(filesDir, { bigint: true }))) throw assetError()
    const hash = createHash('sha256')
    for (let position = 0; position < size;) {
      const count = Math.min(1024 * 1024, size - position)
      const bytes = imageBytes ? imageBytes.subarray(position, position + count) : await readAt(source, count, position)
      hash.update(bytes); await destination.writeFile(bytes); position += count
    }
    await destination.sync(); await destination.close(); destination = null
    if (!unchanged(snapshot, await source.stat({ bigint: true }))) throw assetError()
    await source.close(); source = null
    const asset = { kind: format[0], mimeType: format[1], bytes: size, sha256: hash.digest('hex'), media: { src: `media-desk/files/${filename}`, ...dimensions } }
    // A caller marks an uncertain Store commit explicitly; never unlink its potentially referenced asset.
    const result = await commit(asset, basename(path).slice(0, 300))
    committed = true
    return result
  } catch (error) {
    if (error.code === 'OUTCOME_UNKNOWN') { committed = true; throw error }
    if (['INVALID_ARGUMENT', 'BUSY'].includes(error.code)) throw error
    throw assetError()
  } finally {
    await destination?.close().catch(() => {})
    await source?.close().catch(() => {})
    if (!committed && created) await removeOwned(target, created)
    activeImports--
  }
}
