const KEY = 'pixmap:selectedColors'

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    return {}
  }
}

function writeStore(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch { /* quota */ }
}

/** @returns {number | null} */
export function loadSelectedColor(canvasId) {
  const v = readStore()[String(canvasId)]
  return Number.isInteger(v) ? v : null
}

export function saveSelectedColor(canvasId, colorIdx) {
  if (!Number.isInteger(colorIdx)) return
  const all = readStore()
  all[String(canvasId)] = colorIdx
  writeStore(all)
}

export function defaultSelectedColor(modColorCount, isMod) {
  return isMod ? 0 : modColorCount
}

/** @returns {number} */
export function resolveSelectedColor(canvasId, { modColorCount, isMod, colorCount }) {
  const def = defaultSelectedColor(modColorCount, isMod)
  const saved = loadSelectedColor(canvasId)
  if (saved == null) return def
  const min = isMod ? 0 : modColorCount
  if (saved < min || saved >= colorCount) return def
  return saved
}
