/** Pixel offset from renderer-space origin to canvas (0, 0). */
export function computeCenter(cfg) {
  return cfg ? (cfg.size * 256) / 2 : 0
}

/** Center offset for the canvas named in a parsed hash. */
export function centerForHash(parsed, configs, fallbackCanvasId = 0) {
  const entry = Object.entries(configs).find(([, cfg]) => cfg?.indent === parsed.indent)
  const cfg = entry ? entry[1] : configs[fallbackCanvasId]
  return computeCenter(cfg)
}

/** Parse `#indent,x,y,zoom` from the URL hash (without leading #). */
export function parseHash(hash) {
  if (!hash) return null
  const p = hash.split(',')
  if (p.length < 3) return null
  return {
    indent: p[0],
    x: parseInt(p[1], 10) || 0,
    y: parseInt(p[2], 10) || 0,
    zoom: parseInt(p[3], 10) || 0,
  }
}

/** Convert renderer scale to URL hash zoom (0 = 1:1 scale). */
export function scaleToHashZoom(scale) {
  if (!scale || scale <= 0) return 0
  return Math.round(Math.log(scale) / Math.log(40) * 100)
}

/** Convert parsed hash coords to renderer viewport values. */
export function hashToViewport(parsed, center, historyMode = false) {
  let scale = Math.pow(40, parsed.zoom / 100)
  if (historyMode) scale = Math.max(0.7, scale)
  return {
    viewX: parsed.x + center,
    viewY: parsed.y + center,
    scale,
  }
}
