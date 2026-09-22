import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { PixmapRenderer } from '../lib/canvas/index.js'

const Canvas = forwardRef(function Canvas({ onReady }, ref) {
  const canvasEl = useRef(null)
  const renderer = useRef(null)

  useEffect(() => {
    const r = new PixmapRenderer(canvasEl.current)
    renderer.current = r
    onReady?.()

    return () => {
      r.destroy()
      renderer.current = null
    }
  }, [onReady])

  useImperativeHandle(ref, () => ({
    get renderer() { return renderer.current },
    get el() { return renderer.current?.el ?? null },

    attach: (...args) => renderer.current?.attach(...args),
    applyPixels: pixels => renderer.current?.applyPixels(pixels),
    refreshChunks: (canvasId, chunks) => renderer.current?.refreshChunks(canvasId, chunks),
    setSelectedColor: idx => renderer.current?.setSelectedColor(idx),
    getSelectedColor: () => renderer.current?.getSelectedColor?.() ?? 0,
    setIsMod: val => renderer.current?.setIsMod(val),
    setBrushSize: val => renderer.current?.setBrushSize(val),
    setOverlays: ovs => renderer.current?.setOverlays(ovs),
    setOverlayOpacity: val => renderer.current?.setOverlayOpacity(val),
    setPencilMode: val => renderer.current?.setPencilMode(val),
    setOverlaysEnabled: val => renderer.current?.setOverlaysEnabled(val),
    setSmallPixelsEnabled: val => renderer.current?.setSmallPixelsEnabled(val),
    setGridEnabled: val => renderer.current?.setGridEnabled(val),
    setMobilePencilEnabled: val => renderer.current?.setMobilePencilEnabled(val),
    setSmoothPlacing: val => renderer.current?.setSmoothPlacing(val),
    setServerCooldown: ms => renderer.current?.setServerCooldown(ms),
    getCooldownRemainingMs: () => renderer.current?.getCooldownRemainingMs() ?? 0,
    finalizePlace: (cx, cy, code, placedPixels) => renderer.current?.finalizePlace(cx, cy, code, placedPixels),
    pickColorAt: (wx, wy) => renderer.current?.pickColorAt(wx, wy),
    pickColorAtHover: () => renderer.current?.pickColorAtHover(),
    startTemplatePick: (...args) => renderer.current?.startTemplatePick(...args),
    stopTemplatePick: () => renderer.current?.stopTemplatePick(),
    startWatchSelect: cb => renderer.current?.startWatchSelect(cb),
    stopWatchSelect: () => renderer.current?.stopWatchSelect(),
    setWatchVisualization: data => renderer.current?.setWatchVisualization(data),
    flashProtectedPixels: (cx, cy, offsets) => renderer.current?.flashProtectedPixels(cx, cy, offsets),
    setHistoryMode: ts => renderer.current?.setHistoryMode(ts),
    clearHistoryMode: () => renderer.current?.clearHistoryMode(),
    navigateTo: (wx, wy) => renderer.current?.navigateTo(wx, wy),
    navigateToWorld: (wx, wy, scale) => renderer.current?.setViewport(wx, wy, scale != null ? scale : (renderer.current?.scale < 6 ? 16 : renderer.current?.scale)),
    setViewport: (x, y, s) => renderer.current?.setViewport(x, y, s),
    syncChunkSubscriptions: opts => renderer.current?.syncChunkSubscriptions(opts),
    getViewport: () => renderer.current?.getViewport(),
    downloadViewport: () => renderer.current?.downloadViewport(),
    pauseRendering: () => renderer.current?.pauseRendering(),
    resumeRendering: () => renderer.current?.resumeRendering(),

    scheduleUpdate: () => renderer.current?.scheduleUpdate(),
    persistViewport: () => renderer.current?.persistViewport(),
    screenToWorld: (x, y) => renderer.current?.screenToWorld(x, y),
    zoomAt: (x, y, f) => renderer.current?.zoomAt(x, y, f),
    setPanHeld: (arrow, held) => renderer.current?.setPanHeld?.(arrow, held),
    setZoomHeld: (key, held, opts) => renderer.current?.setZoomHeld?.(key, held, opts),
    zoomIn: () => {
      const r = renderer.current
      if (r) r.zoomAt(r.el.width / 2, r.el.height / 2, 2)
    },
    zoomOut: () => {
      const r = renderer.current
      if (r) r.zoomAt(r.el.width / 2, r.el.height / 2, 0.5)
    },
  }), [])

  return <canvas ref={canvasEl} id="world" />
})

export default Canvas
