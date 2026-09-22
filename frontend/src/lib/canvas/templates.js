import { parseCoordNumbers, formatCoordXY } from '../coords.js'

export const TEMPLATE_DB_NAME = 'PixmapTemplates'
export const TEMPLATE_DB_VERSION = 1
export const TEMPLATE_STORE_NAME = 'images'
export const TEMPLATE_STORAGE_KEY = 'pixmap:templates'

export function openTemplateDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TEMPLATE_DB_NAME, TEMPLATE_DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(TEMPLATE_STORE_NAME)) {
        db.createObjectStore(TEMPLATE_STORE_NAME)
      }
    }
  })
}

export async function saveTemplateImageToDB(id, blob) {
  const db = await openTemplateDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEMPLATE_STORE_NAME, 'readwrite')
    const request = tx.objectStore(TEMPLATE_STORE_NAME).put(blob, id)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function getTemplateImageFromDB(id) {
  const db = await openTemplateDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEMPLATE_STORE_NAME, 'readonly')
    const request = tx.objectStore(TEMPLATE_STORE_NAME).get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function deleteTemplateImageFromDB(id) {
  const db = await openTemplateDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEMPLATE_STORE_NAME, 'readwrite')
    const request = tx.objectStore(TEMPLATE_STORE_NAME).delete(id)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function loadImageFromInput(input) {
  const img = new Image()
  if (typeof input === 'string') {
    img.src = input
  } else {
    const url = URL.createObjectURL(input)
    img.src = url
    await img.decode()
    URL.revokeObjectURL(url)
    return img
  }
  await img.decode()
  return img
}

/** Normalize palette colors to [r,g,b] tuples. */
export function normalizePalette(colors) {
  if (!colors?.length) return []
  return colors.map(c => (Array.isArray(c) ? c : [c[0], c[1], c[2]]))
}

/** Encode an image as PNG for template storage — pixels are kept as-is. */
export async function processTemplateImage(input) {
  const img = await loadImageFromInput(input)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0)
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.9))
}

/** Build runtime bitmap + sampler canvas from a stored template blob. */
export async function buildTemplateAssets(blob) {
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.src = url
  await img.decode()

  const samplerCanvas = document.createElement('canvas')
  samplerCanvas.width = img.naturalWidth
  samplerCanvas.height = img.naturalHeight
  samplerCanvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0)

  const bitmap = await createImageBitmap(samplerCanvas)
  URL.revokeObjectURL(url)
  return {
    bitmap,
    samplerCanvas,
    width: bitmap.width,
    height: bitmap.height,
  }
}

export function makeTemplateThumbnail(bitmap, maxSize = 100) {
  const thumbCanvas = document.createElement('canvas')
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
  thumbCanvas.width = Math.floor(bitmap.width * scale)
  thumbCanvas.height = Math.floor(bitmap.height * scale)
  thumbCanvas.getContext('2d').drawImage(bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height)
  return thumbCanvas.toDataURL('image/jpeg', 0.6)
}

export function getCanvasCenter(configs, canvasId) {
  if (canvasId == null || canvasId === '') return 0
  const cfg = configs?.[canvasId] ?? configs?.[String(canvasId)]
  return cfg ? (cfg.size * 256) / 2 : 0
}

export function centerCoordsFromWorld(wx, wy, center) {
  return {
    x: Math.floor(wx - center),
    y: Math.floor(wy - center),
  }
}

export function worldCoordsFromCenter(x, y, center) {
  return {
    wx: x + center,
    wy: y + center,
  }
}

/** Default world position for a new template (HUD coords 0_0 at canvas center). */
export function defaultTemplateWorldPosition(configs, canvasId) {
  const center = getCanvasCenter(configs, canvasId)
  return { wx: center, wy: center }
}

/** Format stored world coords as center-relative HUD string (e.g. "0_0"). */
export function formatTemplateCoords(template, configs) {
  const center = getCanvasCenter(configs, template.canvasId)
  return `${Math.floor(template.wx - center)}_${Math.floor(template.wy - center)}`
}

/** Apply a canvas pick or other world-space position update. Clears stale input text. */
export function applyTemplateWorldPosition(template, wx, wy) {
  return { ...template, wx, wy, coordInputStr: undefined }
}

/** Parse coord input text and update world position when two numbers are present. */
export function applyTemplateCoordInput(template, val, configs) {
  const nums = parseCoordNumbers(val)
  const next = { ...template, coordInputStr: val }
  if (nums && nums.length >= 2) {
    const center = getCanvasCenter(configs, template.canvasId)
    next.wx = nums[0] + center
    next.wy = nums[1] + center
    next.coordInputStr = formatCoordXY(nums[0], nums[1])
  }
  return next
}

/** Strip ephemeral UI fields before persisting template metadata. */
export function templateMetadataForStorage(template) {
  const { bitmap, samplerCanvas, coordInputStr, coordInput, ...rest } = template
  return rest
}

/** Release GPU-backed template bitmap memory. */
export function releaseTemplateBitmap(template) {
  template?.bitmap?.close?.()
}

/** Remove in-progress coord input state from loaded metadata. */
export function stripTemplateUiFields(template) {
  const { coordInputStr, coordInput, ...rest } = template
  return rest
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      resolve(typeof result === 'string' ? (result.split(',')[1] || result) : '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function base64ToBlob(base64, mimetype) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimetype || 'image/png' })
}

export async function exportEnabledTemplates(templates, configs) {
  const enabled = templates.filter(t => t.visible && t.bitmap)
  const result = []
  for (let i = 0; i < enabled.length; i++) {
    const t = enabled[i]
    const center = getCanvasCenter(configs, t.canvasId)
    const { x, y } = centerCoordsFromWorld(t.wx, t.wy, center)

    let blob = await getTemplateImageFromDB(t.id)
    if (!blob) {
      const canvas = document.createElement('canvas')
      canvas.width = t.bitmap.width
      canvas.height = t.bitmap.height
      canvas.getContext('2d').drawImage(t.bitmap, 0, 0)
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.9))
    }

    const buffer = await blobToBase64(blob)
    result.push({
      enabled: true,
      title: t.name || `Template ${i + 1}`,
      canvasId: String(t.canvasId ?? '0'),
      x,
      y,
      imageId: i + 1,
      width: t.width ?? t.bitmap.width,
      height: t.height ?? t.bitmap.height,
      buffer,
      mimetype: blob.type || 'image/png',
    })
  }
  return result
}

export async function importTemplates(entries, configs) {
  if (!Array.isArray(entries)) throw new Error('Import data must be a JSON array')

  const imported = []
  for (const entry of entries) {
    if (!entry?.buffer) continue

    const blob = base64ToBlob(entry.buffer, entry.mimetype)
    const id = crypto.randomUUID()
    await saveTemplateImageToDB(id, blob)

    const { bitmap, samplerCanvas, width, height } = await buildTemplateAssets(blob)
    const thumbnailUrl = makeTemplateThumbnail(bitmap)

    const canvasId = entry.canvasId != null && entry.canvasId !== ''
      ? Number(entry.canvasId)
      : null
    const center = getCanvasCenter(configs, canvasId)
    const { wx, wy } = worldCoordsFromCenter(entry.x ?? 0, entry.y ?? 0, center)

    imported.push({
      id,
      name: entry.title || 'Imported template',
      thumbnailUrl,
      wx,
      wy,
      visible: entry.enabled !== false,
      canvasId,
      bitmap,
      samplerCanvas,
      width: entry.width ?? width,
      height: entry.height ?? height,
    })
  }
  return imported
}
