import { API_BASE, CHUNK_PX } from './config.js'

/** All-zero chunk (blank canvas / missing chunk). */
export function blankChunkBytes() {
  return new Uint8Array(CHUNK_PX * CHUNK_PX)
}

export async function fetchCanvases() {
  const res = await fetch(`${API_BASE}/api/canvases`)
  if (!res.ok) throw new Error(`/canvases ${res.status}`)
  return res.json()
}

export async function fetchChunk(canvasId, cx, cy, signal = null) {
  let retries = 3
  while (retries > 0) {
    try {
      const res = await fetch(`${API_BASE}/chunks/${canvasId}/${cx}/${cy}`, { signal })
      if (res.status === 404) return blankChunkBytes()
      if (res.ok) {
        const buf = await res.arrayBuffer()
        if (buf.byteLength > 0) {
          return new Uint8Array(buf)
        }
        return blankChunkBytes()
      }
    } catch (err) {
      if (signal?.aborted) throw err
    }
    retries--
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  return blankChunkBytes()
}

function tsToHistoryParts(ts) {
  const d = new Date(ts * 1000)
  const pad2 = n => String(n).padStart(2, '0')
  const day =
    String(d.getUTCFullYear()) +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate())
  const hhmm = pad2(d.getUTCHours()) + pad2(d.getUTCMinutes())
  return { day, hhmm }
}

async function loadHistoryPng(url, signal = null) {
  let retries = 3
  while (retries > 0) {
    try {
      const res = await fetch(url, { signal })
      if (res.status === 404) return null
      if (res.ok) {
        const blob = await res.blob()
        return await blobToImage(blob)
      }
    } catch (err) {
      if (signal?.aborted) throw err
    }
    retries--
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  return null
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(blob)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('history png decode failed'))
    }
    img.src = objectUrl
  })
}

function flattenPalette(palette) {
  if (!palette?.length) return []
  return Array.isArray(palette[0]) ? palette.flat() : palette
}

function fillUnset(ctx, palette) {
  const r = palette[0] ?? 0
  const g = palette[1] ?? 0
  const b = palette[2] ?? 0
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillRect(0, 0, CHUNK_PX, CHUNK_PX)
}

const paletteLookups = new Map()

function getPaletteLookup(canvasId, palette) {
  let lookup = paletteLookups.get(canvasId)
  if (!lookup) {
    lookup = new Uint8Array(16777216)
    if (palette) {
      for (let i = 0; i < palette.length / 3; i++) {
        const r = palette[i * 3]
        const g = palette[i * 3 + 1]
        const b = palette[i * 3 + 2]
        lookup[(r << 16) | (g << 8) | b] = i
      }
    }
    paletteLookups.set(canvasId, lookup)
  }
  return lookup
}

const isLittleEndian = (() => {
  const buf = new ArrayBuffer(4)
  new Uint32Array(buf)[0] = 0x12345678
  return new Uint8Array(buf)[0] === 0x78
})()

function imageDataToIndices(pixels, lookup, { transparentToZero = false } = {}) {
  const indices = new Uint8Array(CHUNK_PX * CHUNK_PX)
  const u32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4)

  if (isLittleEndian) {
    for (let i = 0; i < u32.length; i++) {
      const val = u32[i]
      const a = (val >> 24) & 0xff
      if (transparentToZero && a < 128) {
        indices[i] = 0
        continue
      }
      const b = (val >> 16) & 0xff
      const g = (val >> 8) & 0xff
      const r = val & 0xff
      indices[i] = lookup[(r << 16) | (g << 8) | b]
    }
  } else {
    for (let i = 0; i < u32.length; i++) {
      const val = u32[i]
      const r = (val >> 24) & 0xff
      const g = (val >> 16) & 0xff
      const b = (val >> 8) & 0xff
      const a = val & 0xff
      if (transparentToZero && a < 128) {
        indices[i] = 0
        continue
      }
      indices[i] = lookup[(r << 16) | (g << 8) | b]
    }
  }
  return indices
}

export async function fetchHistoryChunk(canvasId, ts, cx, cy, palette, signal = null) {
  const { day, hhmm } = tsToHistoryParts(ts)
  const baseUrl = `/history/chunk/${canvasId}/${day}/0000/${cx}_${cy}.png`
  const diffUrl = hhmm !== '0000'
    ? `/history/chunk/${canvasId}/${day}/${hhmm}/${cx}_${cy}.png`
    : null

  const [baseImg, diffImg] = await Promise.all([
    loadHistoryPng(baseUrl, signal),
    diffUrl ? loadHistoryPng(diffUrl, signal) : Promise.resolve(null),
  ])

  const flat = flattenPalette(palette)
  const offscreen = document.createElement('canvas')
  offscreen.width = CHUNK_PX
  offscreen.height = CHUNK_PX
  const ctx = offscreen.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = false

  // Draw nginx snapshot PNGs directly so write-time colors show even if the
  // live palette has changed. Diff tRNS pixels leave the root visible.
  if (baseImg) ctx.drawImage(baseImg, 0, 0)
  else fillUnset(ctx, flat)
  if (diffImg) ctx.drawImage(diffImg, 0, 0)

  let raw = blankChunkBytes()
  try {
    const pixels = ctx.getImageData(0, 0, CHUNK_PX, CHUNK_PX).data
    raw = imageDataToIndices(pixels, getPaletteLookup(canvasId, flat))
  } catch { /* display still works from the composited canvas */ }
  return { raw, offscreen }
}

export async function fetchHistoryEnabled() {
  try {
    const res = await fetch(`${API_BASE}/history/enabled`)
    if (!res.ok) return false
    const { enabled } = await res.json()
    return !!enabled
  } catch { return false }
}
