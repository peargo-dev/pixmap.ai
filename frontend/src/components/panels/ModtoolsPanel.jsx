import { useState, useRef, useEffect, useMemo, Fragment, createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import PanelHeader from '../PanelHeader.jsx'
import { getAvatarUrl } from '../../lib/avatar.js'
import CoordsComponent, { CoordsPairInputs } from '../CoordsComponent.jsx'

export const ModtoolsContext = createContext({ configs: {}, canvasRef: null, canvasId: 0, canvasSize: 0 })
import { parseCoordNumbers } from '../../lib/coords.js'
import { fetchHistoryChunk } from '../../lib/api.js'

function intOr(val, fallback) {
  const n = parseInt(val, 10)
  return Number.isNaN(n) ? fallback : n
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function copyCoord(text) {
  if (!text) return
  navigator.clipboard.writeText(text).catch(() => { })
}

function CopyBtn({ text, label, title, style }) {
  const [copied, setCopied] = useState(false)
  if (!text) return null
  return (
    <button
      type="button"
      className="mt-btn secondary icon-btn"
      style={{
        padding: '1px 5px',
        fontSize: 10,
        height: 18,
        minHeight: 18,
        lineHeight: '16px',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        ...style,
      }}
      title={title || `Copy ${text}`}
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(String(text)).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => {})
      }}
    >
      {copied ? '✓' : (label || '📋')}
    </button>
  )
}

async function handleRollbackPixelCount({ userId, ip, canvasId = 0, defaultCount = 100, onComplete }) {
  const targetLabel = userId ? `User #${userId}` : `IP ${ip}`
  const input = prompt(
    `Rollback pixels for ${targetLabel} on canvas ${canvasId}:\n` +
    `Enter the number of pixels to roll back:`,
    String(defaultCount)
  )
  if (input === null) return
  const count = parseInt(input, 10)
  if (isNaN(count) || count <= 0) {
    alert('Please enter a valid positive number of pixels.')
    return
  }

  try {
    const res = await fetch('/admin/rollback/pixels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId || null,
        ip: ip || null,
        canvas_id: parseInt(canvasId, 10) || 0,
        count
      })
    })
    const data = await res.json()
    if (res.ok) {
      alert(`✅ Successfully rolled back ${data.count} pixels for ${data.target || targetLabel}!`)
      if (onComplete) onComplete()
    } else {
      alert(`❌ Rollback failed: ${data.detail || data.message || 'Unknown error'}`)
    }
  } catch (e) {
    alert(`❌ Network error during rollback: ${e.message}`)
  }
}

function MassBanModal({ isOpen, onClose, onBanned }) {
  const [idList, setIdList] = useState('')
  const [reason, setReason] = useState('Violating community rules')
  const [durationHours, setDurationHours] = useState('0')
  const [banAlts, setBanAlts] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)

  if (!isOpen) return null

  async function handleMassBan() {
    const rawIds = idList.split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean)
    if (rawIds.length === 0) {
      alert('Please enter at least one user ID.')
      return
    }
    const durationLabel = durationHours === '0' ? 'Permanent' : `${durationHours} hours`
    const confirmed = confirm(`Are you sure you want to MASS BAN ${rawIds.length} user(s)?\n\nDuration: ${durationLabel}\nBan Alts: ${banAlts ? 'Yes' : 'No'}\nReason: ${reason}`)
    if (!confirmed) return

    setSubmitting(true)
    setResult(null)
    try {
      const durationSeconds = parseInt(durationHours, 10) * 3600
      const res = await fetch('/admin/users/mass-ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_ids: rawIds,
          reason,
          duration: durationSeconds,
          ban_alts: banAlts
        })
      })
      const data = await res.json()
      if (res.ok) {
        setResult(data)
        if (onBanned) onBanned()
      } else {
        alert(data.detail || 'Mass ban request failed')
      }
    } catch (e) {
      alert('Error executing mass ban: ' + e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        background: '#181b20', border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 10, width: 440, maxWidth: '92vw', padding: 18,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)', color: '#fff'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
            🔨 Mass Ban Users
          </h3>
          <button className="mt-btn secondary icon-btn" onClick={onClose}>✕</button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: '#aaa', display: 'block', marginBottom: 4 }}>
            User IDs (separated by spaces, commas, or new lines):
          </label>
          <textarea
            className="mt-input"
            rows={4}
            value={idList}
            onChange={e => setIdList(e.target.value)}
            placeholder="e.g. 102 105 142&#10;204, 305"
            style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: '#aaa', display: 'block', marginBottom: 4 }}>
            Ban Reason:
          </label>
          <input
            type="text"
            className="mt-input"
            value={reason}
            onChange={e => setReason(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: 11, color: '#aaa', display: 'block', marginBottom: 4 }}>
              Duration:
            </label>
            <select
              className="mt-input"
              value={durationHours}
              onChange={e => setDurationHours(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="0">Permanent</option>
              <option value="1">1 hour</option>
              <option value="6">6 hours</option>
              <option value="24">24 hours (1 day)</option>
              <option value="72">3 days</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 18 }}>
            <input
              type="checkbox"
              id="mass-ban-alts-chk"
              checked={banAlts}
              onChange={e => setBanAlts(e.target.checked)}
            />
            <label htmlFor="mass-ban-alts-chk" style={{ fontSize: 12, cursor: 'pointer' }}>
              Ban known alts
            </label>
          </div>
        </div>

        {result && (
          <div style={{
            padding: '8px 10px', borderRadius: 6, marginBottom: 12, fontSize: 11,
            background: result.banned?.length ? 'rgba(46, 204, 113, 0.15)' : 'rgba(231, 76, 60, 0.15)',
            border: `1px solid ${result.banned?.length ? '#2ecc71' : '#e74c3c'}`
          }}>
            <div>✅ Banned: <strong>{result.banned?.length || 0}</strong> ({result.banned?.join(', ') || 'none'})</div>
            {result.failed?.length > 0 && (
              <div style={{ color: '#ff9999', marginTop: 2 }}>⚠️ Skipped/Failed: {result.failed?.join(', ')}</div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="mt-btn secondary" onClick={onClose} disabled={submitting}>
            Close
          </button>
          <button className="mt-btn danger" onClick={handleMassBan} disabled={submitting}>
            {submitting ? 'Banning…' : '🔨 Execute Mass Ban'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function PixelTimelineVisualizer({ userId, username, initialCanvasId = 0, initialPlacements = null, colors = [], onClose, canvasRef: propCanvasRef, configs: propConfigs }) {
  const modCtx = useContext(ModtoolsContext)
  const canvasRef = propCanvasRef || modCtx?.canvasRef
  const configs = propConfigs || modCtx?.configs || {}

  // Sort initialPlacements chronologically (oldest -> newest)
  const chronologicalPlacements = useMemo(() => {
    if (!initialPlacements || !initialPlacements.length) return null
    const copy = [...initialPlacements]
    copy.sort((a, b) => {
      const ta = a.placed_at ? new Date(a.placed_at).getTime() : (a.id || 0)
      const tb = b.placed_at ? new Date(b.placed_at).getTime() : (b.id || 0)
      return ta - tb
    })
    return copy
  }, [initialPlacements])

  const isWatchTimeline = Boolean(chronologicalPlacements && chronologicalPlacements.length > 0)

  const [pixels, setPixels] = useState(chronologicalPlacements || [])
  const [limit, setLimit] = useState(chronologicalPlacements?.length || 100)
  const [loading, setLoading] = useState(!isWatchTimeline && Boolean(userId))
  const [error, setError] = useState(null)
  const [currentIndex, setCurrentIndex] = useState(chronologicalPlacements?.length ? chronologicalPlacements.length - 1 : 0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(2)
  const [selectedCanvas, setSelectedCanvas] = useState(initialCanvasId)
  const [hours, setHours] = useState('all')

  const resolvedPalette = useMemo(() => {
    if (colors && colors.length > 0) return colors
    const cid = selectedCanvas !== 'all' ? selectedCanvas : initialCanvasId
    if (configs?.[cid]?.colors && configs[cid].colors.length > 0) return configs[cid].colors
    if (configs?.[0]?.colors && configs[0].colors.length > 0) return configs[0].colors
    return []
  }, [colors, configs, selectedCanvas, initialCanvasId])

  const [palette, setPalette] = useState(resolvedPalette)
  const previewCanvasRef = useRef(null)
  const playTimerRef = useRef(null)

  useEffect(() => {
    if (resolvedPalette && resolvedPalette.length > 0) {
      setPalette(resolvedPalette)
    }
  }, [resolvedPalette])

  async function loadPlacements() {
    if (isWatchTimeline) return
    if (!userId) return
    setLoading(true)
    setError(null)
    setIsPlaying(false)
    try {
      let url = `/admin/users/${userId}/pixels?limit=${limit}&order=desc`
      if (selectedCanvas !== 'all' && selectedCanvas !== undefined) url += `&canvas_id=${selectedCanvas}`
      if (hours && hours !== 'all') url += `&hours=${hours}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      // Reverse desc so it plays chronologically (oldest of the batch -> newest)
      const px = (data.pixels || []).slice().reverse()
      setPixels(px)
      setCurrentIndex(px.length > 0 ? px.length - 1 : 0)
    } catch (e) {
      setError('Failed to load user pixel history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!isWatchTimeline && userId) {
      loadPlacements()
    }
  }, [userId, selectedCanvas, hours, limit, isWatchTimeline])

  useEffect(() => {
    if (!isPlaying) {
      if (playTimerRef.current) clearInterval(playTimerRef.current)
      return
    }
    const intervalMs = Math.max(16, Math.floor(200 / speed))
    playTimerRef.current = setInterval(() => {
      setCurrentIndex(prev => {
        if (prev >= pixels.length - 1) {
          setIsPlaying(false)
          return prev
        }
        return prev + 1
      })
    }, intervalMs)
    return () => {
      if (playTimerRef.current) clearInterval(playTimerRef.current)
    }
  }, [isPlaying, speed, pixels.length])

  useEffect(() => {
    const canvas = previewCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width
    const h = canvas.height
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, w, h)

    if (pixels.length === 0) return

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of pixels) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const spanX = Math.max(1, maxX - minX + 1)
    const spanY = Math.max(1, maxY - minY + 1)

    const pad = 20
    const availW = Math.max(10, w - pad * 2)
    const availH = Math.max(10, h - pad * 2)

    // Compute pixel scale to fit inside availW x availH
    const scaleX = availW / spanX
    const scaleY = availH / spanY
    const scale = Math.min(scaleX, scaleY)

    // Determine drawn dimensions & centering offset
    const drawW = spanX * scale
    const drawH = spanY * scale
    const offsetX = pad + Math.max(0, (availW - drawW) / 2)
    const offsetY = pad + Math.max(0, (availH - drawH) / 2)

    const dotW = Math.max(2, Math.min(24, Math.ceil(scale)))
    const dotH = Math.max(2, Math.min(24, Math.ceil(scale)))

    // Background bounding box grid
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.strokeRect(offsetX, offsetY, Math.max(10, drawW), Math.max(10, drawH))

    // 1. Draw ghost / faint preview of all placements (opacity 0.25)
    ctx.globalAlpha = 0.25
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i]
      const px = offsetX + (p.x - minX) * scale
      const py = offsetY + (p.y - minY) * scale
      const c = palette[p.color] || [200, 200, 200]
      ctx.fillStyle = Array.isArray(c) ? `rgb(${c[0]},${c[1]},${c[2]})` : c
      ctx.fillRect(px, py, dotW, dotH)
    }

    // 2. Draw placed pixels up to currentIndex with full brightness
    ctx.globalAlpha = 1.0
    const upTo = Math.min(currentIndex, pixels.length - 1)
    for (let i = 0; i <= upTo; i++) {
      const p = pixels[i]
      const px = offsetX + (p.x - minX) * scale
      const py = offsetY + (p.y - minY) * scale
      const c = palette[p.color] || [255, 255, 255]
      ctx.fillStyle = Array.isArray(c) ? `rgb(${c[0]},${c[1]},${c[2]})` : c
      ctx.fillRect(px, py, dotW, dotH)
    }

    // 3. Highlight current active pixel
    if (upTo >= 0 && upTo < pixels.length) {
      const curr = pixels[upTo]
      const px = offsetX + (curr.x - minX) * scale
      const py = offsetY + (curr.y - minY) * scale
      ctx.strokeStyle = '#00ffcc'
      ctx.lineWidth = 2
      ctx.strokeRect(px - 2, py - 2, dotW + 4, dotH + 4)
    }
  }, [pixels, currentIndex, palette])

  const currentPixel = pixels[currentIndex]

  const jumpToPixel = (px, py, canvas_id) => {
    const cid = canvas_id != null ? canvas_id : (selectedCanvas !== 'all' ? selectedCanvas : initialCanvasId)
    const cfg = configs?.[cid]
    const center = cfg ? (cfg.size * 256) / 2 : 10240
    const hudX = Math.floor(px - center)
    const hudY = Math.floor(py - center)

    if (canvasRef?.current?.navigateToWorld) {
      canvasRef.current.navigateToWorld(px, py, 25)
    } else {
      window.dispatchEvent(new CustomEvent('pixmap:navigate', {
        detail: { x: hudX, y: hudY, canvasId: cid, zoom: 35 }
      }))
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(5px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        background: '#131720', border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: 12, width: 580, maxWidth: '95vw', padding: 18,
        boxShadow: '0 12px 40px rgba(0,0,0,0.7)', color: '#fff'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
              🎬 Pixel Sequence Visualization
            </h3>
            <span style={{ fontSize: 11, color: '#8090a0' }}>
              User: <strong>{username || `#${userId}`}</strong> · {pixels.length} placements shown
            </span>
          </div>
          <button className="mt-btn secondary icon-btn" onClick={onClose}>✕</button>
        </div>

        {isWatchTimeline ? (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 10, background: 'rgba(62, 207, 110, 0.08)',
            border: '1px solid rgba(62, 207, 110, 0.25)', borderRadius: 6,
            padding: '6px 12px'
          }}>
            <span style={{ fontSize: 11, color: '#3ecf6e', fontWeight: 600 }}>
              ✨ Showing all {pixels.length} placements from Watchtools timeline
            </span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>
              Canvas {selectedCanvas !== 'all' ? selectedCanvas : initialCanvasId}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 11, color: '#aaa' }}>Canvas:</label>
            <select
              className="mt-input"
              value={selectedCanvas}
              onChange={e => setSelectedCanvas(e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10))}
              style={{ fontSize: 11, padding: '2px 6px' }}
            >
              <option value="all">All Canvases</option>
              <option value="0">Canvas 0</option>
              <option value="1">Canvas 1</option>
              <option value="2">Canvas 2</option>
              <option value="3">Canvas 3</option>
            </select>

            <label style={{ fontSize: 11, color: '#aaa', marginLeft: 4 }}>Timeframe:</label>
            <select
              className="mt-input"
              value={hours}
              onChange={e => setHours(e.target.value)}
              style={{ fontSize: 11, padding: '2px 6px' }}
            >
              <option value="all">All Time</option>
              <option value="1">Last 1h</option>
              <option value="6">Last 6h</option>
              <option value="24">Last 24h</option>
              <option value="72">Last 3 days</option>
              <option value="168">Last 7 days</option>
            </select>

            <label style={{ fontSize: 11, color: '#aaa', marginLeft: 4 }}>Amount:</label>
            <select
              className="mt-input"
              value={limit}
              onChange={e => setLimit(parseInt(e.target.value, 10))}
              style={{ fontSize: 11, padding: '2px 6px' }}
            >
              <option value="50">Last 50 px</option>
              <option value="100">Last 100 px</option>
              <option value="250">Last 250 px</option>
              <option value="500">Last 500 px</option>
              <option value="1000">Last 1,000 px</option>
              <option value="2500">Last 2,500 px</option>
            </select>

            <button className="mt-btn secondary" onClick={loadPlacements} style={{ fontSize: 11, padding: '2px 8px', marginLeft: 'auto' }}>
              🔄 Reload
            </button>
          </div>
        )}

        <div style={{
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          background: '#0a0d14', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8, padding: 10, marginBottom: 12
        }}>
          {loading ? (
            <div style={{ padding: 40, color: '#888', fontSize: 12 }}>Loading pixel trajectory…</div>
          ) : error ? (
            <div style={{ padding: 40, color: '#f87', fontSize: 12 }}>{error}</div>
          ) : pixels.length === 0 ? (
            <div style={{ padding: 40, color: '#888', fontSize: 12 }}>No placements found in this timeframe.</div>
          ) : (
            <canvas
              ref={previewCanvasRef}
              width={480}
              height={280}
              style={{ borderRadius: 6, maxWidth: '100%', imageRendering: 'pixelated' }}
            />
          )}
        </div>

        {pixels.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <input
                type="range"
                min={0}
                max={pixels.length - 1}
                value={currentIndex}
                onChange={e => {
                  setIsPlaying(false)
                  setCurrentIndex(parseInt(e.target.value, 10))
                }}
                style={{ flex: 1, cursor: 'pointer', accentColor: '#00ffcc' }}
              />
              <span style={{ fontSize: 11, fontFamily: 'monospace', minWidth: 70, textAlign: 'right', color: '#00ffcc' }}>
                {currentIndex + 1} / {pixels.length}
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <button
                  className="mt-btn secondary icon-btn"
                  onClick={() => { setIsPlaying(false); setCurrentIndex(0); }}
                  title="Rewind to start"
                  style={{ padding: '2px 8px' }}
                >
                  ⏮
                </button>
                <button
                  className="mt-btn secondary icon-btn"
                  onClick={() => { setIsPlaying(false); setCurrentIndex(prev => Math.max(0, prev - 1)); }}
                  title="Step backward"
                  style={{ padding: '2px 8px' }}
                >
                  ◀
                </button>
                <button
                  className={`mt-btn ${isPlaying ? 'danger' : 'primary'}`}
                  onClick={() => setIsPlaying(v => !v)}
                  style={{ minWidth: 64, fontSize: 11, padding: '2px 10px' }}
                >
                  {isPlaying ? '⏸ Pause' : '▶ Play'}
                </button>
                <button
                  className="mt-btn secondary icon-btn"
                  onClick={() => { setIsPlaying(false); setCurrentIndex(prev => Math.min(pixels.length - 1, prev + 1)); }}
                  title="Step forward"
                  style={{ padding: '2px 8px' }}
                >
                  ▶
                </button>
                <button
                  className="mt-btn secondary icon-btn"
                  onClick={() => { setIsPlaying(false); setCurrentIndex(pixels.length - 1); }}
                  title="Jump to end"
                  style={{ padding: '2px 8px' }}
                >
                  ⏭
                </button>

                <select
                  className="mt-input"
                  value={speed}
                  onChange={e => setSpeed(parseFloat(e.target.value))}
                  style={{ fontSize: 10, padding: '2px 4px', marginLeft: 6 }}
                  title="Playback Speed"
                >
                  <option value="0.5">0.5x</option>
                  <option value="1">1x</option>
                  <option value="2">2x</option>
                  <option value="5">5x</option>
                  <option value="10">10x</option>
                  <option value="25">25x</option>
                </select>
              </div>

              {currentPixel && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                  <span style={{ fontFamily: 'monospace' }}>
                    ({currentPixel.x}, {currentPixel.y})
                  </span>
                  <span style={{
                    display: 'inline-block', width: 12, height: 12, borderRadius: 2,
                    background: Array.isArray(palette[currentPixel.color]) ? `rgb(${palette[currentPixel.color].join(',')})` : (palette[currentPixel.color] || '#fff'),
                    border: '1px solid rgba(255,255,255,0.3)'
                  }} title={`Color ${currentPixel.color}`} />
                  <span style={{ color: '#888', fontSize: 10 }}>
                    {new Date(currentPixel.placed_at).toLocaleTimeString()}
                  </span>
                  <button
                    className="mt-btn secondary icon-btn"
                    onClick={() => jumpToPixel(currentPixel.x, currentPixel.y, currentPixel.canvas_id)}
                    title="Jump to this exact coordinate on main canvas"
                    style={{ padding: '2px 6px', fontSize: 10, color: '#00ffcc', borderColor: 'rgba(0,255,204,0.3)' }}
                  >
                    🎯 Jump
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}


const ROLE_LABELS = {

  user: { label: 'User', color: '' },
  trial_mod: { label: 'Trial Mod', color: 'role-100' },
  moderator: { label: 'Moderator', color: 'role-150' },
  admin: { label: 'Admin', color: 'role-200' },
}

function getRoleString(roleNum) {
  if (roleNum >= 254) return 'owner'
  if (roleNum >= 200) return 'admin'
  if (roleNum >= 150) return 'moderator'
  if (roleNum >= 100) return 'trial_mod'
  return 'user'
}

function UserRow({ u, currentUser, onReload }) {
  const [histOpen, setHistOpen] = useState(false)
  const [histLogs, setHistLogs] = useState(null)
  const [histLoading, setHistLoading] = useState(false)
  const [roleSaving, setRoleSaving] = useState(false)

  async function handleBan() {
    const currentBanned = u.banned
    let reason = ''
    let duration = 0
    let ban_alts = false
    if (!currentBanned) {
      reason = prompt('Ban Reason:', 'Breaking rules')
      if (reason === null) return
      const durStr = prompt('Duration in hours (0 for perm):', '0')
      if (durStr === null) return
      duration = parseInt(durStr) * 3600
      ban_alts = confirm('Also ban alt accounts sharing the same IP/session?')
    }
    const r = await fetch(`/admin/users/${u.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ banned: !currentBanned, reason, duration, ban_alts }),
    })
    if (r.ok) onReload()
  }

  async function handleRoleChange(newRole) {
    setRoleSaving(true)
    await fetch(`/admin/users/${u.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    })
    setRoleSaving(false)
    onReload()
  }

  async function handleCooldownChange() {
    const secondsStr = prompt('Set temporary cooldown in seconds (0 = clear):', '60')
    if (secondsStr === null) return
    const seconds = parseFloat(secondsStr)
    if (isNaN(seconds) || seconds < 0) {
      alert('Invalid cooldown value')
      return
    }

    const r = await fetch(`/admin/users/${u.id}/cooldown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds, canvas: 'all' }),
    })
    const data = await r.json().catch(() => ({}))
    if (r.ok) {
      alert(seconds === 0 ? 'Cooldown cleared' : `Cooldown set to ${seconds}s`)
    } else {
      alert(data.detail || 'Failed to update cooldown')
    }
  }

  async function handleCdRateChange() {
    const input = prompt(
      'Set per-pixel CD rate for this user:\n' +
      '  0   = zero cooldown on every pixel place\n' +
      '  0.5 = half cooldown\n' +
      '  1   = default (same as reset)\n' +
      '  -1  = reset to default\n\n' +
      'Enter value:',
      '-1'
    )
    if (input === null) return
    const rate = parseFloat(input)
    if (isNaN(rate)) { alert('Invalid value'); return }

    const r = await fetch(`/admin/users/${u.id}/cd-rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rate }),
    })
    const data = await r.json().catch(() => ({}))
    if (r.ok) {
      alert(data.message || 'CD rate updated')
    } else {
      alert(data.detail || 'Failed to update CD rate')
    }
  }

  async function toggleHistory() {
    if (histOpen) { setHistOpen(false); return }
    setHistOpen(true)
    if (histLogs !== null) return
    setHistLoading(true)
    try {
      const r = await fetch(`/admin/users/${u.id}/bans`)
      if (!r.ok) { setHistLogs([]); return }
      const { logs } = await r.json()
      setHistLogs(logs)
    } catch { setHistLogs([]) }
    finally { setHistLoading(false) }
  }

  const avatar = getAvatarUrl(u, 32)

  const roleStr = getRoleString(u.role)
  const badge = getRoleBadge(u.role)
  const isOwner = u.role >= 254

  return (
    <div className="user-row">
      <img className="urow-avatar" src={avatar} alt="" />
      <div className="urow-info">
        <span className="urow-name">{u.username}</span>
        <span className={`role-badge ${badge.colorClass}`}>{badge.label}</span>
        {u.online && <span className="online-dot" />}
        {u.banned && <span className="banned-tag">BANNED</span>}
        {u.is_proxy && <span className="banned-tag" style={{ background: 'rgba(255,170,0,0.18)', color: '#ffaa00', borderColor: '#ffaa00' }}>PROXY</span>}
        <span className="urow-stat">{(u.pixels_placed || 0).toLocaleString()} px · #{u.id} · {u.country || '?'}</span>
      </div>
      <div className="urow-actions">
        {isOwner ? (
          <span className="muted" style={{ fontSize: 11 }}>owner</span>
        ) : (
          <select
            className="role-sel"
            value={roleStr}
            disabled={roleSaving}
            onChange={e => handleRoleChange(e.target.value)}
          >
            <option value="user">User</option>
            <option value="trial_mod">Trial Mod</option>
            <option value="moderator">Moderator</option>
            <option value="admin">Admin</option>
          </select>
        )}
        <button className="ban-btn mt-btn secondary" onClick={handleBan}>
          {u.banned ? 'Unban' : 'Ban'}
        </button>
        <button className="hist-btn mt-btn secondary" onClick={toggleHistory}>History</button>
        {(currentUser?.role ?? 0) >= 254 && (
          <button className="cd-btn mt-btn secondary" onClick={handleCooldownChange} title="Set temporary cooldown timer">⏱️ Set CD</button>
        )}
        {(currentUser?.role ?? 0) >= 254 && (
          <button className="cd-btn mt-btn secondary" onClick={handleCdRateChange} title="Set per-pixel CD rate (0=no CD, -1=reset)">⚡ CD Rate</button>
        )}
      </div>
      {histOpen && (
        <div className="user-hist-container">
          {histLoading && <p className="muted" style={{ padding: 10 }}>Loading history…</p>}
          {histLogs !== null && histLogs.length === 0 && <p className="muted" style={{ padding: 10 }}>No history found.</p>}
          {histLogs && histLogs.length > 0 && (
            <div className="ban-history">
              {histLogs.map((l, i) => (
                <div key={i} className="hist-row">
                  <span className={`hist-action ${l.is_ban ? 'hist-ban' : 'hist-unban'}`}>{l.is_ban ? 'BAN' : 'UNBAN'}</span>
                  <span className="hist-reason" title={l.reason}>{l.reason}</span>
                  <span className="hist-date">{new Date(l.created_at + 'Z').toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Quick Role Assign ─────────────────────────────────────────────────────────

function QuickRolePanel() {
  const [uid, setUid] = useState('')
  const [role, setRole] = useState('moderator')
  const [status, setStatus] = useState({ msg: '', ok: true })
  const [busy, setBusy] = useState(false)

  async function apply() {
    const id = parseInt(uid)
    if (isNaN(id)) { setStatus({ msg: 'Enter a valid user ID', ok: false }); return }
    setBusy(true)
    setStatus({ msg: '', ok: true })
    const r = await fetch(`/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    const data = await r.json().catch(() => ({}))
    if (r.ok) {
      setStatus({ msg: `✓ User #${id} set to ${role}`, ok: true })
      setUid('')
    } else {
      setStatus({ msg: `✗ ${data.detail || 'Failed'}`, ok: false })
    }
    setBusy(false)
  }

  return (
    <div className="quick-role-panel">
      <label className="mt-label">⚡ Quick role assign</label>
      <div className="quick-role-row">
        <input
          id="quick-role-uid"
          type="number"
          className="mt-input"
          placeholder="User ID"
          value={uid}
          onChange={e => setUid(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && apply()}
          style={{ width: 100 }}
        />
        <select
          id="quick-role-sel"
          className="role-sel"
          value={role}
          onChange={e => setRole(e.target.value)}
        >
          <option value="user">User</option>
          <option value="trial_mod">Trial Mod</option>
          <option value="moderator">Moderator</option>
          <option value="admin">Admin</option>
        </select>
        <button id="quick-role-btn" className="mt-btn primary" onClick={apply} disabled={busy}>
          Apply
        </button>
      </div>
      {status.msg && (
        <div className={`mt-status ${status.ok ? 'ok' : 'error'}`}>{status.msg}</div>
      )}
    </div>
  )
}

function UserLookupTab() {
  const [uid, setUid] = useState('')
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function lookup() {
    const id = parseInt(uid)
    if (isNaN(id)) { setError('Enter a valid user ID'); return }
    setLoading(true); setProfile(null); setError(null)
    try {
      const r = await fetch(`/admin/users/${id}/profile`)
      if (!r.ok) { setError(`Error ${r.status}: ${(await r.json().catch(() => ({}))).detail ?? 'Failed'}`); return }
      setProfile(await r.json())
    } catch { setError('Network error') }
    finally { setLoading(false) }
  }

  return (
    <div>
      <div className="quick-role-row" style={{ marginBottom: 10 }}>
        <input
          className="mt-input"
          type="number"
          placeholder="User ID…"
          value={uid}
          onChange={e => setUid(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && lookup()}
          style={{ width: 110 }}
        />
        <button className="mt-btn primary" onClick={lookup} disabled={loading}>
          {loading ? '…' : '🔍 Lookup'}
        </button>
      </div>
      {error && <div className="mt-status" style={{ color: '#f87', marginBottom: 8 }}>{error}</div>}
      {profile && <ProfileCard p={profile} defaultOpen={true} />}
    </div>
  )
}

function ProfileCard({ p, defaultOpen }) {
  const [inspecting, setInspecting] = useState(false)
  const [showVisualizer, setShowVisualizer] = useState(false)
  const [open, setOpen] = useState(defaultOpen ?? true)

  const getRoleBadgeClass = (role) => {
    if (role >= 254) return 'role-badge role-owner'
    if (role >= 200) return 'role-badge role-admin'
    if (role >= 150) return 'role-badge role-mod'
    if (role >= 100) return 'role-badge role-trial'
    return 'role-badge role-user'
  }
  const getRoleLabel = (role) => {
    if (role >= 254) return 'Owner'
    if (role >= 200) return 'Admin'
    if (role >= 150) return 'Mod'
    if (role >= 100) return 'Trial Mod'
    return 'User'
  }

  const avatar = getAvatarUrl(p, 48)
  const activeBans = (p.ban_history || []).filter(b => b.active)

  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, marginBottom: 8, background: 'rgba(0,0,0,0.18)', overflow: 'hidden' }}>
      <div
        style={{ display: 'flex', gap: 9, alignItems: 'center', padding: '8px 12px', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen(v => !v)}
      >
        <img src={avatar} alt="" style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{p.username}</span>
            <span className={getRoleBadgeClass(p.role)}>{getRoleLabel(p.role)}</span>
            {p.online && <span className="online-dot" />}
            {p.is_banned && <span className="banned-tag">BANNED</span>}
            {activeBans.length > 0 && !p.is_banned && <span className="banned-tag" style={{ opacity: 0.7 }}>⛔ {activeBans.length} ban{activeBans.length > 1 ? 's' : ''}</span>}
          </div>
          <div className="urow-stat" style={{ fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>#{p.id}</span>
            <CopyBtn text={String(p.id)} title="Copy User ID" />
            <span>· {p.country || '?'} · {(p.pixels_placed || 0).toLocaleString()} px</span>
          </div>
        </div>
        <span style={{ fontSize: 12, opacity: 0.5 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 11, marginBottom: 8 }}>
            <div>
              <span className="muted">Discord</span><br />
              {p.discord_id ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <a
                      href={`https://discord.com/users/${p.discord_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#5865F2', textDecoration: 'none', fontWeight: 600, fontSize: 11 }}
                      title="Open Discord Profile"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
                        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                      </svg>
                      <span>{p.discord_id}</span>
                      <span>↗</span>
                    </a>
                    <CopyBtn text={p.discord_id} title="Copy Discord ID" />
                  </div>
                  <span style={{ fontSize: 10, color: '#90a0c0' }}>@{p.discord_username || p.username}</span>
                </div>
              ) : <span className="muted">—</span>}
            </div>
            <div><span className="muted">Joined</span><br />{new Date(p.created_at).toLocaleDateString()}</div>
            <div><span className="muted">Last login</span><br />{p.last_login ? new Date(p.last_login).toLocaleString() : '—'}</div>
            {p.email != null && (
              <div>
                <span className="muted">Email</span><br />
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <code style={{ fontSize: 10, userSelect: 'all' }}>{p.email}</code>
                  <CopyBtn text={p.email} title="Copy Email" />
                </div>
              </div>
            )}
          </div>

          {activeBans.length > 0 && (
            <div style={{ background: 'rgba(255,60,60,0.08)', border: '1px solid rgba(255,60,60,0.2)', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#ff8080', marginBottom: 4 }}>⛔ Active Ban{activeBans.length > 1 ? 's' : ''}</div>
              {activeBans.map((b, i) => (
                <div key={i} style={{ fontSize: 11, marginBottom: 2 }}>
                  <span style={{ opacity: 0.7 }}>{b.is_alt ? '[alt] ' : ''}</span>
                  <strong>{b.reason || 'No reason'}</strong>
                  {b.expires_at
                    ? <span className="muted"> · expires {new Date(b.expires_at).toLocaleString()}</span>
                    : <span className="muted"> · permanent</span>}
                </div>
              ))}
            </div>
          )}

          {p.ban_history?.length > 0 && (
            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11, opacity: 0.65 }}>Ban history ({p.ban_history.length})</summary>
              <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {p.ban_history.map((b, i) => (
                  <div key={i} className="inspector-row" style={{ fontSize: 10 }}>
                    <span className={`hist-action ${b.active ? 'hist-ban' : 'hist-unban'}`}>{b.active ? 'BAN' : 'PARDONED'}</span>
                    {b.is_alt && <span className="muted" style={{ marginLeft: 4 }}>[alt]</span>}
                    <span style={{ marginLeft: 6, flex: 1, opacity: 0.8 }}>{b.reason || 'No reason'}</span>
                    <span className="urow-stat">{b.created_at ? new Date(b.created_at).toLocaleDateString() : '—'}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {!p.ban_history?.length && <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>No ban history.</div>}

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <button className="mt-btn secondary" style={{ fontSize: 11 }} onClick={() => setInspecting(v => !v)}>
              {inspecting ? '▲ Hide Inspector' : '🔎 Open Inspector'}
            </button>
            <button className="mt-btn secondary" style={{ fontSize: 11 }} onClick={() => setShowVisualizer(true)}>
              🎬 Visualize Pixels
            </button>
            <button className="mt-btn secondary" style={{ fontSize: 11 }} onClick={() => handleRollbackPixelCount({ userId: p.id, defaultCount: Math.min(p.pixels_placed || 100, 500) })}>
              ⏪ Rollback Pixels
            </button>
          </div>

          {inspecting && <div style={{ marginTop: 8 }}><UserInspector userId={p.id} onClose={() => setInspecting(false)} /></div>}
          {showVisualizer && (
            <PixelTimelineVisualizer
              userId={p.id}
              username={p.username}
              onClose={() => setShowVisualizer(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}


function DiscordLookupTab() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function lookup() {
    const q = query.trim()
    if (!q) return
    setLoading(true); setResults(null); setError(null)
    try {
      const r = await fetch(`/admin/users/by-discord/${encodeURIComponent(q)}`)
      if (!r.ok) { setError(`Error ${r.status}: ${(await r.json().catch(() => ({}))).detail ?? 'Failed'}`); return }
      const data = await r.json()
      setResults(data.users)
    } catch { setError('Network error') }
    finally { setLoading(false) }
  }

  return (
    <div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Enter a Discord user ID (e.g. <code>123456789012345678</code>) to find all linked Pixmap accounts with their ban history.
      </div>
      <div className="quick-role-row" style={{ marginBottom: 10 }}>
        <input
          className="mt-input"
          placeholder="Discord ID…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && lookup()}
          style={{ width: 190 }}
        />
        <button className="mt-btn primary" onClick={lookup} disabled={loading}>
          {loading ? '…' : '🔍 Search'}
        </button>
      </div>
      {error && <div className="mt-status" style={{ color: '#f87', marginBottom: 8 }}>{error}</div>}
      {loading && <div className="mt-status">Searching…</div>}
      {results !== null && results.length === 0 && (
        <div className="mt-status">No Pixmap accounts found for that Discord ID.</div>
      )}
      {results !== null && results.length > 0 && (
        <div>
          <div className="mt-label" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{results.length} account{results.length !== 1 ? 's' : ''} linked to <code style={{ fontSize: 11 }}>{query}</code></span>
            <CopyBtn text={query} title="Copy Discord ID" />
          </div>
          {results.map(p => <ProfileCard key={p.id} p={p} defaultOpen={results.length === 1} />)}
        </div>

      )}
    </div>
  )
}

function IidHistoryTab() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function lookup() {
    const q = query.trim()
    if (!q) return
    setLoading(true); setResults(null); setError(null)
    try {
      const r = await fetch(`/admin/ip/${encodeURIComponent(q)}/users`)
      if (!r.ok) { setError(`Error ${r.status}: ${(await r.json().catch(() => ({}))).detail ?? 'Failed'}`); return }
      const data = await r.json()
      const basicUsers = data.users || []
      if (basicUsers.length === 0) { setResults([]); return }
      const profiles = await Promise.all(
        basicUsers.map(u =>
          fetch(`/admin/users/${u.id}/profile`)
            .then(res => res.ok ? res.json() : null)
            .catch(() => null)
        )
      )
      setResults(profiles.filter(Boolean))
    } catch { setError('Network error') }
    finally { setLoading(false) }
  }

  return (
    <div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Search by IID prefix, CIDR, or raw IP (admin only) to find all accounts and their full ban history.
      </div>
      <div className="quick-role-row" style={{ marginBottom: 10 }}>
        <input
          className="mt-input"
          placeholder="IID / CIDR / IP…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && lookup()}
          style={{ width: 200 }}
        />
        <button className="mt-btn primary" onClick={lookup} disabled={loading}>
          {loading ? '…' : '🔍 Search'}
        </button>
      </div>
      {error && <div className="mt-status" style={{ color: '#f87', marginBottom: 8 }}>{error}</div>}
      {loading && <div className="mt-status">Searching…</div>}
      {results !== null && results.length === 0 && (
        <div className="mt-status">No accounts found.</div>
      )}
      {results !== null && results.length > 0 && (
        <div>
          <div className="mt-label" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{results.length} account{results.length !== 1 ? 's' : ''} found for <code style={{ fontSize: 11 }}>{query}</code></span>
            <CopyBtn text={query} title="Copy Query" />
          </div>
          {results.map(p => <ProfileCard key={p.id} p={p} defaultOpen={results.length === 1} />)}
        </div>

      )}
    </div>
  )
}

// ── Users search tab ──────────────────────────────────────────────────────────

function UsersTab({ currentUser }) {
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [showMassBan, setShowMassBan] = useState(false)
  const searchTimer = useRef(null)
  const LIMIT = 50

  async function load(q = '', loadOffset = 0, replace = true) {
    setLoading(true)
    setError(false)
    try {
      const url = `/admin/users?limit=${LIMIT}&offset=${loadOffset}${q ? `&q=${encodeURIComponent(q)}` : ''}`
      const r = await fetch(url)
      if (!r.ok) { setError(true); setUsers(null); return }
      const data = await r.json()
      
      if (replace) {
        setUsers(data.users)
      } else {
        setUsers(prev => [...(prev || []), ...data.users])
      }
      
      setTotal(data.total)
      setOffset(loadOffset)
      setHasMore((loadOffset + LIMIT) < data.total)
    } catch { setError(true); setUsers(null) }
    finally { setLoading(false) }
  }

  // Auto-load when tab first mounts
  useEffect(() => { load() }, [])

  function handleSearch(e) {
    const q = e.target.value
    setQuery(q)
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setOffset(0)
      load(q, 0, true)
    }, 300)
  }

  function handleLoadMore() {
    const newOffset = offset + LIMIT
    load(query, newOffset, false)
  }

  return (
    <div id="mt-users" className="mt-tabcontent">
      <QuickRolePanel />
      <div className="mt-search-row" style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="text"
          id="users-search"
          className="mt-input"
          placeholder="Search by name or ID…"
          value={query}
          onChange={handleSearch}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="mt-btn danger"
          onClick={() => setShowMassBan(true)}
          style={{ whiteSpace: 'nowrap', fontSize: 11, padding: '4px 10px' }}
        >
          🔨 Mass Ban
        </button>
      </div>
      <MassBanModal
        isOpen={showMassBan}
        onClose={() => setShowMassBan(false)}
        onBanned={() => load(query, 0, true)}
      />

      {total > 0 && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          Showing {Math.min(offset + (users?.length || 0), total)} of {total.toLocaleString()} users
        </div>
      )}
      <div id="users-list" className="users-list">
        {loading && offset === 0 && <p className="muted">Loading…</p>}
        {!loading && error && <p className="muted" style={{ color: '#f87' }}>Access denied — check your role.</p>}
        {!loading && !error && users && users.length === 0 && <p className="muted">No users found.</p>}
        {!loading && !error && users && users.map(u => (
          <UserRow key={u.id} u={u} currentUser={currentUser} onReload={() => load(query, 0, true)} />
        ))}
        {hasMore && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <button className="mt-btn secondary" onClick={handleLoadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load More'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Image paste tab ───────────────────────────────────────────────────────────

function PasteTab({ canvasRef, canvasSize, canvasId, configs }) {
  const canvasIndent = configs?.[canvasId]?.indent
  const [imageFile, setImageFile] = useState(null)
  const [previewCanvas, setPreviewCanvas] = useState(null)
  const [previewInfo, setPreviewInfo] = useState('')
  const [x, setX] = useState('')
  const [y, setY] = useState('')
  const [coordStr, setCoordStr] = useState('')
  const [status, setStatus] = useState({ msg: '', type: '' })
  const [pasting, setPasting] = useState(false)
  const [protectedPaste, setProtectedPaste] = useState(false)
  const previewRef = useRef(null)

  useEffect(() => {
    if (x !== '' && y !== '') {
      setCoordStr(`${x}_${y}`)
    } else if (x === '' && y === '') {
      setCoordStr('')
    }
  }, [x, y])

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setImageFile(file)
    const img = new Image()
    img.onload = () => {
      const pc = document.createElement('canvas')
      pc.width = img.naturalWidth
      pc.height = img.naturalHeight
      pc.getContext('2d').drawImage(img, 0, 0)
      setPreviewCanvas(pc)
      setPreviewInfo(`${img.naturalWidth} × ${img.naturalHeight} px`)

      if (previewRef.current) {
        previewRef.current.innerHTML = ''
        const MAX = 160
        const ratio = Math.min(MAX / img.naturalWidth, MAX / img.naturalHeight, 1)
        const thumb = document.createElement('canvas')
        thumb.width = Math.round(img.naturalWidth * ratio)
        thumb.height = Math.round(img.naturalHeight * ratio)
        thumb.style.imageRendering = 'pixelated'
        thumb.style.border = '1px solid var(--btn-border)'
        thumb.style.borderRadius = '4px'
        thumb.getContext('2d').drawImage(pc, 0, 0, thumb.width, thumb.height)
        previewRef.current.appendChild(thumb)
      }
    }
    img.src = URL.createObjectURL(file)
  }

  function handlePick() {
    if (!previewCanvas) { setStatus({ msg: 'Upload an image first.', type: 'warn' }); return }
    canvasRef.current?.startTemplatePick(previewCanvas, (px, py) => {
      setX(String(Math.floor(px - (canvasSize || 0))))
      setY(String(Math.floor(py - (canvasSize || 0))))
      setStatus({ msg: `Position set: (${px - (canvasSize || 0)}, ${py - (canvasSize || 0)})`, type: 'ok' })
    })
  }

  async function handlePaste() {
    if (!imageFile) { setStatus({ msg: 'No image selected.', type: 'warn' }); return }
    const nx = parseInt(x) + (canvasSize || 0), ny = parseInt(y) + (canvasSize || 0)
    if (isNaN(nx) || isNaN(ny)) { setStatus({ msg: 'Set coordinates first.', type: 'warn' }); return }
    const form = new FormData()
    form.append('canvas_id', canvasId)
    form.append('x', nx)
    form.append('y', ny)
    form.append('file', imageFile)
    if (protectedPaste) {
      form.append('protected', 'true')
    }
    setPasting(true)
    setStatus({ msg: 'Pasting…', type: 'info' })
    try {
      const r = await fetch('/admin/paste', { method: 'POST', body: form })
      const data = await r.json()
      if (r.ok) setStatus({ msg: `✓ Pasted ${data.placed.toLocaleString()} pixels!`, type: 'ok' })
      else setStatus({ msg: `✗ ${data.detail || 'Paste failed'}`, type: 'error' })
    } catch { setStatus({ msg: '✗ Network error', type: 'error' }) }
    finally { setPasting(false) }
  }

  return (
    <div id="mt-paste" className="mt-tabcontent">
      <label className="mt-label">Image file <span className="muted">(max 512×512)</span></label>
      <input type="file" id="paste-file" accept="image/*" className="mt-file-input" onChange={handleFile} />
      <div id="paste-preview" className="paste-preview" ref={previewRef} />
      {previewInfo && <p className="muted" style={{ fontSize: 11 }}>{previewInfo}</p>}

      <label className="mt-label">Canvas coordinates (X_Y)</label>
      <div className="coords-row">
        <CoordsComponent
          id="paste-coords"
          className="mt-input coord-input"
          placeholder="0_0"
          value={coordStr}
          canvasIndent={canvasIndent}
          style={{ width: 140 }}
          onChange={val => {
            setCoordStr(val)
            const nums = parseCoordNumbers(val)
            if (nums && nums.length >= 2) {
              setX(String(nums[0]))
              setY(String(nums[1]))
            }
          }}
        />
        <button id="paste-pick" className="mt-btn secondary" onClick={handlePick}>📍 Pick</button>
      </div>

      {/* Protected paste option */}
      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: 8 }}>
        <input type="checkbox" checked={protectedPaste} onChange={e => setProtectedPaste(e.target.checked)} />
        Paste as protected
      </label>

      <button id="paste-submit" className="mt-btn primary" style={{ marginTop: 12 }} disabled={pasting} onClick={handlePaste}>
        Paste to Canvas
      </button>
      {status.msg && <div className={`mt-status ${status.type}`}>{status.msg}</div>}
    </div>
  )
}

function useAreaPicker(canvasRef, canvasSize, canvasIndent) {
  const [x1, setX1] = useState('')
  const [y1, setY1] = useState('')
  const [x2, setX2] = useState('')
  const [y2, setY2] = useState('')
  const [p1Str, setP1Str] = useState('')
  const [p2Str, setP2Str] = useState('')
  const [selecting, setSelecting] = useState(false)

  useEffect(() => {
    setP1Str(x1 !== '' && y1 !== '' ? `${x1}_${y1}` : '')
  }, [x1, y1])

  useEffect(() => {
    setP2Str(x2 !== '' && y2 !== '' ? `${x2}_${y2}` : '')
  }, [x2, y2])

  function startPick(onStatus) {
    setSelecting(true)
    onStatus({ msg: 'Drag an area on canvas…', type: 'info' })
    canvasRef.current?.startWatchSelect((coords) => {
      setSelecting(false)
      const hx1 = Math.floor(coords.x1 - (canvasSize || 0))
      const hy1 = Math.floor(coords.y1 - (canvasSize || 0))
      const hx2 = Math.floor(coords.x2 - (canvasSize || 0))
      const hy2 = Math.floor(coords.y2 - (canvasSize || 0))
      setX1(String(hx1)); setY1(String(hy1))
      setX2(String(hx2)); setY2(String(hy2))
      onStatus({ msg: `Area selected: ${hx1}_${hy1} to ${hx2}_${hy2}`, type: 'ok' })
    })
  }

  function getPixelCoords(size) {
    const s = size || 0
    const cx1 = parseInt(x1) + s
    const cy1 = parseInt(y1) + s
    const cx2 = parseInt(x2) + s
    const cy2 = parseInt(y2) + s
    return { cx1, cy1, cx2, cy2, valid: ![cx1, cy1, cx2, cy2].some(Number.isNaN) }
  }

  function CoordInputs() {
    return (
      <CoordsPairInputs
        p1Str={p1Str}
        p2Str={p2Str}
        setP1Str={setP1Str}
        setP2Str={setP2Str}
        setX1={setX1}
        setY1={setY1}
        setX2={setX2}
        setY2={setY2}
        canvasIndent={canvasIndent}
      />
    )
  }

  return { x1, y1, x2, y2, p1Str, p2Str, selecting, startPick, getPixelCoords, CoordInputs }
}

function ColorSwatchPicker({ colors = [], label, selected, onSelect, multi = false }) {
  return (
    <div style={{ marginTop: 8 }}>
      {label && <span style={{ fontSize: 10, display: 'block', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', marginBottom: 6 }}>{label}</span>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 120, overflowY: 'auto', padding: 4, background: 'rgba(0,0,0,0.2)', borderRadius: 4 }}>
        {colors.map((rgb, idx) => {
          const [r, g, b] = rgb
          const isSelected = multi ? (selected || []).includes(idx) : selected === idx
          return (
            <div
              key={idx}
              title={`Color #${idx} (${r},${g},${b})`}
              onClick={() => {
                if (multi) {
                  const arr = selected || []
                  onSelect(isSelected ? arr.filter(i => i !== idx) : [...arr, idx])
                } else {
                  onSelect(isSelected ? null : idx)
                }
              }}
              style={{
                width: 22, height: 22, borderRadius: 3, cursor: 'pointer', flexShrink: 0,
                background: `rgb(${r},${g},${b})`,
                boxSizing: 'border-box',
                border: isSelected ? '2.5px solid #fff' : '1.5px solid rgba(255,255,255,0.15)',
                outline: isSelected ? '1.5px solid #2196f3' : 'none',
                position: 'relative',
              }}
            >
              <span style={{ position: 'absolute', bottom: 0, right: 1, fontSize: 7, color: r + g + b < 200 ? '#fff' : '#000', lineHeight: 1, pointerEvents: 'none' }}>{idx}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ReplaceColorTab({ canvasRef, canvasSize, canvasId, configs }) {
  const activeCanvasSize = useMemo(() => {
    const cfg = configs?.[canvasId]
    return cfg ? (cfg.size * 256) / 2 : canvasSize
  }, [configs, canvasId, canvasSize])

  const area = useAreaPicker(canvasRef, activeCanvasSize, configs?.[canvasId]?.indent)
  const [sourceColor, setSourceColor] = useState(null)
  const [targetColor, setTargetColor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState({ msg: '', type: '' })

  useEffect(() => () => canvasRef.current?.stopWatchSelect(), [canvasRef])

  const palette = useMemo(() => {
    const cfg = configs?.[canvasId]
    return cfg?.colors || []
  }, [configs, canvasId])

  async function run() {
    if (sourceColor === null) { setStatus({ msg: 'Select a source color.', type: 'warn' }); return }
    if (targetColor === null) { setStatus({ msg: 'Select a target color.', type: 'warn' }); return }
    const { cx1, cy1, cx2, cy2, valid } = area.getPixelCoords(activeCanvasSize)
    if (!valid) { setStatus({ msg: 'Set valid area coordinates first.', type: 'warn' }); return }

    setBusy(true)
    console.log('Replacing color:', {
      canvas_id: canvasId,
      x1: cx1,
      y1: cy1,
      x2: cx2,
      y2: cy2,
      source_color: sourceColor,
      target_color: targetColor,
      activeCanvasSize
    })

    try {
      const r = await fetch('/admin/watch/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas_id: canvasId,
          x1: cx1, y1: cy1, x2: cx2, y2: cy2,
          action: 'replace_specific',
          source_color: sourceColor,
          target_color: targetColor,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.detail || 'Request failed')
      setStatus({ msg: `Replaced ${d.count ?? 0} pixels.`, type: 'ok' })
    } catch (err) {
      setStatus({ msg: `Error: ${err.message}`, type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button type="button" className={`mt-btn secondary${area.selecting ? ' active' : ''}`}
        onClick={() => area.startPick(setStatus)} disabled={busy} style={{ marginBottom: 8, width: '100%' }}>
        {area.selecting ? 'Selecting…' : '📐 Select Area on Canvas'}
      </button>
      <area.CoordInputs />
      <ColorSwatchPicker colors={palette} label="Source color (to replace)" selected={sourceColor} onSelect={setSourceColor} multi={false} />
      {sourceColor !== null && (
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>
          Source: #{sourceColor}
        </div>
      )}
      <ColorSwatchPicker colors={palette} label="Target color (replace with)" selected={targetColor} onSelect={setTargetColor} multi={false} />
      {targetColor !== null && (
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>Target: #{targetColor}</div>
      )}
      <button className="mt-btn primary" disabled={busy || sourceColor === null || targetColor === null}
        style={{ marginTop: 12, width: '100%' }} onClick={run}>
        {busy ? 'Replacing…' : '🔄 Replace Color'}
      </button>
      {status.msg && <div className={`mt-status ${status.type}`} style={{ marginTop: 8 }}>{status.msg}</div>}
    </div>
  )
}

function FillAreaTab({ canvasRef, canvasSize, canvasId, configs }) {
  const activeCanvasSize = useMemo(() => {
    const cfg = configs?.[canvasId]
    return cfg ? (cfg.size * 256) / 2 : canvasSize
  }, [configs, canvasId, canvasSize])

  const area = useAreaPicker(canvasRef, activeCanvasSize, configs?.[canvasId]?.indent)
  const [fillColor, setFillColor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState({ msg: '', type: '' })

  useEffect(() => () => canvasRef.current?.stopWatchSelect(), [canvasRef])

  const palette = useMemo(() => {
    const cfg = configs?.[canvasId]
    return cfg?.colors || []
  }, [configs, canvasId])

  async function run() {
    if (fillColor === null) { setStatus({ msg: 'Select a fill color.', type: 'warn' }); return }
    const { cx1, cy1, cx2, cy2, valid } = area.getPixelCoords(activeCanvasSize)
    if (!valid) { setStatus({ msg: 'Set valid area coordinates first.', type: 'warn' }); return }
    if (!confirm('This will overwrite every pixel in the selected area with the chosen color. Continue?')) return
    setBusy(true)
    setStatus({ msg: 'Filling area…', type: 'info' })
    console.log('Filling area:', {
      canvas_id: canvasId,
      x1: cx1,
      y1: cy1,
      x2: cx2,
      y2: cy2,
      target_color: fillColor,
      activeCanvasSize
    })
    try {
      const r = await fetch('/admin/watch/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas_id: canvasId,
          x1: cx1, y1: cy1, x2: cx2, y2: cy2,
          action: 'replace_all',
          target_color: fillColor,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.detail || 'Request failed')
      setStatus({ msg: `Filled ${d.count ?? 0} pixels with color #${fillColor}.`, type: 'ok' })
    } catch (err) {
      setStatus({ msg: `Failed: ${err.message}`, type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button type="button" className={`mt-btn secondary${area.selecting ? ' active' : ''}`}
        onClick={() => area.startPick(setStatus)} disabled={busy} style={{ marginBottom: 8, width: '100%' }}>
        {area.selecting ? 'Selecting…' : '📐 Select Area on Canvas'}
      </button>
      <area.CoordInputs />
      <ColorSwatchPicker colors={palette} label="Fill color" selected={fillColor} onSelect={setFillColor} multi={false} />
      {fillColor !== null && (
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>Fill with: #{fillColor}</div>
      )}
      <button className="mt-btn primary" disabled={busy || fillColor === null}
        style={{ marginTop: 12, width: '100%' }} onClick={run}>
        {busy ? 'Filling…' : '🪣 Fill Area'}
      </button>
      {status.msg && <div className={`mt-status ${status.type}`} style={{ marginTop: 8 }}>{status.msg}</div>}
    </div>
  )
}

function CanvasTab({ canvasRef, canvasSize, canvasId: defaultCanvasId, configs }) {
  const [mode, setMode] = useState('paste')
  const [canvasId, setCanvasId] = useState(defaultCanvasId ?? 0)

  useEffect(() => {
    setCanvasId(defaultCanvasId ?? 0)
  }, [defaultCanvasId])

  useEffect(() => () => canvasRef.current?.stopTemplatePick(), [canvasRef])

  const canvasOptions = useMemo(() => {
    if (!configs) return [{ id: 0, name: 'Canvas #0' }]
    return Object.entries(configs).map(([id, c]) => ({
      id: Number(id),
      name: c.name || c.indent || `Canvas ${id}`,
    }))
  }, [configs])

  return (
    <div id="mt-canvas" className="mt-tabcontent">
      <label className="mt-label">Canvas</label>
      <div className="quick-role-row">
        <select
          className="role-sel"
          value={canvasId}
          onChange={e => setCanvasId(intOr(e.target.value, 0))}
        >
          {canvasOptions.map(c => (
            <option key={c.id} value={c.id}>
              #{c.id} — {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-tabs" style={{ marginTop: 12, marginBottom: 12 }}>
        <button type="button" className={`mt-tab${mode === 'paste' ? ' active' : ''}`} onClick={() => setMode('paste')}>🖼 Paste</button>
        <button type="button" className={`mt-tab${mode === 'protect' ? ' active' : ''}`} onClick={() => setMode('protect')}>🛡 Protect</button>
        <button type="button" className={`mt-tab${mode === 'rollback' ? ' active' : ''}`} onClick={() => setMode('rollback')}>↩ Rollback</button>
        <button type="button" className={`mt-tab${mode === 'replacecolor' ? ' active' : ''}`} onClick={() => setMode('replacecolor')}>🔄 Replace Color</button>
        <button type="button" className={`mt-tab${mode === 'fillarea' ? ' active' : ''}`} onClick={() => setMode('fillarea')}>🪣 Fill Area</button>
      </div>

      {mode === 'paste' && <PasteTab canvasRef={canvasRef} canvasSize={canvasSize} canvasId={canvasId} configs={configs} />}
      {mode === 'protect' && <ProtectTab canvasRef={canvasRef} canvasSize={canvasSize} canvasId={canvasId} configs={configs} />}
      {mode === 'rollback' && <SnapshotRollbackTab canvasRef={canvasRef} canvasSize={canvasSize} canvasId={canvasId} configs={configs} />}
      {mode === 'replacecolor' && <ReplaceColorTab canvasRef={canvasRef} canvasSize={canvasSize} canvasId={canvasId} configs={configs} />}
      {mode === 'fillarea' && <FillAreaTab canvasRef={canvasRef} canvasSize={canvasSize} canvasId={canvasId} configs={configs} />}
    </div>
  )
}

// ── Icons management tab (mod+) ─────────────────────────────────────────

function IconsTab({ onIconsChange }) {
  const [icons, setIcons] = useState([])
  const [name, setName] = useState('')
  const [b64, setB64] = useState(null)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const fileRef = useRef()

  useEffect(() => { fetchIcons() }, [])

  async function fetchIcons() {
    const r = await fetch('/icons')
    if (r.ok) { const d = await r.json(); setIcons(d.icons || []) }
  }

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = 16; c.height = 16
      c.getContext('2d').drawImage(img, 0, 0, 16, 16)
      setB64(c.toDataURL('image/png'))
    }
    img.src = URL.createObjectURL(file)
    e.target.value = ''
  }

  async function upload() {
    if (!name.trim() || !b64) { setStatus('Enter a name and select an image.'); return }
    setLoading(true)
    const r = await fetch('/admin/icons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), image_b64: b64 }),
    })
    if (r.ok) {
      setStatus('✓ Icon uploaded')
      setName(''); setB64(null)
      await fetchIcons()
      onIconsChange?.()
    } else {
      const j = await r.json().catch(() => ({}))
      setStatus(`✗ ${j.detail || 'Failed'}`)
    }
    setLoading(false)
  }

  async function removeIcon(id) {
    if (!confirm('Delete this icon?')) return
    const r = await fetch(`/admin/icons/${id}`, { method: 'DELETE' })
    if (r.ok) { await fetchIcons(); onIconsChange?.() }
  }

  return (
    <div id="mt-icons" className="mt-tabcontent">
      <label className="mt-label">Upload new 16×16 icon</label>
      <div className="icon-upload-row">
        {b64 && <img src={b64} alt="preview" className="icon-preview-lg" />}
        <div style={{ flex: 1 }}>
          <input className="mt-input" placeholder="Icon name"
            value={name} onChange={e => setName(e.target.value)}
            style={{ marginBottom: 6 }} />
          <label className="mt-btn secondary" style={{ display: 'inline-block' }}>
            Choose image
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
          </label>
        </div>
        <button className="mt-btn primary" disabled={loading || !b64 || !name.trim()} onClick={upload}>
          Upload
        </button>
      </div>
      {status && <div className="mt-status info">{status}</div>}

      <label className="mt-label" style={{ marginTop: 12 }}>Existing icons</label>
      {icons.length === 0
        ? <p className="muted">No icons yet.</p>
        : (
          <div className="icons-grid">
            {icons.map(ic => (
              <div key={ic.id} className="icon-card">
                <img src={ic.image_b64} alt={ic.name} className="icon-preview" />
                <span className="icon-name">{ic.name}</span>
                <span className="icon-id">#{ic.id}</span>
                <button className="icon-del" onClick={() => removeIcon(ic.id)}>✕</button>
              </div>
            ))}
          </div>
        )
      }
    </div>
  )
}

// ── Cosmetics assign tab (admin+) ──────────────────────────────────────

const TIER_OPTS = [
  { value: 0, label: 'None (earned only)' },
  { value: 1, label: 'Tier 1 — Custom PFP' },
  { value: 2, label: 'Tier 2 — Styles & Banner' },
  { value: 3, label: 'Tier 3 — Full access' },
]

const UN_STYLES = [null, 'gold', 'fire', 'ice', 'rainbow', 'void']
const MSG_STYLES = [null, 'glow', 'highlight', 'minimal']

function CosmeticsTab() {
  const [uid, setUid] = useState('')
  const [icons, setIcons] = useState([])
  const [flair, setFlair] = useState(null)
  const [tier, setTier] = useState(0)
  const [iconId, setIconId] = useState('')
  const [unStyle, setUnStyle] = useState('')
  const [msgStyle, setMsgStyle] = useState('')
  const [status, setStatus] = useState({ msg: '', ok: true })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/icons').then(r => r.ok ? r.json() : { icons: [] }).then(d => setIcons(d.icons || []))
  }, [])

  async function loadFlair() {
    const id = parseInt(uid)
    if (isNaN(id)) return
    const r = await fetch(`/flair/${id}`)
    if (!r.ok) { setStatus({ msg: 'User not found', ok: false }); return }
    const d = await r.json()
    setFlair(d)
    setTier(d.granted_tier ?? 0)
    setIconId(d.custom_icon?.id ?? '')
    setUnStyle(d.username_style ?? '')
    setMsgStyle(d.msg_style ?? '')
    setStatus({ msg: '', ok: true })
  }

  async function apply() {
    const id = parseInt(uid)
    if (isNaN(id)) return
    setSaving(true)
    const body = {
      granted_tier: tier,
      custom_icon_id: iconId !== '' ? parseInt(iconId) : null,
      username_style: unStyle || null,
      msg_style: msgStyle || null,
    }
    const r = await fetch(`/admin/users/${id}/flair`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({}))
    setStatus({ msg: r.ok ? `✓ Flair updated for #${id}` : `✗ ${j.detail || 'Failed'}`, ok: r.ok })
    setSaving(false)
  }

  return (
    <div id="mt-cosmetics" className="mt-tabcontent">
      <label className="mt-label">User ID</label>
      <div className="quick-role-row">
        <input className="mt-input" type="number" placeholder="User ID"
          value={uid} onChange={e => setUid(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadFlair()}
          style={{ width: 100 }} />
        <button className="mt-btn secondary" onClick={loadFlair}>Load flair</button>
      </div>

      {flair && (
        <>
          <p className="muted" style={{ fontSize: 11, margin: '6px 0 10px' }}>
            Earned tier: {flair.effective_tier} • {(flair.pixels_placed || 0).toLocaleString()} px on earth canvas
          </p>

          <label className="mt-label">Grant cosmetic tier</label>
          <select className="role-sel" value={tier} onChange={e => setTier(Number(e.target.value))}>
            {TIER_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>

          <label className="mt-label" style={{ marginTop: 10 }}>Assign custom icon</label>
          <select className="role-sel" value={iconId} onChange={e => setIconId(e.target.value)}>
            <option value="">None</option>
            {icons.map(ic => <option key={ic.id} value={ic.id}>{ic.name} (#{ic.id})</option>)}
          </select>

          <label className="mt-label" style={{ marginTop: 10 }}>Force username style</label>
          <select className="role-sel" value={unStyle} onChange={e => setUnStyle(e.target.value)}>
            {UN_STYLES.map(s => <option key={s ?? 'none'} value={s ?? ''}>{s ?? 'Default'}</option>)}
          </select>

          <label className="mt-label" style={{ marginTop: 10 }}>Force message style</label>
          <select className="role-sel" value={msgStyle} onChange={e => setMsgStyle(e.target.value)}>
            {MSG_STYLES.map(s => <option key={s ?? 'none'} value={s ?? ''}>{s ?? 'Default'}</option>)}
          </select>

          <button className="mt-btn primary" style={{ marginTop: 14 }} disabled={saving} onClick={apply}>
            Apply to user
          </button>
        </>
      )}

      {status.msg && <div className={`mt-status ${status.ok ? 'ok' : 'error'}`}>{status.msg}</div>}
    </div>
  )
}

// ── Canvas Management Tab (admin only) ───────────────────────────────────────

const CANVAS_DEFAULTS = {
  id: '', name: '', indent: 'c', hotkey: '', size: 256, description: '',
  unset_cooldown: 750, set_cooldown: 750, pixel_requirement: 0,
  stack: 120000, ranked: true, unset_pixels_below: 2,
  colors: [[255, 255, 255], [0, 0, 0], [229, 0, 0], [0, 101, 19], [0, 0, 234]],
}

// Pixel size ↔ chunk conversion (1 chunk = 256 px)
const CHUNK_PX_SIZE = 256
function isPow2(n) { return n > 0 && (n & (n - 1)) === 0 }
function chunksToPixels(chunks) { return chunks * CHUNK_PX_SIZE }
function pixelsToChunks(px) { return Math.round(px / CHUNK_PX_SIZE) }

// ── Color helpers ──
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => String(v.toString(16)).padStart(2, '0')).join('')
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function formatMsDuration(ms) {
  if (ms === '' || ms === null || ms === undefined || Number.isNaN(Number(ms))) return ''
  const val = Number(ms)
  if (val <= 0) return '0s (no cooldown)'
  if (val < 1000) return `${val}ms (${(val / 1000).toFixed(2)}s)`
  if (val < 60000) return `${val.toLocaleString()}ms (${(val / 1000).toFixed(1)}s)`
  const mins = (val / 60000).toFixed(1)
  const secs = (val / 1000).toFixed(0)
  return `${val.toLocaleString()}ms (${mins} min / ${secs}s)`
}

// ── Stable field helper — defined OUTSIDE CanvasForm so React never remounts inputs ──
function CanvasField({ label, field, form, type = 'text', setForm, hint, isCd, ...rest }) {
  function handleChange(e) {
    const val = e.target.value
    if (type === 'number') {
      const parsed = val === '' ? '' : (Number.isNaN(parseFloat(val)) ? '' : parseFloat(val))
      setForm(f => ({ ...f, [field]: parsed }))
    } else {
      setForm(f => ({ ...f, [field]: val }))
    }
  }

  function adjustCd(delta) {
    setForm(f => {
      const current = Number(f[field]) || 0
      const next = Math.max(0, current + delta)
      return { ...f, [field]: next }
    })
  }

  const currentVal = form[field]
  const cdHint = isCd ? formatMsDuration(currentVal) : null

  return (
    <div className="mt-field">
      <label className="mt-label">{label}</label>
      <input
        className="mt-input"
        type={type}
        value={currentVal ?? ''}
        onChange={handleChange}
        {...rest}
      />
      {isCd && (
        <div className="cd-quick-btns">
          <button type="button" className="mt-btn-xs" onClick={() => adjustCd(-1000)} title="-1 second">-1s</button>
          <button type="button" className="mt-btn-xs" onClick={() => adjustCd(-100)} title="-100 ms">-100ms</button>
          <button type="button" className="mt-btn-xs" onClick={() => adjustCd(100)} title="+100 ms">+100ms</button>
          <button type="button" className="mt-btn-xs" onClick={() => adjustCd(1000)} title="+1 second">+1s</button>
          <button type="button" className="mt-btn-xs" onClick={() => adjustCd(5000)} title="+5 seconds">+5s</button>
        </div>
      )}
      {(hint || cdHint) && (
        <span className="mt-field-hint">
          {cdHint || hint}
        </span>
      )}
    </div>
  )
}

// ── Palette Editor ──
function ColorPaletteEditor({ colors = [], onChange, allCanvases = [] }) {
  const [importSrc, setImportSrc] = useState('')

  function update(i, hex) {
    const next = [...colors]; next[i] = hexToRgb(hex); onChange(next)
  }
  function add() { onChange([...colors, [255, 255, 255]]) }
  function remove(i) { const next = [...colors]; next.splice(i, 1); onChange(next) }

  function importFromCanvas() {
    const id = Number(importSrc)
    const src = allCanvases.find(c => c.id === id)
    if (!src?.colors?.length) return
    onChange([...src.colors])
  }

  return (
    <div className="palette-editor">
      <label className="mt-label">Color Palette ({colors.length} colors)</label>
      <div className="palette-grid">
        {colors.map((col, i) => {
          const hex = rgbToHex(col)
          const [r, g, b] = col
          const bright = (r * 299 + g * 587 + b * 114) / 1000 > 128
          return (
            <div key={i} className="pe-swatch" style={{ background: hex }} title={`#${i}: ${hex}`}>
              <input
                type="color" className="pe-color-input"
                value={hex}
                onChange={e => update(i, e.target.value)}
              />
              <div className="pe-swatch-overlay" style={{ color: bright ? '#000' : '#fff' }}>
                <span className="pe-idx">{i}</span>
                <button className="pe-del" onClick={() => remove(i)} title="Remove">×</button>
              </div>
            </div>
          )
        })}
        <button className="pe-add" onClick={add} title="Add color">+</button>
      </div>
      <div className="pe-hint">Click a swatch to change · Index 0 = background/unset color</div>
      {allCanvases.length > 0 && (
        <div className="pe-import-row">
          <select
            className="mt-input pe-import-select"
            value={importSrc}
            onChange={e => setImportSrc(e.target.value)}
          >
            <option value="">Import palette from canvas…</option>
            {allCanvases.map(c => (
              <option key={c.id} value={c.id}>#{c.id} — {c.name}</option>
            ))}
          </select>
          <button
            className="mt-btn"
            disabled={!importSrc}
            onClick={importFromCanvas}
          >
            Import
          </button>
        </div>
      )}
    </div>
  )
}

function CanvasForm({ initial, onSave, onCancel, creating, allCanvases = [] }) {
  const [form, setForm] = useState({
    ...CANVAS_DEFAULTS,
    ...initial,
    colors: initial?.colors ?? CANVAS_DEFAULTS.colors,
  })
  // sizePixels is the pixel-size string the user types
  const [sizePixels, setSizePixels] = useState(
    String(chunksToPixels(initial?.size ?? CANVAS_DEFAULTS.size))
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  // Parse + validate the pixel size field
  const parsedPx = parseInt(sizePixels, 10)
  const sizeValid = !isNaN(parsedPx) && isPow2(parsedPx) && parsedPx >= 256 && parsedPx <= 131072
  const sizeChunks = sizeValid ? pixelsToChunks(parsedPx) : null

  async function save() {
    if (!sizeValid) { setErr('Canvas size must be a power of 2 between 256 and 131072 (e.g. 32768, 65536).'); return }
    setSaving(true); setErr('')
    try {
      const url = creating ? '/admin/canvases' : `/admin/canvases/${initial.id}`
      const method = creating ? 'POST' : 'PATCH'
      const body = { ...form, size: sizeChunks }
      if (creating) body.id = form.id !== '' ? Number(form.id) : undefined
      const r = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || 'Failed') }
      window.dispatchEvent(new CustomEvent('pixmap:canvases-updated'))
      onSave()
    } catch (e) { setErr(e.message) }
    setSaving(false)
  }

  return (
    <div className="canvas-form">
      {creating && (
        <CanvasField
          label="Canvas ID (leave blank = auto)"
          field="id"
          type="number"
          min="0"
          form={form}
          setForm={setForm}
        />
      )}
      <div className="canvas-form-row">
        <CanvasField label="Name" field="name" form={form} setForm={setForm} />
        <CanvasField label="Indent key" field="indent" form={form} setForm={setForm} />
        <CanvasField label="Hotkey (1-9)" field="hotkey" placeholder="e.g. 1" form={form} setForm={setForm} />
      </div>
      <CanvasField label="Description" field="description" form={form} setForm={setForm} />
      <div className="canvas-form-row">
        <div className="mt-field">
          <label className="mt-label">Canvas size (px, power of 2)</label>
          <input
            className={`mt-input${!sizeValid && sizePixels !== '' ? ' input-error' : ''}`}
            type="number"
            value={sizePixels}
            min="256" max="131072" step="256"
            onChange={e => setSizePixels(e.target.value)}
          />
          <span className="mt-field-hint">
            {sizeValid
              ? `${parsedPx.toLocaleString()} × ${parsedPx.toLocaleString()} px · ${sizeChunks} × ${sizeChunks} chunks`
              : sizePixels !== '' ? '⚠ Must be a power of 2 (e.g. 32768, 65536)' : ''}
          </span>
        </div>
        <CanvasField label="Pixel req." field="pixel_requirement" type="number" min="0" form={form} setForm={setForm} />
      </div>
      <div className="canvas-form-row">
        <CanvasField label="Unset CD (ms)" field="unset_cooldown" type="number" min="0" step="50" isCd form={form} setForm={setForm} />
        <CanvasField label="Set CD (ms)" field="set_cooldown" type="number" min="0" step="50" isCd form={form} setForm={setForm} />
      </div>
      <div className="canvas-form-row">
        <CanvasField label="Stack (ms)" field="stack" type="number" min="0" step="1000" isCd form={form} setForm={setForm} />
        <CanvasField label="Unset below idx" field="unset_pixels_below" type="number" min="0" form={form} setForm={setForm} />
      </div>
      <div className="mt-field">
        <label className="mt-label">
          <input type="checkbox" checked={form.ranked} onChange={e => set('ranked', e.target.checked)} />
          {' '}Ranked (counts towards leaderboard)
        </label>
      </div>
      <ColorPaletteEditor
        colors={form.colors}
        onChange={v => set('colors', v)}
        allCanvases={allCanvases.filter(c => c.id !== initial?.id)}
      />
      {err && <div className="mt-status error">{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="mt-btn primary" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : creating ? 'Create Canvas' : 'Save Changes'}
        </button>
        <button className="mt-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function CanvasesTab() {
  const [canvases, setCanvases] = useState(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)   // canvas id being edited
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(null)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/admin/canvases')
      if (!r.ok) throw new Error()
      const { canvases: list } = await r.json()
      setCanvases(list)
    } catch { setCanvases([]) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function del(id) {
    if (!window.confirm(`Delete canvas #${id}? This only affects the running server (resets on restart).`)) return
    setDeleting(id)
    await fetch(`/admin/canvases/${id}`, { method: 'DELETE' })
    setDeleting(null)
    load()
  }

  if (loading) return <div className="mt-status">Loading…</div>

  if (creating) return (
    <CanvasForm
      initial={CANVAS_DEFAULTS}
      creating
      allCanvases={canvases ?? []}
      onSave={() => { setCreating(false); load() }}
      onCancel={() => setCreating(false)}
    />
  )

  if (editing !== null) {
    const cv = canvases.find(c => c.id === editing)
    return (
      <CanvasForm
        initial={cv}
        creating={false}
        allCanvases={canvases ?? []}
        onSave={() => { setEditing(null); load() }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div>
      <button className="mt-btn primary" style={{ marginBottom: 10 }} onClick={() => setCreating(true)}>
        + New Canvas
      </button>
      {canvases?.length === 0 && <div className="mt-status">No canvases found.</div>}
      {canvases?.map(c => (
        <div key={c.id} className="canvas-list-row">
          <div className="canvas-list-info">
            <span className="canvas-list-name">#{c.id} — {c.name}</span>
            <span className="canvas-list-meta">
              {c.size}×{c.size} chunks · CD {c.set_cooldown}ms · {c.ranked ? 'Ranked' : 'Unranked'}
              {c.pixel_requirement > 0 ? ` · ${c.pixel_requirement.toLocaleString()} px req` : ''}
            </span>
            {c.description && <span className="canvas-list-desc">{c.description}</span>}
          </div>
          <div className="canvas-list-actions">
            <button className="mt-btn" onClick={() => setEditing(c.id)}>Edit</button>
            <button className="mt-btn danger" disabled={deleting === c.id} onClick={() => del(c.id)}>
              {deleting === c.id ? '…' : 'Delete'}
            </button>
          </div>
        </div>
      ))}
      <div className="mt-status" style={{ marginTop: 10, fontSize: 10 }}>
        ⚠ Canvas changes are runtime-only and reset on server restart.
      </div>
    </div>
  )
}


// ── Live connections tab ───────────────────────────────────────────────────────

function LiveTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  async function load() {
    setLoading(true)
    try { const r = await fetch('/admin/live'); if (r.ok) setData(await r.json()) }
    catch { } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  async function kick(uid, name) {
    if (!confirm(`Kick ${name}?`)) return
    await fetch(`/admin/users/${uid}/kick`, { method: 'POST' })
    load()
  }
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span className="mt-label">🟢 Live ({data?.total ?? '…'})</span>
        <button className="mt-btn secondary" onClick={load} disabled={loading}>↺ Refresh</button>
      </div>
      {loading && <div className="mt-status">Loading…</div>}
      {data?.connections?.map(c => {
        const av = getAvatarUrl(c, 24)
        return (
          <div key={c.user_id} className="live-row">
            <img src={av} className="urow-avatar" style={{ width: 22, height: 22 }} alt="" />
            <div className="live-info">
              <span className="urow-name">{c.username}</span>
              <span className={`role-badge role-${c.role}`}>{c.role}</span>
              {c.is_proxy && <span className="banned-tag">PROXY</span>}
              <span className="urow-stat">{c.tabs} tab{c.tabs !== 1 ? 's' : ''} · {c.devices} IID{c.devices !== 1 ? 's' : ''} · canvas {c.canvas}</span>
              <span className="urow-stat" style={{ fontFamily: 'monospace', fontSize: 10 }}>{c.ips.join(', ')}</span>
            </div>
            <button className="mt-btn danger" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11 }} onClick={() => kick(c.user_id, c.username)}>Kick</button>
          </div>
        )
      })}
      {data?.connections?.length === 0 && <div className="mt-status">No users online.</div>}
    </div>
  )
}

// ── User inspector ─────────────────────────────────────────────────────────────

function UserInspector({ userId, onClose }) {
  const [sub, setSub] = useState('ips')
  const [cache, setCache] = useState({})
  const [loading, setLoading] = useState(false)
  const [showVisualizer, setShowVisualizer] = useState(false)
  const URLS = { ips: `/admin/users/${userId}/ips`, ipalts: `/admin/users/${userId}/alts`, pixels: `/admin/users/${userId}/pixels?limit=200`, conns: `/admin/users/${userId}/connections` }
  async function go(t) {
    setSub(t)
    if (cache[t]) return
    setLoading(true)
    try { const r = await fetch(URLS[t]); if (r.ok) { const d = await r.json(); setCache(p => ({ ...p, [t]: d })) } }
    catch { } finally { setLoading(false) }
  }
  useEffect(() => { go('ips') }, [userId])
  const d = cache[sub]
  const TABS = [{ k: 'ips', l: '🔑 IIDs' }, { k: 'ipalts', l: '🕵 IID Alts' }, { k: 'pixels', l: '🎨 Pixels' }, { k: 'conns', l: '📡 Live' }]
  return (
    <div className="inspector-panel">
      <div style={{ display: 'flex', gap: 3, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {TABS.map(t => <button key={t.k} className={`mt-btn secondary${sub === t.k ? ' active-sub' : ''}`} style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => go(t.k)}>{t.l}</button>)}
        <button
          className="mt-btn secondary"
          style={{ fontSize: 10, padding: '2px 6px', color: '#00ffcc', borderColor: 'rgba(0,255,204,0.3)' }}
          onClick={() => setShowVisualizer(true)}
          title="Visualize placement trajectory"
        >
          🎬 Visualize Trajectory
        </button>
        <button className="mt-btn danger" style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 6px' }} onClick={onClose}>✕ Close</button>
      </div>
      {loading && <div className="mt-status" style={{ padding: 4 }}>Loading…</div>}
      {sub === 'ips' && d && (
        <div className="inspector-list">
          {(d.ips || []).length === 0 && <div className="mt-status">No IPs.</div>}
          {(d.ips || []).map((ip, i) => (
            <div key={i} className="inspector-row" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{ip.ip}</span>
              <CopyBtn text={ip.ip} title="Copy IP / IID" />
              {ip.cidr && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <span className="urow-stat" style={{ fontFamily: 'monospace' }}>{ip.cidr}</span>
                  <CopyBtn text={ip.cidr} label="CIDR" title="Copy CIDR" />
                </div>
              )}
              <span className="urow-stat">
                {ip.country}{ip.last_seen ? ` · ${new Date(ip.last_seen).toLocaleString()}` : ''}
              </span>
              <button
                className="mt-btn secondary"
                style={{ fontSize: 9, padding: '1px 5px', marginLeft: 'auto' }}
                onClick={() => handleRollbackPixelCount({ ip: ip.ip, defaultCount: 100 })}
                title="Rollback pixels placed from this IP"
              >
                ⏪ Rb IP
              </button>
            </div>
          ))}
        </div>
      )}
      {sub === 'ipalts' && d && (
        <div className="inspector-list">
          {(d.alts || []).length === 0 && <div className="mt-status">No IP alts.</div>}
          {(d.alts || []).map(a => (
            <div key={a.id} className="inspector-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="urow-name">#{a.id} {a.username}</span>
              <CopyBtn text={String(a.id)} title="Copy Alt ID" />
              <span className={`role-badge role-${a.role}`}>{a.role}</span>
              {a.banned && <span className="banned-tag">BANNED</span>}
              <span className="urow-stat" style={{ fontSize: 10, fontFamily: 'monospace' }}>{(a.shared_ips || []).join(', ')}</span>
              {a.shared_ips?.[0] && <CopyBtn text={a.shared_ips[0]} title="Copy Shared IP" />}
            </div>
          ))}
        </div>
      )}
      {sub === 'pixels' && d && (
        <div className="inspector-list" style={{ maxHeight: 200, overflowY: 'auto' }}>
          {(d.pixels || []).length === 0 && <div className="mt-status">No placements.</div>}
          {(d.pixels || []).map((p, i) => (
            <div key={i} className="inspector-row" style={{ fontFamily: 'monospace', fontSize: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>({p.x},{p.y}) c{p.canvas_id}</span>
              <CopyBtn text={`${p.x}_${p.y}`} label="Coord" title="Copy Coordinates" />
              <span className="urow-stat">{new Date(p.placed_at + 'Z').toLocaleString()}</span>
              <span className="urow-stat">{p.ip}</span>
              <CopyBtn text={p.ip} title="Copy IP / IID" />
            </div>
          ))}
        </div>
      )}
      {sub === 'conns' && d && (
        <div className="inspector-list">
          {(d.connections || []).length === 0 && <div className="mt-status">Not connected.</div>}
          {(d.connections || []).map((c, i) => (
            <div key={i} className="inspector-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{c.ip}</span>
              <CopyBtn text={c.ip} title="Copy Live IP / IID" />
              <span className="urow-stat">{c.country} · canvas {c.canvas}</span>
              {c.is_proxy && <span className="banned-tag">PROXY</span>}
            </div>
          ))}
        </div>
      )}
      {showVisualizer && (
        <PixelTimelineVisualizer
          userId={userId}
          onClose={() => setShowVisualizer(false)}
        />
      )}
    </div>
  )
}


// ── Alts tab ──────────────────────────────────────────────────────────────────

function AltsTab() {
  const [uid, setUid] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [inspecting, setInspecting] = useState(null)
  async function lookup() {
    const id = parseInt(uid); if (isNaN(id)) return
    setLoading(true); setResult(null)
    try {
      const r = await fetch(`/admin/users/${id}/alts`)
      const ad = r.ok ? await r.json() : {}
      setResult({ ipAlts: ad.alts || [] })
    } catch { } finally { setLoading(false) }
  }
  const all = result ? (result.ipAlts || []).map(a => ({ ...a, via: 'ip' })) : []
  return (
    <div>
      <div className="quick-role-row" style={{ marginBottom: 10 }}>
        <input className="mt-input" type="number" placeholder="User ID" value={uid} onChange={e => setUid(e.target.value)} onKeyDown={e => e.key === 'Enter' && lookup()} style={{ width: 100 }} />
        <button className="mt-btn primary" onClick={lookup} disabled={loading}>Find Alts</button>
      </div>
      {loading && <div className="mt-status">Scanning…</div>}
      {result && all.length === 0 && <div className="mt-status ok">No alts found.</div>}
      {result && all.length > 0 && <div>
        <div className="mt-label" style={{ marginBottom: 6 }}>⚠ {all.length} potential alt{all.length !== 1 ? 's' : ''}</div>
        {all.map(a => <div key={a.id} className="inspector-row">
          <span className="urow-name">#{a.id} {a.username}</span>
          <span className={`role-badge role-${a.role}`}>{a.role}</span>
          {a.banned && <span className="banned-tag">BANNED</span>}
          <span className="urow-stat" style={{ fontSize: 10, color: '#aaa' }}>🌐 IP</span>
          <button className="mt-btn secondary" style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 6px' }} onClick={() => setInspecting(a.id)}>Inspect</button>
        </div>)}
      </div>}
      {inspecting && <UserInspector userId={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  )
}

// ── IID lookup tab (mods: IID prefix or CIDR; admins may also use raw IP) ─────

function IidLookupTab() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [inspecting, setInspecting] = useState(null)
  async function lookup() {
    const t = query.trim(); if (!t) return
    setLoading(true); setResult(null)
    try { const r = await fetch(`/admin/ip/${encodeURIComponent(t)}/users`); if (r.ok) setResult(await r.json()) }
    catch { } finally { setLoading(false) }
  }
  return (
    <div>
      <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Search by IID prefix (e.g. <code>a1b2c3d4</code> or UUID fragment) or CIDR. Admins may also search raw IP.
      </p>
      <div className="quick-role-row" style={{ marginBottom: 10 }}>
        <input className="mt-input" placeholder="IID / CIDR / IP (admin)" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && lookup()} style={{ width: 200 }} />
        <button className="mt-btn primary" onClick={lookup} disabled={loading}>Lookup</button>
      </div>
      {loading && <div className="mt-status">Searching…</div>}
      {result && result.users.length === 0 && <div className="mt-status">No accounts found.</div>}
      {result && result.users.length > 0 && <div>
        <div className="mt-label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{result.users.length} account{result.users.length !== 1 ? 's' : ''} for <code style={{ fontSize: 11 }}>{result.ip}</code></span>
          <CopyBtn text={result.ip} title="Copy IID / IP" />
        </div>
        {result.users.map(u => <div key={u.id} className="inspector-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="urow-name">#{u.id} {u.username}</span>
          <CopyBtn text={String(u.id)} title="Copy User ID" />
          <span className={`role-badge role-${u.role}`}>{u.role}</span>
          {u.banned && <span className="banned-tag">BANNED</span>}
          <span className="urow-stat">{(u.pixels_placed || 0).toLocaleString()} px</span>
          <button className="mt-btn secondary" style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 6px' }} onClick={() => setInspecting(u.id)}>Inspect</button>
        </div>)}
      </div>}

      {inspecting && <UserInspector userId={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  )
}

// ── Snapshot Rollback Panel ────────────────────────────────────────────────────
// Shows only available snapshot days/times from the history API — no free-form input.
// Always uses server UTC snapshot `ts` (never local datetime-local round-trips).

function SnapshotRollbackPanel({
  canvasId, globalPreviewCanvasRef,
  selectedTs, setSelectedTs,
  previewOnCanvas, setPreviewOnCanvas,
  availableDays, setAvailableDays,
  selectedDay, setSelectedDay,
  availableHours, setAvailableHours,
  snapshotsLoading, setSnapshotsLoading,
  x1, y1, x2, y2, canvasSize, activeCanvasId, activeCanvasSize,
  setStatus, handleWatch,
  confirmLabel = 'Confirm Rollback',
  showConfirm = true,
}) {
  useEffect(() => {
    let cancelled = false
    async function fetchDays() {
      setSnapshotsLoading(true)
      try {
        const r = await fetch(`/history/snapshots/${canvasId}`)
        if (!r.ok) return
        const data = await r.json()
        if (cancelled) return
        const days = data.days || []
        setAvailableDays(days)
        if (days.length > 0) setSelectedDay(days[days.length - 1])
      } catch { /* silent */ } finally {
        if (!cancelled) setSnapshotsLoading(false)
      }
    }
    fetchDays()
    return () => { cancelled = true }
  }, [canvasId])

  useEffect(() => {
    if (!selectedDay) return
    let cancelled = false
    async function fetchHours() {
      setSnapshotsLoading(true)
      try {
        const r = await fetch(`/history/snapshots/${canvasId}?day=${selectedDay}`)
        if (!r.ok) return
        const data = await r.json()
        if (cancelled) return
        const snaps = data.snapshots || []
        setAvailableHours(snaps)
        if (snaps.length > 0) {
          setSelectedTs(snaps[snaps.length - 1].ts)
          setPreviewOnCanvas(true)
        } else {
          setSelectedTs(null)
        }
      } catch { /* silent */ } finally {
        if (!cancelled) setSnapshotsLoading(false)
      }
    }
    fetchHours()
    return () => { cancelled = true }
  }, [selectedDay, canvasId])

  function formatDay(d) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  }

  function formatHour(snap) {
    return `${snap.hhmm.slice(0, 2)}:${snap.hhmm.slice(2, 4)} UTC`
  }

  function onSelectHour(ts) {
    setSelectedTs(ts)
    setPreviewOnCanvas(true)
  }

  const selectedSnap = availableHours.find(s => s.ts === selectedTs) || null

  async function runRollback() {
    if (selectedTs == null) return
    if (!confirm('Rollback the selected area to this snapshot?')) return
    const effCanvasSize = activeCanvasSize ?? canvasSize ?? 0
    const effCanvasId = activeCanvasId ?? canvasId ?? 0
    const cx1 = parseInt(x1) + effCanvasSize
    const cy1 = parseInt(y1) + effCanvasSize
    const cx2 = parseInt(x2) + effCanvasSize
    const cy2 = parseInt(y2) + effCanvasSize
    if ([cx1, cy1, cx2, cy2].some(Number.isNaN)) {
      setStatus({ msg: 'Set valid coordinates first.', type: 'warn' })
      return
    }
    setStatus({ msg: 'Executing rollback...', type: 'info' })
    try {
      const r = await fetch('/admin/watch/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas_id: effCanvasId,
          x1: cx1, y1: cy1, x2: cx2, y2: cy2,
          action: 'rollback',
          timestamp: selectedTs,
        }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.detail || 'Action failed')
      }
      const result = await r.json()
      if (result.async) {
        setStatus({ msg: result.message || 'Large rollback queued.', type: 'ok' })
      } else {
        setStatus({ msg: 'Rollback completed.', type: 'ok' })
      }
      setPreviewOnCanvas(false)
      handleWatch?.()
    } catch (err) {
      setStatus({ msg: `Rollback failed: ${err.message}`, type: 'error' })
    }
  }

  return (
    <div className="global-rollback-preview-panel" style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--btn-border)', borderRadius: 6, padding: 8, marginTop: 4, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#ffcc00' }}>Rollback to snapshot</span>
        {snapshotsLoading && <span style={{ fontSize: 9, color: 'var(--muted)' }}>Loading…</span>}
      </div>

      {availableDays.length === 0 && !snapshotsLoading && (
        <div className="mt-status warn" style={{ fontSize: 10 }}>No snapshots available for this canvas.</div>
      )}

      {availableDays.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>Day (UTC):</span>
            <select className="mt-input" value={selectedDay} onChange={e => setSelectedDay(e.target.value)} style={{ flex: 1, padding: '3px 4px', fontSize: 11 }}>
              {availableDays.map(d => (
                <option key={d} value={d}>{formatDay(d)}</option>
              ))}
            </select>
          </div>

          {availableHours.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>Time:</span>
              <select className="mt-input" value={selectedTs ?? ''} onChange={e => onSelectHour(Number(e.target.value))} style={{ flex: 1, padding: '3px 4px', fontSize: 11 }}>
                {availableHours.map(snap => (
                  <option key={snap.ts} value={snap.ts}>{formatHour(snap)}</option>
                ))}
              </select>
            </div>
          )}

          {availableHours.length === 0 && !snapshotsLoading && (
            <div className="mt-status warn" style={{ fontSize: 10 }}>No snapshots for this day.</div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <div style={{ textAlign: 'center', flexShrink: 0 }}>
              <canvas ref={globalPreviewCanvasRef} width="100" height="100" style={{ display: 'block', border: '1px solid rgba(255,255,255,0.2)', background: '#000', borderRadius: 4 }} />
              <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', display: 'block', marginTop: 2 }}>Snapshot</span>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {selectedSnap && (
                <div style={{ fontSize: 10, color: 'var(--muted)', background: 'rgba(255,204,0,0.08)', border: '1px solid rgba(255,204,0,0.2)', borderRadius: 4, padding: '3px 6px' }}>
                  Selected: <strong style={{ color: '#ffcc00' }}>{formatDay(selectedDay)} {formatHour(selectedSnap)}</strong>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                <label className="live-toggle" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 10 }}>
                  <input type="checkbox" checked={previewOnCanvas} onChange={e => setPreviewOnCanvas(e.target.checked)} />
                  Preview on canvas
                </label>
                {showConfirm && (
                  <button type="button" className="mt-btn primary" disabled={selectedTs == null} onClick={runRollback} style={{ padding: '2px 8px', minHeight: 20, fontSize: 10 }}>
                    {confirmLabel}
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Watch Zone tab ────────────────────────────────────────────────────────────

function WatchTab({ canvasRef, canvasSize, canvasId, configs }) {
  const [activeCanvasId, setActiveCanvasId] = useState(canvasId)

  useEffect(() => {
    setActiveCanvasId(canvasId)
  }, [canvasId])

  const activeCanvasSize = useMemo(() => {
    const cfg = configs[activeCanvasId]
    return cfg ? (cfg.size * 256) / 2 : canvasSize
  }, [configs, activeCanvasId, canvasSize])

  const canvasIndent = configs?.[activeCanvasId]?.indent

  const [x1, setX1] = useState('')
  const [y1, setY1] = useState('')
  const [x2, setX2] = useState('')
  const [y2, setY2] = useState('')
  const [p1Str, setP1Str] = useState('')
  const [p2Str, setP2Str] = useState('')

  useEffect(() => {
    if (x1 !== '' && y1 !== '') {
      setP1Str(`${x1}_${y1}`)
    } else if (x1 === '' && y1 === '') {
      setP1Str('')
    }
  }, [x1, y1])

  useEffect(() => {
    if (x2 !== '' && y2 !== '') {
      setP2Str(`${x2}_${y2}`)
    } else if (x2 === '' && y2 === '') {
      setP2Str('')
    }
  }, [x2, y2])
  const [hours, setHours] = useState('24')
  const [customHours, setCustomHours] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState({ msg: '', type: '' })

  const [placements, setPlacements] = useState([])
  const [proxyUserIds, setProxyUserIds] = useState(new Set())
  const [isLive, setIsLive] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [inspecting, setInspecting] = useState(null)
  const [visualizingUser, setVisualizingUser] = useState(null)

  // Sorting states
  const [sortBy, setSortBy] = useState('pixels') // 'pixels' | 'name' | 'country'
  const [sortDir, setSortDir] = useState('desc') // 'asc' | 'desc'

  // Custom surveillance states
  const [visualize, setVisualize] = useState(false)
  const [expandedUsers, setExpandedUsers] = useState({})
  const [hoveredPixel, setHoveredPixel] = useState(null)
  const [hoveredGroup, setHoveredGroup] = useState(null)
  const [hoveredCoordPlacements, setHoveredCoordPlacements] = useState([])
  const [tooltipState, setTooltipState] = useState({ show: false, x: 0, y: 0 })
  const [activeSubmenu, setActiveSubmenu] = useState(null) // 'replace_all' | 'replace_specific' | 'rollback' | null

  // Snapshot rollback (UTC unix ts from history API)
  const [selectedTs, setSelectedTs] = useState(null)
  const [previewOnCanvas, setPreviewOnCanvas] = useState(false)
  const [availableDays, setAvailableDays] = useState([])
  const [selectedDay, setSelectedDay] = useState('')
  const [availableHours, setAvailableHours] = useState([])
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)

  const isOverTooltipRef = useRef(false)
  const hideTimeoutRef = useRef(null)
  const sseRef = useRef(null)
  const miniPreviewCanvasRef = useRef(null)
  const globalPreviewCanvasRef = useRef(null)

  // Resolve the active palette colours up front — used by useEffect hooks below
  const colors = configs[activeCanvasId]?.colors || []

  function getCssColor(c) {
    if (!c) return '#ffffff'
    if (Array.isArray(c)) {
      return `rgb(${c[0]},${c[1]},${c[2]})`
    }
    return c
  }

  const activeHoursValue = hours === 'custom' ? customHours : hours
  const parsedHours = parseFloat(activeHoursValue)
  const hoursForQuery = isNaN(parsedHours) || parsedHours <= 0 ? 24 : parsedHours

  useEffect(() => {
    return () => {
      canvasRef.current?.stopWatchSelect()
      canvasRef.current?.setWatchVisualization(null)
      canvasRef.current?.clearHistoryMode()
      canvasRef.current?.scheduleUpdate()
      if (sseRef.current) {
        sseRef.current.close()
      }
    }
  }, [canvasRef])

  // Preview on canvas — activate history mode overlay when toggle is on
  useEffect(() => {
    if (previewOnCanvas && selectedTs != null) {
      canvasRef.current?.setHistoryMode(selectedTs)
    } else {
      canvasRef.current?.clearHistoryMode()
    }
    return () => {
      canvasRef.current?.clearHistoryMode()
    }
  }, [previewOnCanvas, selectedTs, canvasRef])

  useEffect(() => {
    if (!isLive) {
      if (sseRef.current) {
        sseRef.current.close()
        sseRef.current = null
      }
      return
    }

    const cx1 = parseInt(x1) + (activeCanvasSize || 0)
    const cy1 = parseInt(y1) + (activeCanvasSize || 0)
    const cx2 = parseInt(x2) + (activeCanvasSize || 0)
    const cy2 = parseInt(y2) + (activeCanvasSize || 0)

    if (isNaN(cx1) || isNaN(cy1) || isNaN(cx2) || isNaN(cy2)) {
      setStatus({ msg: 'Cannot start live mode: coordinates not set.', type: 'warn' })
      setIsLive(false)
      return
    }

    const url = `/admin/watch/stream?canvas_id=${activeCanvasId || 0}&x1=${cx1}&y1=${cy1}&x2=${cx2}&y2=${cy2}`
    const sse = new EventSource(url)
    sseRef.current = sse

    sse.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data)
        if (data.type === 'connected') return

        const newPlacement = {
          id: Date.now() + Math.random(),
          user_id: data.user_id,
          username: data.username,
          avatar: data.avatar,
          discord_id: data.discord_id,
          role: data.role,
          x: data.x,
          y: data.y,
          color: data.color,
          placed_at: data.placed_at,
          ip: data.ip,
          country: data.country || '?',
          is_online: true
        }

        setPlacements(prev => {
          const next = [newPlacement, ...prev]
          if (next.length > 100000) next.length = 100000
          return next
        })
      } catch (err) {
        console.error('SSE Watch error parsing message:', err)
      }
    }

    sse.onerror = (err) => {
      console.error('SSE connection lost or error:', err)
      setStatus({ msg: 'Live connection lost. Reconnecting...', type: 'warn' })
    }

    return () => {
      sse.close()
      sseRef.current = null
    }
  }, [isLive, x1, y1, x2, y2, activeCanvasId, activeCanvasSize])

  function handlePick() {
    setSelecting(true)
    setStatus({ msg: 'Drag a selection on the canvas...', type: 'info' })
    canvasRef.current?.startWatchSelect((coords) => {
      setSelecting(false)
      const hudX1 = Math.floor(coords.x1 - (canvasSize || 0))
      const hudY1 = Math.floor(coords.y1 - (canvasSize || 0))
      const hudX2 = Math.floor(coords.x2 - (canvasSize || 0))
      const hudY2 = Math.floor(coords.y2 - (canvasSize || 0))
      setX1(String(hudX1))
      setY1(String(hudY1))
      setX2(String(hudX2))
      setY2(String(hudY2))
      setStatus({ msg: `Selected area: ${hudX1}_${hudY1} to ${hudX2}_${hudY2}`, type: 'ok' })
    })
  }

  async function handleWatch(e) {
    if (e) e.preventDefault()
    const cx1 = parseInt(x1) + (activeCanvasSize || 0)
    const cy1 = parseInt(y1) + (activeCanvasSize || 0)
    const cx2 = parseInt(x2) + (activeCanvasSize || 0)
    const cy2 = parseInt(y2) + (activeCanvasSize || 0)

    if (isNaN(cx1) || isNaN(cy1) || isNaN(cx2) || isNaN(cy2)) {
      setStatus({ msg: 'Please set valid coordinates.', type: 'warn' })
      return
    }

    setLoading(true)
    setStatus({ msg: 'Fetching data...', type: 'info' })
    try {
      const queryParams = new URLSearchParams({
        canvas_id: activeCanvasId || 0,
        x1: cx1,
        y1: cy1,
        x2: cx2,
        y2: cy2,
        hours: hoursForQuery.toString()
      })
      const r = await fetch(`/admin/watch?${queryParams}`)
      if (!r.ok) throw new Error('Query failed')
      const res = await r.json()
      setPlacements(res.placements)
      // Build a set of user IDs that are currently using a proxy
      const pids = new Set(
        (res.summary?.top_users || []).filter(u => u.is_proxy).map(u => u.user_id)
      )
      setProxyUserIds(pids)
      setStatus({ msg: `Loaded ${res.placements.length} placements.`, type: 'ok' })
    } catch (err) {
      setStatus({ msg: 'Failed to retrieve watch zone data.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  async function handleBan(userId, username) {
    const reason = prompt(`Ban Reason for ${username}:`, 'Rules violation')
    if (reason === null) return
    const durStr = prompt('Duration in hours (0 for perm):', '24')
    if (durStr === null) return
    const duration = parseInt(durStr) * 3600
    if (isNaN(duration)) return

    const r = await fetch(`/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ banned: true, reason, duration }),
    })
    if (r.ok) {
      alert(`Banned ${username} successfully!`)
      setPlacements(prev => prev.map(p => p.user_id === userId ? { ...p, banned: true } : p))
    }
  }

  // Derive unique user groups
  const userGroups = useMemo(() => {
    const groups = {}
    placements.forEach(p => {
      const key = p.user_id || `anon-${p.ip}`
      if (!groups[key]) {
        groups[key] = {
          key,
          user_id: p.user_id,
          username: p.username || `User ${p.user_id || 'Anon'}`,
          avatar: p.avatar,
          discord_id: p.discord_id,
          role: p.role,
          ip: p.ip,
          country: p.country || '?',
          placements: [],
          color: null,
          minX: p.x, maxX: p.x,
          minY: p.y, maxY: p.y,
          colorsUsed: new Set(),
          is_online: p.is_online
        }
      }
      groups[key].placements.push(p)
      groups[key].minX = Math.min(groups[key].minX, p.x)
      groups[key].maxX = Math.max(groups[key].maxX, p.x)
      groups[key].minY = Math.min(groups[key].minY, p.y)
      groups[key].maxY = Math.max(groups[key].maxY, p.y)
      groups[key].colorsUsed.add(p.color)
      if (p.is_online) {
        groups[key].is_online = true
      }
    })

    const sortedKeys = Object.keys(groups).sort()
    sortedKeys.forEach((key, idx) => {
      const hue = (idx * 137.5) % 360
      groups[key].color = `hsl(${hue}, 90%, 55%)`
    })

    return groups
  }, [placements])

  // Sorted user groups based on current sort settings
  const sortedUserGroups = useMemo(() => {
    const groupsArray = Object.values(userGroups)
    
    return groupsArray.sort((a, b) => {
      let comparison = 0
      
      if (sortBy === 'pixels') {
        comparison = a.placements.length - b.placements.length
      } else if (sortBy === 'name') {
        comparison = a.username.localeCompare(b.username)
      } else if (sortBy === 'country') {
        comparison = a.country.localeCompare(b.country)
      }
      
      return sortDir === 'asc' ? comparison : -comparison
    })
  }, [userGroups, sortBy, sortDir])

  // Helper to toggle sort
  function handleSort(column) {
    if (sortBy === column) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(column)
      setSortDir(column === 'pixels' ? 'desc' : 'asc') // Default desc for pixels, asc for name/country
    }
  }

  const userColorsMap = useMemo(() => {
    const mapping = {}
    Object.values(userGroups).forEach(g => {
      mapping[g.key] = g.color
    })
    return mapping
  }, [userGroups])

  // Synchronize visualization layer to canvas renderer
  useEffect(() => {
    if (visualize && placements.length > 0) {
      canvasRef.current?.setWatchVisualization({
        placements,
        userColors: userColorsMap
      })
      canvasRef.current?.scheduleUpdate()
    } else {
      canvasRef.current?.setWatchVisualization(null)
      canvasRef.current?.scheduleUpdate()
    }
  }, [visualize, placements, userColorsMap, canvasRef])

  // Canvas mousemove / hover tracking logic for visualizer tooltips
  useEffect(() => {
    const canvasEl = canvasRef.current?.el
    if (!canvasEl) return

    function handleMouseMove(e) {
      if (!visualize || placements.length === 0) {
        setTooltipState(prev => prev.show ? { ...prev, show: false } : prev)
        return
      }

      const world = canvasRef.current?.screenToWorld(e.clientX, e.clientY)
      if (!world) return

      // Find all placements at this coordinate
      const matched = placements.filter(p => p.x === world.x && p.y === world.y)

      if (matched.length > 0) {
        if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current)
          hideTimeoutRef.current = null
        }

        // Default to the first (newest) placement
        const defaultMatched = matched[0]
        const groupKey = defaultMatched.user_id || `anon-${defaultMatched.ip}`
        const group = userGroups[groupKey]

        setHoveredCoordPlacements(matched)
        setHoveredPixel(defaultMatched)
        setHoveredGroup(group)
        setTooltipState({
          show: true,
          x: e.clientX + 10,
          y: e.clientY + 10
        })
      } else {
        if (!hideTimeoutRef.current) {
          hideTimeoutRef.current = setTimeout(() => {
            if (!isOverTooltipRef.current) {
              setTooltipState(prev => ({ ...prev, show: false }))
            }
          }, 300)
        }
      }
    }

    canvasEl.addEventListener('mousemove', handleMouseMove)
    return () => {
      canvasEl.removeEventListener('mousemove', handleMouseMove)
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
    }
  }, [visualize, placements, userGroups, canvasRef])

  useEffect(() => {
    if (placements.length > 0 && selectedTs == null) {
      setSelectedTs(Math.floor(Date.now() / 1000) - hoursForQuery * 3600)
    }
  }, [placements.length, hoursForQuery])

  useEffect(() => {
    const miniCanvas = globalPreviewCanvasRef.current
    if (!miniCanvas || placements.length === 0 || selectedTs == null) return

    let active = true
    const ctx = miniCanvas.getContext('2d')
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 100, 100)

    const ts = selectedTs

    // Find boundary of placements to size the viewport nicely
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    placements.forEach(p => {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    })

    const w = maxX - minX + 1
    const h = maxY - minY + 1
    const pixelSize = Math.max(1, Math.min(12, Math.floor(100 / Math.max(w, h))))
    const padX = (100 - w * pixelSize) / 2
    const padY = (100 - h * pixelSize) / 2

    async function drawGlobalPreview() {
      const chunkCache = new Map()

      // Get unique coordinates of placements to draw
      const coords = new Map()
      placements.forEach(p => {
        coords.set(`${p.x},${p.y}`, { x: p.x, y: p.y })
      })
      const uniquePlacements = Array.from(coords.values())

      for (const p of uniquePlacements) {
        const cx = Math.floor(p.x / 256)
        const cy = Math.floor(p.y / 256)
        const chunkKey = `${cx}|${cy}`

        let rawChunk = chunkCache.get(chunkKey)
        if (rawChunk === undefined) {
          try {
            rawChunk = await fetchHistoryChunk(activeCanvasId, ts, cx, cy, configs[activeCanvasId]?.colors || [])
            if (rawChunk) {
              chunkCache.set(chunkKey, rawChunk.raw ?? rawChunk)
            }
          } catch (err) {
            console.error('Failed to fetch global preview history chunk:', err)
            rawChunk = null
          }
        }

        if (!active) return

        const colorIdx = rawChunk ? rawChunk[(p.y - cy * 256) * 256 + (p.x - cx * 256)] : 0
        const c = colors[colorIdx]
        ctx.fillStyle = getCssColor(c)
        ctx.fillRect(padX + (p.x - minX) * pixelSize, padY + (p.y - minY) * pixelSize, pixelSize, pixelSize)
        ctx.strokeStyle = 'rgba(255,255,255,0.1)'
        ctx.lineWidth = 0.5
        ctx.strokeRect(padX + (p.x - minX) * pixelSize, padY + (p.y - minY) * pixelSize, pixelSize, pixelSize)
      }
    }

    drawGlobalPreview()

    return () => {
      active = false
    }
  }, [placements, selectedTs, activeCanvasId, configs, colors])

  useEffect(() => {
    const miniCanvas = miniPreviewCanvasRef.current
    if (!miniCanvas || !hoveredGroup || selectedTs == null || activeSubmenu !== 'rollback') return

    let active = true
    const ctx = miniCanvas.getContext('2d')
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 120, 120)

    const ts = selectedTs

    async function drawMiniPreview() {
      const w = hoveredGroup.maxX - hoveredGroup.minX + 1
      const h = hoveredGroup.maxY - hoveredGroup.minY + 1
      const pixelSize = Math.max(1, Math.min(16, Math.floor(120 / Math.max(w, h))))
      const padX = (120 - w * pixelSize) / 2
      const padY = (120 - h * pixelSize) / 2

      const chunkCache = new Map()

      for (const p of hoveredGroup.placements) {
        const cx = Math.floor(p.x / 256)
        const cy = Math.floor(p.y / 256)
        const chunkKey = `${cx}|${cy}`

        let rawChunk = chunkCache.get(chunkKey)
        if (rawChunk === undefined) {
          try {
            rawChunk = await fetchHistoryChunk(activeCanvasId, ts, cx, cy, configs[activeCanvasId]?.colors || [])
            if (rawChunk) {
              chunkCache.set(chunkKey, rawChunk.raw ?? rawChunk)
            }
          } catch (err) {
            console.error('Failed to fetch mini preview history chunk:', err)
            rawChunk = null
          }
        }

        if (!active) return

        const colorIdx = rawChunk ? rawChunk[(p.y - cy * 256) * 256 + (p.x - cx * 256)] : 0
        const c = colors[colorIdx]
        ctx.fillStyle = getCssColor(c)
        ctx.fillRect(padX + (p.x - hoveredGroup.minX) * pixelSize, padY + (p.y - hoveredGroup.minY) * pixelSize, pixelSize, pixelSize)
        ctx.strokeStyle = 'rgba(255,255,255,0.1)'
        ctx.lineWidth = 0.5
        ctx.strokeRect(padX + (p.x - hoveredGroup.minX) * pixelSize, padY + (p.y - hoveredGroup.minY) * pixelSize, pixelSize, pixelSize)
      }
    }

    drawMiniPreview()

    return () => {
      active = false
    }
  }, [hoveredGroup, selectedTs, activeSubmenu, activeCanvasId, configs, colors])

  function handleTooltipMouseEnter() {
    isOverTooltipRef.current = true
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
  }

  function handleTooltipMouseLeave() {
    isOverTooltipRef.current = false
    hideTimeoutRef.current = setTimeout(() => {
      setTooltipState(prev => ({ ...prev, show: false }))
    }, 300)
  }

  async function performWatchAction(actionType, extraParams = {}) {
    if (!hoveredGroup) return
    const { minX, maxX, minY, maxY } = hoveredGroup

    const payload = {
      canvas_id: canvasId || 0,
      x1: minX,
      y1: minY,
      x2: maxX,
      y2: maxY,
      action: actionType,
      ...extraParams
    }

    setStatus({ msg: `Executing administrative ${actionType} action...`, type: 'info' })
    try {
      const r = await fetch('/admin/watch/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!r.ok) {
        const errorText = await r.text()
        throw new Error(errorText || 'Action failed')
      }

      const result = await r.json()
      
      if (result.async) {
        // Large operation processing in background
        setStatus({ msg: result.message || 'Large operation queued for background processing.', type: 'ok' })
      } else {
        // Synchronous operation completed
        setStatus({ msg: `Action '${actionType}' completed! ${result.count || 0} pixels changed.`, type: 'ok' })
      }
      
      setTooltipState(prev => ({ ...prev, show: false }))
      setActiveSubmenu(null)

      // Refresh watch list to fetch new states
      handleWatch()
    } catch (err) {
      console.error(err)
      setStatus({ msg: `Failed to execute action: ${err.message}`, type: 'error' })
    }
  }

  function handleColorSelect(targetColorIdx) {
    if (!hoveredPixel) return
    if (activeSubmenu === 'replace_all') {
      performWatchAction('replace_all', { target_color: targetColorIdx })
    } else if (activeSubmenu === 'replace_specific') {
      performWatchAction('replace_specific', {
        source_color: hoveredPixel.color,
        target_color: targetColorIdx
      })
    }
  }


  // Derived metrics
  const total = placements.length
  const uniqueUsers = Object.keys(userGroups).length
  const topUsers = Object.values(userGroups)
    .map(g => ({
      user_id: g.user_id,
      username: g.username,
      count: g.placements.length,
      is_proxy: proxyUserIds.has(g.user_id),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  return (
    <div className="mt-tabcontent watch-tab">
      <span className="mt-label">🔍 WatchZone Surveillance</span>

      <div className="watch-controls">
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>Canvas:</label>
          <select
            className="mt-input"
            value={activeCanvasId}
            onChange={e => setActiveCanvasId(Number(e.target.value))}
            style={{ flex: 1, padding: '4px 6px', fontSize: 11 }}
          >
            {Object.keys(configs).map(id => (
              <option key={id} value={id}>
                {configs[id]?.name || `Canvas ${id}`}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button
            type="button"
            className={`mt-btn secondary ${selecting ? 'active' : ''}`}
            onClick={handlePick}
            style={{ flex: 1 }}
          >
            📐 {selecting ? 'Selecting...' : 'Select on Canvas'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <label className="live-toggle" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={visualize}
                onChange={e => setVisualize(e.target.checked)}
              />
              📺 Visualize
            </label>
            <label className="live-toggle" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12, marginLeft: 8 }}>
              <input
                type="checkbox"
                checked={isLive}
                onChange={e => setIsLive(e.target.checked)}
              />
              <span className={`live-dot ${isLive ? 'active' : ''}`} /> Live Stream
            </label>
          </div>
        </div>

        <form onSubmit={handleWatch} className="watch-coords-form">
          <CoordsPairInputs
            p1Str={p1Str}
            p2Str={p2Str}
            setP1Str={setP1Str}
            setP2Str={setP2Str}
            setX1={setX1}
            setY1={setY1}
            setX2={setX2}
            setY2={setY2}
            canvasIndent={canvasIndent}
            gap={6}
            inputStyle={{ padding: 4 }}
            sublabelClassName="input-sublabel"
          />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <select className="mt-input" value={hours} onChange={e => setHours(e.target.value)} style={{ flex: 1, padding: 4 }}>
                <option value="1">Last 1 Hour</option>
                <option value="6">Last 6 Hours</option>
                <option value="24">Last 24 Hours</option>
                <option value="168">Last 7 Days</option>
                <option value="720">Last 30 Days</option>
                <option value="custom">Custom Duration...</option>
              </select>
              <button type="submit" className="mt-btn primary" disabled={loading} style={{ minWidth: 80, height: 28, padding: '4px 10px' }}>
                Query
              </button>
            </div>

            {hours === 'custom' && (
              <div className="watch-custom-hours-wrap">
                <span className="input-sublabel" style={{ fontSize: 10, display: 'block', color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
                  Enter custom duration in hours (e.g. 1.5):
                </span>
                <input
                  type="number"
                  step="any"
                  min="0.001"
                  className="mt-input"
                  value={customHours}
                  onChange={e => setCustomHours(e.target.value)}
                  placeholder="Decimal hours (e.g. 1.5)"
                  style={{ width: '100%', padding: 4 }}
                />
              </div>
            )}
          </div>
        </form>
      </div>

      {status.msg && (
        <div className={`mt-status ${status.type}`} style={{ marginTop: 6, marginBottom: 6 }}>
          {status.msg}
        </div>
      )}

      {total > 0 && (() => {
        // Fetch available snapshot days when results first appear
        // (declared inline so the effects can reference canvasId)
        return (
          <SnapshotRollbackPanel
            canvasId={activeCanvasId}
            globalPreviewCanvasRef={globalPreviewCanvasRef}
            selectedTs={selectedTs}
            setSelectedTs={setSelectedTs}
            previewOnCanvas={previewOnCanvas}
            setPreviewOnCanvas={setPreviewOnCanvas}
            availableDays={availableDays}
            setAvailableDays={setAvailableDays}
            selectedDay={selectedDay}
            setSelectedDay={setSelectedDay}
            availableHours={availableHours}
            setAvailableHours={setAvailableHours}
            snapshotsLoading={snapshotsLoading}
            setSnapshotsLoading={setSnapshotsLoading}
            x1={x1} y1={y1} x2={x2} y2={y2}
            canvasSize={activeCanvasSize}
            activeCanvasId={activeCanvasId}
            activeCanvasSize={activeCanvasSize}
            setStatus={setStatus}
            handleWatch={handleWatch}
            total={total}
          />
        )
      })()}

      {total > 0 && (
        <div className="watch-summary-cards" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8, marginBottom: 8 }}>
          <div className="watch-card" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--btn-border)', borderRadius: 6, padding: '6px 10px' }}>
            <span className="card-val" style={{ display: 'block', fontSize: 16, fontWeight: 600, color: '#fff' }}>{total}</span>
            <span className="card-lbl" style={{ display: 'block', fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase' }}>Total Pixels</span>
          </div>
          <div className="watch-card" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--btn-border)', borderRadius: 6, padding: '6px 10px' }}>
            <span className="card-val" style={{ display: 'block', fontSize: 16, fontWeight: 600, color: '#3ecf6e' }}>{uniqueUsers}</span>
            <span className="card-lbl" style={{ display: 'block', fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase' }}>Unique Users</span>
          </div>
          <div className="watch-card top-users-card" style={{ gridColumn: '1 / -1', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--btn-border)', borderRadius: 6, padding: '8px 10px' }}>
            <span className="card-lbl" style={{ display: 'block', fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>Top Users</span>
            <div className="top-users-list" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {topUsers.map(u => (
                <div key={u.user_id || u.username} className="top-user-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4, fontSize: 11 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span className="top-username" style={{ color: '#60c0ff', cursor: 'pointer' }} onClick={() => u.user_id && setInspecting(u.user_id)}>
                      {u.username}
                    </span>
                    {u.is_proxy && <span className="banned-tag" style={{ fontSize: 8, padding: '0 3px', background: 'rgba(255,170,0,0.18)', color: '#ffaa00', borderColor: '#ffaa00' }}>PROXY</span>}
                  </span>
                  <span className="top-count" style={{ color: 'rgba(255,255,255,0.6)' }}>{u.count} px</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="watch-table-container" style={{ maxHeight: 350, overflowY: 'auto', overflowX: 'auto', border: '1px solid var(--btn-border)', borderRadius: 6, marginTop: 8 }}>
        <table className="watch-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.06)', borderBottom: '1px solid var(--btn-border)', textAlign: 'left' }}>
              <th style={{ width: 30, padding: '4px 6px' }}></th>
              <th 
                style={{ padding: '4px 6px', cursor: 'pointer', userSelect: 'none' }} 
                onClick={() => handleSort('name')}
                title="Click to sort by name"
              >
                User/IP {sortBy === 'name' && (sortDir === 'asc' ? '▲' : '▼')}
              </th>
              <th 
                style={{ padding: '4px 6px', cursor: 'pointer', userSelect: 'none' }} 
                onClick={() => handleSort('pixels')}
                title="Click to sort by pixel count"
              >
                Count {sortBy === 'pixels' && (sortDir === 'asc' ? '▲' : '▼')}
              </th>
              <th 
                style={{ padding: '4px 6px', cursor: 'pointer', userSelect: 'none' }} 
                onClick={() => handleSort('country')}
                title="Click to sort by country"
              >
                Country {sortBy === 'country' && (sortDir === 'asc' ? '▲' : '▼')}
              </th>
              <th style={{ padding: '4px 6px' }}>Bounding Box</th>
              <th style={{ padding: '4px 6px' }}>Colors</th>
              <th style={{ padding: '4px 6px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedUserGroups.map(g => {
              const av = getAvatarUrl(g, 24)
              const roleBadge = getRoleBadge(g.role)
              const isExpanded = !!expandedUsers[g.key]

              const hudMinX = Math.floor(g.minX - (canvasSize || 0))
              const hudMinY = Math.floor(g.minY - (canvasSize || 0))
              const hudMaxX = Math.floor(g.maxX - (canvasSize || 0))
              const hudMaxY = Math.floor(g.maxY - (canvasSize || 0))

              return (
                <Fragment key={g.key}>
                  <tr className="watch-row watch-group-summary-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                      <button
                        type="button"
                        className={`watch-expand-btn ${isExpanded ? 'expanded' : ''}`}
                        onClick={() => setExpandedUsers(prev => ({ ...prev, [g.key]: !prev[g.key] }))}
                      >
                        ▶
                      </button>
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            backgroundColor: g.color
                          }}
                          title="User Color Code"
                        />
                        <img src={av} className="urow-avatar" style={{ width: 14, height: 14, borderRadius: '50%' }} alt="" />
                        <span 
                          className="urow-name" 
                          style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: '#ffffff', cursor: 'pointer' }} 
                          title={`${g.username} (click to copy)`}
                          onClick={() => copyCoord(g.username)}
                        >
                          {g.username}
                        </span>
                        <CopyBtn text={g.username} title="Copy Username" />
                        {g.user_id && (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            <span 
                              style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontFamily: 'monospace' }}
                              title={`ID: ${g.user_id} (click to copy)`}
                              onClick={() => copyCoord(String(g.user_id))}
                            >
                              #{g.user_id}
                            </span>
                            <CopyBtn text={String(g.user_id)} title="Copy User ID" />
                          </div>
                        )}
                        {g.ip && (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            <span className="urow-stat" style={{ fontSize: 9, fontFamily: 'monospace' }}>{g.ip}</span>
                            <CopyBtn text={g.ip} title="Copy IP / IID" />
                          </div>
                        )}
                        {roleBadge.label !== 'User' && (
                          <span className={`role-badge ${roleBadge.colorClass}`} style={{ fontSize: 7, padding: '0px 3px', lineHeight: 1.2 }}>
                            {roleBadge.label}
                          </span>
                        )}
                        {g.is_online && <span className="online-dot" style={{ width: 5, height: 5 }} />}
                        {proxyUserIds.has(g.user_id) && (
                          <span className="banned-tag" style={{ fontSize: 7, padding: '0 3px', background: 'rgba(255,170,0,0.18)', color: '#ffaa00', borderColor: '#ffaa00' }}>PROXY</span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '4px 6px', fontWeight: 600, color: '#3ecf6e' }}>
                      {g.placements.length} px
                    </td>
                    <td 
                      style={{ padding: '4px 6px', fontSize: 10, cursor: 'pointer' }}
                      title={`${g.country} (click to copy)`}
                      onClick={() => copyCoord(g.country)}
                    >
                      <span>{g.country}</span>
                      {g.country && <CopyBtn text={g.country} title="Copy Country" style={{ marginLeft: 3 }} />}
                    </td>
                    <td style={{ padding: '4px 6px', fontFamily: 'monospace', fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
                      ({hudMinX}, {hudMinY}) to ({hudMaxX}, {hudMaxY})
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                        {Array.from(g.colorsUsed).map(cIdx => (
                          <div
                            key={cIdx}
                            className="watch-color-mini-swatch"
                            style={{ backgroundColor: getCssColor(colors[cIdx]) }}
                            title={`Color ${cIdx}`}
                          />
                        ))}
                      </div>
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button className="mt-btn secondary icon-btn" title="Inspect User" onClick={() => setInspecting(g.user_id)} style={{ padding: '2px 4px', minHeight: 20 }}>
                          🔍
                        </button>
                        <button
                          className="mt-btn secondary icon-btn"
                          title="🎬 Visualize Sequence"
                          onClick={() => setVisualizingUser(g)}
                          style={{ padding: '2px 4px', minHeight: 20, color: '#00ffcc' }}
                        >
                          🎬
                        </button>
                        <button
                          className="mt-btn secondary icon-btn"
                          title="⏪ Rollback Pixels by Count"
                          onClick={() => handleRollbackPixelCount({
                            userId: g.user_id,
                            ip: g.ip,
                            canvasId: activeCanvasId,
                            defaultCount: g.placements.length,
                            onComplete: handleWatch
                          })}
                          style={{ padding: '2px 4px', minHeight: 20 }}
                        >
                          ⏪
                        </button>
                        <button className="mt-btn secondary icon-btn" title="Jump to Group Start" onClick={() => canvasRef.current?.navigateTo(g.placements[0].x, g.placements[0].y)} style={{ padding: '2px 4px', minHeight: 20 }}>
                          🎯
                        </button>
                        {g.user_id && (
                          <button className="mt-btn danger icon-btn" title="Ban User" onClick={() => handleBan(g.user_id, g.username)} style={{ padding: '2px 4px', minHeight: 20 }}>
                            ⛔
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>


                  {isExpanded && g.placements.slice(0, 200).map(p => {
                    const colorHex = getCssColor(colors[p.color])
                    const timeStr = new Date(p.placed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
                    const fullTimeStr = new Date(p.placed_at).toLocaleString()
                    const hudX = Math.floor(p.x - (canvasSize || 0))
                    const hudY = Math.floor(p.y - (canvasSize || 0))

                    return (
                      <tr key={p.id} className="watch-row watch-nested-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <td style={{ padding: '4px 6px' }}></td>
                        <td style={{ padding: '4px 6px 4px 20px', color: 'rgba(255,255,255,0.5)' }}>
                          ↳ placement
                        </td>
                        <td style={{ padding: '4px 6px', fontFamily: 'monospace', fontSize: 10 }}>
                          coordinate: <strong>{hudX}_{hudY}</strong>
                        </td>
                        <td style={{ padding: '4px 6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            <div className="watch-color-swatch" style={{ width: 10, height: 10, borderRadius: 2, border: '1px solid rgba(255,255,255,0.2)', backgroundColor: colorHex }} />
                            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>Color {p.color}</span>
                          </div>
                        </td>
                        <td title={fullTimeStr} style={{ padding: '4px 6px', fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
                          {timeStr}
                        </td>
                        <td style={{ padding: '4px 6px' }}>
                          <button className="mt-btn secondary icon-btn" title="Jump to Pixel" onClick={() => canvasRef.current?.navigateTo(p.x, p.y)} style={{ padding: '2px 4px', minHeight: 20 }}>
                            🎯
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  {isExpanded && g.placements.length > 200 && (
                    <tr className="watch-row watch-nested-row">
                      <td></td>
                      <td colSpan="5" style={{ padding: '6px 20px', color: 'var(--muted)', fontStyle: 'italic' }}>
                        ➕ ...and {g.placements.length - 200} more placements (truncated in list for performance)
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {placements.length === 0 && (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', padding: '20px 0' }}>
                  No placements found in this zone/timeframe.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {inspecting && <UserInspector userId={inspecting} onClose={() => setInspecting(null)} />}

      {tooltipState.show && hoveredPixel && hoveredGroup && createPortal(
        <div
          className="watch-hover-tooltip"
          style={{ left: tooltipState.x, top: tooltipState.y }}
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
        >
          {hoveredCoordPlacements.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', fontWeight: 600 }}>
                👥 Overlapping Placements ({hoveredCoordPlacements.length})
              </span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                {hoveredCoordPlacements.map((p, idx) => {
                  const gKey = p.user_id || `anon-${p.ip}`
                  const g = userGroups[gKey]
                  if (!g) return null
                  const isActive = hoveredPixel.id === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`mt-btn ${isActive ? 'primary' : 'secondary'}`}
                      style={{
                        padding: '2px 6px',
                        fontSize: 9,
                        minHeight: 18,
                        height: 18,
                        borderRadius: 3,
                        borderColor: g.color,
                        borderWidth: isActive ? 1.5 : 1,
                        whiteSpace: 'nowrap'
                      }}
                      onClick={() => {
                        setHoveredPixel(p)
                        setHoveredGroup(g)
                        setActiveSubmenu(null)
                      }}
                    >
                      {g.username} {idx === 0 ? '🆕' : ''}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="tooltip-header">
            <span className="tooltip-user-badge" style={{ borderLeft: `4px solid ${hoveredGroup.color}`, paddingLeft: 6 }}>
              {hoveredGroup.username}
            </span>
            <span className="role-badge" style={{ fontSize: 9 }}>
              {getRoleBadge(hoveredGroup.role).label}
            </span>
          </div>

          <div className="tooltip-stats">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>📍 Coordinate: <strong>HUD {Math.floor(hoveredPixel.x - (canvasSize || 0))}_{Math.floor(hoveredPixel.y - (canvasSize || 0))}</strong></span>
              <CopyBtn text={`${Math.floor(hoveredPixel.x - (canvasSize || 0))}_${Math.floor(hoveredPixel.y - (canvasSize || 0))}`} title="Copy HUD Coords" />
            </div>
            <div>🎨 Placed Color: <span className="watch-color-mini-swatch" style={{ backgroundColor: getCssColor(colors[hoveredPixel.color]), verticalAlign: 'middle', display: 'inline-block', marginLeft: 2 }} /> <strong>Index {hoveredPixel.color}</strong></div>
            <div>📊 Placements in Zone: <strong>{hoveredGroup.placements.length} px</strong></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span>🌐 Network: <strong>{hoveredGroup.ip || hoveredPixel.ip || '?'}</strong></span>
              {(hoveredGroup.ip || hoveredPixel.ip) && <CopyBtn text={hoveredGroup.ip || hoveredPixel.ip} title="Copy IP / IID" />}
              {hoveredGroup.cidr && <CopyBtn text={hoveredGroup.cidr} label="CIDR" title="Copy CIDR" />}
              {hoveredGroup.user_id && <CopyBtn text={String(hoveredGroup.user_id)} label="UID" title="Copy User ID" />}
            </div>
          </div>

          <div className="tooltip-actions">
            {!activeSubmenu ? (
              <>
                <button
                  className="mt-btn primary"
                  onClick={() => {
                    setActiveSubmenu('rollback')
                    setPreviewOnCanvas(true)
                  }}
                >
                  ⏪ Rollback all user pixels to snapshot
                </button>
                <button
                  className="mt-btn secondary"
                  style={{ width: '100%', marginTop: 4, fontSize: 10 }}
                  onClick={() => handleRollbackPixelCount({
                    userId: hoveredGroup.user_id,
                    ip: hoveredGroup.ip || hoveredPixel.ip,
                    canvasId: activeCanvasId,
                    defaultCount: hoveredGroup.placements?.length || 50,
                    onComplete: handleWatch
                  })}
                >
                  ⏪ Rollback Specific Number of Pixels
                </button>
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  <button
                    className="mt-btn secondary"
                    style={{ flex: 1 }}
                    onClick={() => setActiveSubmenu('replace_all')}
                  >
                    🎨 Replace All Colors
                  </button>
                  <button
                    className="mt-btn secondary"
                    style={{ flex: 1 }}
                    onClick={() => setActiveSubmenu('replace_specific')}
                  >
                    🎯 Replace Specific
                  </button>
                </div>
              </>
            ) : activeSubmenu === 'rollback' ? (

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 600 }}>⏪ Select Rollback Snapshot:</span>
                  <button
                    className="mt-btn secondary icon-btn"
                    onClick={() => {
                      setActiveSubmenu(null)
                      setPreviewOnCanvas(false)
                    }}
                    style={{ width: 14, height: 14, minHeight: 14 }}
                  >
                    ✕
                  </button>
                </div>

                {/* Mini canvas snapshot preview */}
                <div style={{ textAlign: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', display: 'block', marginBottom: 2 }}>
                    📸 Area Snapshot Preview ({hoveredGroup.placements.length} px)
                  </span>
                  <canvas ref={miniPreviewCanvasRef} width="120" height="120" style={{ display: 'block', margin: '0 auto', border: '1px solid rgba(255,255,255,0.2)', background: '#000', borderRadius: 4 }} />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                    Uses snapshot selected above (UTC). {selectedTs != null ? `ts=${selectedTs}` : 'Pick a day/time in the snapshot panel.'}
                  </div>

                  <label className="live-toggle" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 10, margin: '2px 0' }}>
                    <input
                      type="checkbox"
                      checked={previewOnCanvas}
                      onChange={e => setPreviewOnCanvas(e.target.checked)}
                    />
                    Preview on Canvas
                  </label>

                  <button
                    className="mt-btn primary"
                    disabled={selectedTs == null}
                    onClick={() => performWatchAction('rollback', { timestamp: selectedTs })}
                    style={{ width: '100%', marginTop: 2 }}
                  >
                    Confirm Rollback
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 600 }}>
                    {activeSubmenu === 'replace_all' ? 'Select Target Color:' : `Replace Index ${hoveredPixel.color} with:`}
                  </span>
                  <button
                    className="mt-btn secondary icon-btn"
                    onClick={() => setActiveSubmenu(null)}
                    style={{ width: 14, height: 14, minHeight: 14 }}
                  >
                    ✕
                  </button>
                </div>
                <div className="color-picker-grid">
                  {colors.map((colorArr, idx) => (
                    <div
                      key={idx}
                      className="swatch-btn"
                      style={{ backgroundColor: getCssColor(colorArr) }}
                      title={`Color ${idx}`}
                      onClick={() => handleColorSelect(idx)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {visualizingUser && (
        <PixelTimelineVisualizer
          userId={visualizingUser.user_id}
          username={visualizingUser.username}
          initialCanvasId={activeCanvasId}
          initialPlacements={visualizingUser.placements}
          colors={colors}
          canvasRef={canvasRef}
          configs={configs}
          onClose={() => setVisualizingUser(null)}
        />
      )}
    </div>
  )
}


function ProtectTab({ canvasRef, canvasSize, canvasId, configs }) {
  const [activeCanvasId, setActiveCanvasId] = useState(canvasId)

  useEffect(() => {
    setActiveCanvasId(canvasId)
  }, [canvasId])

  const activeCanvasSize = useMemo(() => {
    const cfg = configs[activeCanvasId]
    return cfg ? (cfg.size * 256) / 2 : canvasSize
  }, [configs, activeCanvasId, canvasSize])

  const canvasIndent = configs?.[activeCanvasId]?.indent

  const [x1, setX1] = useState('')
  const [y1, setY1] = useState('')
  const [x2, setX2] = useState('')
  const [y2, setY2] = useState('')
  const [p1Str, setP1Str] = useState('')
  const [p2Str, setP2Str] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState({ msg: '', type: '' })

  useEffect(() => {
    return () => {
      canvasRef.current?.stopWatchSelect()
    }
  }, [canvasRef])

  useEffect(() => {
    if (x1 !== '' && y1 !== '') {
      setP1Str(`${x1}_${y1}`)
    } else if (x1 === '' && y1 === '') {
      setP1Str('')
    }
  }, [x1, y1])

  useEffect(() => {
    if (x2 !== '' && y2 !== '') {
      setP2Str(`${x2}_${y2}`)
    } else if (x2 === '' && y2 === '') {
      setP2Str('')
    }
  }, [x2, y2])

  function handlePick() {
    setSelecting(true)
    setStatus({ msg: 'Drag an area on canvas...', type: 'info' })
    canvasRef.current?.startWatchSelect((coords) => {
      setSelecting(false)
      const hudX1 = Math.floor(coords.x1 - (canvasSize || 0))
      const hudY1 = Math.floor(coords.y1 - (canvasSize || 0))
      const hudX2 = Math.floor(coords.x2 - (canvasSize || 0))
      const hudY2 = Math.floor(coords.y2 - (canvasSize || 0))
      setX1(String(hudX1))
      setY1(String(hudY1))
      setX2(String(hudX2))
      setY2(String(hudY2))
      setStatus({ msg: `Area selected: ${hudX1}_${hudY1} to ${hudX2}_${hudY2}`, type: 'ok' })
    })
  }

  async function runAction(action) {
    const cx1 = parseInt(x1) + (activeCanvasSize || 0)
    const cy1 = parseInt(y1) + (activeCanvasSize || 0)
    const cx2 = parseInt(x2) + (activeCanvasSize || 0)
    const cy2 = parseInt(y2) + (activeCanvasSize || 0)
    if ([cx1, cy1, cx2, cy2].some(Number.isNaN)) {
      setStatus({ msg: 'Set valid coordinates first.', type: 'warn' })
      return
    }
    setBusy(true)
    setStatus({ msg: action === 'protect_area' ? 'Protecting area...' : 'Unprotecting area...', type: 'info' })
    try {
      const r = await fetch('/admin/watch/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas_id: typeof activeCanvasId === 'number' && activeCanvasId >= 0 ? activeCanvasId : 0,
          x1: cx1,
          y1: cy1,
          x2: cx2,
          y2: cy2,
          action
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.detail || 'Request failed')
      const verb = action === 'protect_area' ? 'Protected' : 'Unprotected'
      setStatus({ msg: `${verb} ${d.count ?? 0} pixels.`, type: 'ok' })
    } catch (err) {
      setStatus({ msg: `Failed: ${err.message}`, type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-tabcontent">
      <span className="mt-label">Protected Pixel Area Controls</span>
      <div style={{ display: 'flex', gap: 6, margin: '8px 0', alignItems: 'center' }}>
        <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>Canvas:</label>
        <select
          className="mt-input"
          value={activeCanvasId}
          onChange={e => setActiveCanvasId(Number(e.target.value))}
          style={{ flex: 1, padding: '4px 6px', fontSize: 11 }}
        >
          {Object.keys(configs).map(id => (
            <option key={id} value={id}>
              {configs[id]?.name || `Canvas ${id}`}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 6, margin: '8px 0' }}>
        <button
          type="button"
          className={`mt-btn secondary ${selecting ? 'active' : ''}`}
          onClick={handlePick}
          disabled={busy}
        >
          {selecting ? 'Selecting...' : 'Select Area on Canvas'}
        </button>
      </div>
      <CoordsPairInputs
        p1Str={p1Str}
        p2Str={p2Str}
        setP1Str={setP1Str}
        setP2Str={setP2Str}
        setX1={setX1}
        setY1={setY1}
        setX2={setX2}
        setY2={setY2}
        canvasIndent={canvasIndent}
        sublabelClassName="input-sublabel"
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="mt-btn primary" disabled={busy} onClick={() => runAction('protect_area')}>
          Protect Area
        </button>
        <button className="mt-btn secondary" disabled={busy} onClick={() => runAction('unprotect_area')}>
          Unprotect Area
        </button>
      </div>
      {status.msg && <div className={`mt-status ${status.type}`} style={{ marginTop: 8 }}>{status.msg}</div>}
    </div>
  )
}

// ── Snapshot Rollback Tool Tab ─────────────────────────────────────────────────────

function SnapshotRollbackTab({ canvasRef, canvasSize, canvasId, configs }) {
  const canvasIndent = configs?.[canvasId]?.indent
  const [x1, setX1] = useState('')
  const [y1, setY1] = useState('')
  const [x2, setX2] = useState('')
  const [y2, setY2] = useState('')
  const [p1Str, setP1Str] = useState('')
  const [p2Str, setP2Str] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [status, setStatus] = useState({ msg: '', type: '' })

  useEffect(() => {
    if (x1 !== '' && y1 !== '') setP1Str(`${x1}_${y1}`)
    else if (x1 === '' && y1 === '') setP1Str('')
  }, [x1, y1])

  useEffect(() => {
    if (x2 !== '' && y2 !== '') setP2Str(`${x2}_${y2}`)
    else if (x2 === '' && y2 === '') setP2Str('')
  }, [x2, y2])

  const [selectedTs, setSelectedTs] = useState(null)
  const [previewOnCanvas, setPreviewOnCanvas] = useState(false)
  const [availableDays, setAvailableDays] = useState([])
  const [selectedDay, setSelectedDay] = useState('')
  const [availableHours, setAvailableHours] = useState([])
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const globalPreviewCanvasRef = useRef(null)

  useEffect(() => {
    return () => {
      canvasRef.current?.stopWatchSelect()
      canvasRef.current?.clearHistoryMode()
      canvasRef.current?.scheduleUpdate()
    }
  }, [canvasRef])

  useEffect(() => {
    if (previewOnCanvas && selectedTs != null) {
      canvasRef.current?.setHistoryMode(selectedTs)
    } else {
      canvasRef.current?.clearHistoryMode()
    }
    return () => { canvasRef.current?.clearHistoryMode() }
  }, [previewOnCanvas, selectedTs, canvasRef])

  function handlePick() {
    setSelecting(true)
    setStatus({ msg: 'Drag an area on canvas...', type: 'info' })
    canvasRef.current?.startWatchSelect((coords) => {
      setSelecting(false)
      const hudX1 = Math.floor(coords.x1 - (canvasSize || 0))
      const hudY1 = Math.floor(coords.y1 - (canvasSize || 0))
      const hudX2 = Math.floor(coords.x2 - (canvasSize || 0))
      const hudY2 = Math.floor(coords.y2 - (canvasSize || 0))
      setX1(String(hudX1))
      setY1(String(hudY1))
      setX2(String(hudX2))
      setY2(String(hudY2))
      setStatus({ msg: `Area: ${hudX1}_${hudY1} → ${hudX2}_${hudY2}`, type: 'ok' })
    })
  }

  return (
    <div className="mt-tabcontent">
      <span className="mt-label">Area Rollback</span>
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 8px' }}>
        Pick an area, choose a UTC snapshot, then confirm. Preview uses the same timestamp sent to the server.
      </p>
      <div style={{ display: 'flex', gap: 6, margin: '8px 0' }}>
        <button
          type="button"
          className={`mt-btn secondary ${selecting ? 'active' : ''}`}
          onClick={handlePick}
        >
          {selecting ? 'Selecting…' : 'Select area on canvas'}
        </button>
      </div>
      <CoordsPairInputs
        p1Str={p1Str}
        p2Str={p2Str}
        setP1Str={setP1Str}
        setP2Str={setP2Str}
        setX1={setX1}
        setY1={setY1}
        setX2={setX2}
        setY2={setY2}
        canvasIndent={canvasIndent}
        sublabelClassName="input-sublabel"
      />
      {status.msg && <div className={`mt-status ${status.type}`} style={{ marginTop: 8 }}>{status.msg}</div>}
      <SnapshotRollbackPanel
        canvasId={canvasId}
        globalPreviewCanvasRef={globalPreviewCanvasRef}
        selectedTs={selectedTs}
        setSelectedTs={setSelectedTs}
        previewOnCanvas={previewOnCanvas}
        setPreviewOnCanvas={setPreviewOnCanvas}
        availableDays={availableDays}
        setAvailableDays={setAvailableDays}
        selectedDay={selectedDay}
        setSelectedDay={setSelectedDay}
        availableHours={availableHours}
        setAvailableHours={setAvailableHours}
        snapshotsLoading={snapshotsLoading}
        setSnapshotsLoading={setSnapshotsLoading}
        x1={x1} y1={y1} x2={x2} y2={y2}
        canvasSize={canvasSize}
        activeCanvasId={canvasId}
        activeCanvasSize={canvasSize}
        setStatus={setStatus}
        confirmLabel="Rollback area"
      />
    </div>
  )
}

function getRoleBadge(roleNum) {
  if (roleNum >= 254) return { label: 'Owner', colorClass: 'role-admin' }
  if (roleNum >= 200) return { label: 'Admin', colorClass: 'role-admin' }
  if (roleNum >= 150) return { label: 'Mod', colorClass: 'role-moderator' }
  if (roleNum >= 100) return { label: 'T-Mod', colorClass: 'role-moderator' }
  return { label: 'User', colorClass: 'role-user' }
}

// ── Void Event tab (admin only) ────────────────────────────────────────────────

function VoidTab() {
  const [state, setState] = useState(null)
  const [cfg, setCfg] = useState(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    try {
      const r = await fetch('/admin/void/state')
      if (r.ok) {
        const d = await r.json()
        setState(d.state)
        setCfg(prev => prev ?? d.config)  // don't overwrite local edits
      }
    } catch { }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])

  async function control(action, value) {
    const body = { action }
    if (value !== undefined) body.value = value
    const r = await fetch('/admin/void/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const d = await r.json()
    setMsg(d.ok ? `✓ ${action}` : `✗ ${d.error || 'failed'}`)
    setTimeout(() => setMsg(''), 3000)
    load()
  }

  async function saveConfig() {
    setSaving(true)
    try {
      const cleanCfg = {}
      for (const [k, v] of Object.entries(cfg || {})) {
        if (v !== '' && v !== null && !Number.isNaN(v)) {
          cleanCfg[k] = v
        }
      }
      const r = await fetch('/admin/void/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanCfg),
      })
      const d = await r.json()
      if (d.ok && d.config) {
        setCfg(d.config)
        setMsg('✓ Config saved')
      } else {
        setMsg(`✗ Save failed: ${d?.error || 'unknown error'}`)
      }
    } catch { setMsg('✗ Error saving config') }
    setSaving(false)
    setTimeout(() => setMsg(''), 3000)
  }

  function cfgField(key, label, type = 'number', step = 0.1) {
    if (!cfg) return null
    return (
      <div className="void-cfg-row" key={key}>
        <label className="void-cfg-label">{label}</label>
        {type === 'checkbox'
          ? <input type="checkbox" checked={!!cfg[key]}
            onChange={e => setCfg(c => ({ ...c, [key]: e.target.checked }))} />
          : <input
            type={type}
            step={step}
            value={cfg[key] ?? ''}
            className="void-cfg-input"
            onChange={e => {
              const val = e.target.value
              setCfg(c => ({
                ...c,
                [key]: type === 'number' ? (val === '' ? '' : (Number.isNaN(parseFloat(val)) ? '' : parseFloat(val))) : val
              }))
            }}
          />
        }
      </div>
    )
  }

  const phaseColor = {
    idle: '#718096', active: '#e53e3e', dying_win: '#38a169',
    dying_lose: '#718096', lockdown: '#4a5568',
  }

  return (
    <div className="void-tab-inner">
      <h3 className="void-section-title">🌑 Void Event</h3>

      {/* Status */}
      {state && (
        <div className="void-status-card">
          <div className="void-status-row">
            <span className="void-status-badge" style={{ background: phaseColor[state.phase] || '#555' }}>
              {state.phase.toUpperCase()}
            </span>
            {state.phase === 'active' && (
              <>
                <span className="void-status-item">❤️ {state.hp?.toFixed(1)}%</span>
                <span className="void-status-item">⏱ {state.time_left}s left</span>
                <span className="void-status-item">🟥 {state.blob_size} px</span>
                {state.root_count > 0 && <span className="void-status-item">🌿 {state.root_count} roots</span>}
              </>
            )}
            {state.phase === 'idle' && (
              <span className="void-status-item">⏳ Next: {Math.round(state.cooldown_left)}s</span>
            )}
            {state.phase === 'lockdown' && (
              <span className="void-status-item">🔒 {state.time_left}s remaining</span>
            )}
          </div>
          {state.phase === 'active' && (
            <div className="void-hp-bar-admin">
              <div className="void-hp-bar-fill" style={{ width: `${state.hp ?? 0}%` }} />
            </div>
          )}
        </div>
      )}

      {msg && <div className="void-msg">{msg}</div>}

      {/* Controls */}
      <div className="void-controls">
        <button className="void-btn void-btn-start" onClick={() => control('start')}>▶ Start Void</button>
        <button className="void-btn void-btn-stop" onClick={() => control('stop')}>⏹ Stop/Abort</button>
        <button className="void-btn" style={{ background: '#2e7d32', color: '#fff' }} onClick={() => control('auto_repair')}>🔧 Auto Repair Canvas</button>
        <button className="void-btn" onClick={() => control('pause')}>⏸ Pause</button>
        <button className="void-btn" onClick={() => control('resume')}>▶️ Resume</button>
        <button className="void-btn" onClick={() => control('reset_cooldown')}>🔄 Reset CD</button>
        <button className="void-btn"
          onClick={() => {
            const v = prompt('Set cooldown (seconds from now):', '3600')
            if (v !== null) control('set_cooldown', parseFloat(v))
          }}>
          ⏰ Set CD…
        </button>
        <button className="void-btn"
          onClick={() => {
            const v = prompt('Set HP (0–100):', String(Math.round(state?.hp ?? 100)))
            if (v !== null) control('set_hp', parseFloat(v))
          }}>
          ❤️ Set HP…
        </button>
      </div>

      {/* Config */}
      {cfg && (
        <div className="void-config-section">
          <h4 className="void-section-subtitle">Configuration</h4>
          {cfgField('enabled', 'Enabled', 'checkbox')}
          {cfgField('auto_repair', 'Auto Repair on Defeat/Loss (no lockdown wait)', 'checkbox')}
          {cfgField('canvas_id', 'Canvas ID', 'number', 1)}
          {cfgField('interval_hours', 'Interval (hours)', 'number', 0.5)}
          {cfgField('grow_duration_mins', 'Grow Duration (min)', 'number', 1)}
          {cfgField('lockdown_duration_mins', 'Lockdown Duration (min)', 'number', 1)}
          {cfgField('win_cooldown_halve_secs', 'Win Halve CD (secs)', 'number', 60)}
          {cfgField('win_cd_multiplier', 'Win CD Multiplier', 'number', 0.1)}
          {cfgField('loss_cd_multiplier', 'Loss CD Multiplier', 'number', 0.1)}
          {cfgField('max_hp', 'Max HP', 'number', 1)}
          {cfgField('hp_regen_per_sec', 'HP Regen / sec', 'number', 0.01)}
          {cfgField('damage_inside', 'Dmg — Inside Blob', 'number', 0.5)}
          {cfgField('damage_border', 'Dmg — Border Pixel', 'number', 0.5)}
          {cfgField('damage_root_cut', 'Dmg — Root Cut', 'number', 0.5)}
          {cfgField('min_spawn_radius', 'Min Spawn Radius', 'number', 1)}
          {cfgField('max_spawn_radius', 'Max Spawn Radius', 'number', 1)}
          {cfgField('growth_interval_secs', 'Growth Tick (secs)', 'number', 0.5)}
          {cfgField('root_interval_secs', 'Root Tick (secs)', 'number', 1)}
          {cfgField('black_color_idx', 'Black Color Index', 'number', 1)}
          {cfgField('gray_color_idx', 'Gray Wall Color Index', 'number', 1)}
          <button
            className="void-btn void-btn-save"
            onClick={saveConfig}
            disabled={saving}
            style={{ marginTop: 10, width: '100%' }}
          >
            {saving ? 'Saving…' : '💾 Save Config'}
          </button>
        </div>
      )}
    </div>
  )
}

function LogsTab() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [selectedActionType, setSelectedActionType] = useState('all')

  async function loadLogs() {
    setLoading(true)
    try {
      const r = await fetch('/admin/logs')
      if (r.ok) {
        const d = await r.json()
        setLogs(d.logs || [])
      }
    } catch {
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadLogs()
  }, [])

  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // 1. Action type/category filter
      const action = (log.action || '').toLowerCase()
      const details = (log.details || '').toLowerCase()
      if (selectedActionType === 'rollback') {
        if (!action.includes('rollback') && !details.includes('rollback')) return false
      } else if (selectedActionType === 'protected') {
        if (!action.includes('protect') && !details.includes('protect') && !details.includes('unprotect')) return false
      } else if (selectedActionType === 'bans') {
        if (!action.includes('ban') && !action.includes('kick')) return false
      } else if (selectedActionType === 'chat') {
        if (!action.includes('mute') && !action.includes('chat') && !action.includes('purge') && !action.includes('announce')) return false
      } else if (selectedActionType === 'logins') {
        if (action !== 'login') return false
      } else if (selectedActionType === 'void') {
        if (!action.includes('void')) return false
      } else if (selectedActionType === 'canvas') {
        if (!action.includes('canvas') && action !== 'paste_image') return false
      }

      // 2. Search query across ALL fields
      const q = filter.trim().toLowerCase()
      if (!q) return true

      const tokens = q.split(/\s+/).filter(Boolean)
      const dateStr = log.timestamp ? `${new Date(log.timestamp * 1000).toLocaleString()} ${formatDate(log.timestamp)}` : ''
      const allFieldsStr = (
        `${log.username || ''} ${log.user_id || ''} ${log.action || ''} ${log.details || ''} ` +
        `${dateStr} ${Object.values(log).join(' ')}`
      ).toLowerCase()

      return tokens.every(token => allFieldsStr.includes(token))
    })
  }, [logs, selectedActionType, filter])

  function formatDate(ts) {
    const d = new Date(ts * 1000)
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  const getActionColor = (act) => {
    const a = (act || '').toLowerCase()
    if (a.includes('unmute') || a.includes('unban') || a.includes('pardon')) return '#2ecc71'
    if (a.includes('ban') || a.includes('kick')) return '#e74c3c'
    if (a.includes('rollback') || a.includes('replace')) return '#bb86fc'
    if (a.includes('protect')) return '#1abc9c'
    if (a.includes('announce')) return '#f1c40f'
    if (a.includes('purge')) return '#e67e22'
    if (a.includes('mute') || a.includes('chat') || a.includes('warn')) return '#ff9800'
    return '#4da6ff'
  }

  const categories = [
    { k: 'all', l: 'All' },
    { k: 'rollback', l: 'Rollbacks' },
    { k: 'protected', l: 'Protected' },
    { k: 'bans', l: 'Bans/Kicks' },
    { k: 'chat', l: 'Chat/Mutes' },
    { k: 'logins', l: 'Logins' },
    { k: 'canvas', l: 'Canvas/Paste' },
    { k: 'void', l: 'Void' },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span className="mt-label">📋 Audit Logs ({filteredLogs.length})</span>
        <button className="mt-btn secondary" onClick={loadLogs} disabled={loading}>
          {loading ? 'Loading...' : '↺ Refresh'}
        </button>
      </div>

      <div style={{ marginBottom: 8 }}>
        <input
          type="text"
          className="mt-input"
          placeholder="Search all fields (mod, ID, action, details, timestamp, IP)..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
      </div>

      {/* Quick Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
        {categories.map(cat => (
          <button
            key={cat.k}
            className={`mt-btn secondary${selectedActionType === cat.k ? ' active-sub' : ''}`}
            style={{ fontSize: 9, padding: '2px 6px' }}
            onClick={() => setSelectedActionType(cat.k)}
          >
            {cat.l}
          </button>
        ))}
      </div>

      <div style={{ maxHeight: '410px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {filteredLogs.map((log, idx) => (
          <div key={idx} className="live-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4, padding: '8px 10px', fontSize: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span className="urow-name" style={{ color: '#4da6ff', fontWeight: 'bold' }}>{log.username}</span>
                {log.user_id && (
                  <>
                    <span className="muted" style={{ fontSize: 10 }}>#{log.user_id}</span>
                    <CopyBtn text={String(log.user_id)} title="Copy Moderator ID" />
                  </>
                )}
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {log.site === 'main' ? (
                  <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(46, 204, 113, 0.15)', color: '#2ecc71', border: '1px solid rgba(46, 204, 113, 0.3)', fontWeight: 600 }}>
                    🟢 pixmap.fun (Main Site)
                  </span>
                ) : log.site === 'dev' ? (
                  <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(241, 196, 15, 0.15)', color: '#f1c40f', border: '1px solid rgba(241, 196, 15, 0.3)', fontWeight: 600 }}>
                    🟡 dev.pixmap.fun (Test Site)
                  </span>
                ) : null}
                <span style={{ fontSize: 9, color: '#888' }}>{formatDate(log.timestamp)}</span>
              </div>
            </div>
            <div style={{ color: getActionColor(log.action), fontWeight: 'bold', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {log.action}
            </div>
            <div style={{ color: '#ddd', wordBreak: 'break-word', marginTop: 2 }}>
              {log.details}
            </div>
            {log.url && (
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                <a
                  href={log.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-btn secondary"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 8px', fontSize: 10, textDecoration: 'none',
                    color: '#00ffcc', borderColor: 'rgba(0, 255, 204, 0.3)', background: 'rgba(0, 255, 204, 0.08)'
                  }}
                  title={`Open location in canvas: ${log.url}`}
                >
                  📍 Jump to Location
                </a>
                <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>
                  {log.canvas_name ? `${log.canvas_name} ` : ''}{log.hud_x !== undefined && log.hud_y !== undefined ? `(${log.hud_x}, ${log.hud_y})` : ''}
                </span>
              </div>
            )}
          </div>
        ))}

        {filteredLogs.length === 0 && (
          <div className="mt-status">
            {loading ? 'Loading logs...' : 'No logs match selected filters.'}
          </div>
        )}
      </div>
    </div>
  )
}


// ── Admin: IID ↔ IP tools ─────────────────────────────────────────────────────

function IidAdminTab() {
  const [userId, setUserId] = useState('')
  const [iidQuery, setIidQuery] = useState('')
  const [iids, setIids] = useState(null)
  const [iidUsers, setIidUsers] = useState(null)
  const [iidIps, setIidIps] = useState(null)
  const [loading, setLoading] = useState('')
  const [err, setErr] = useState('')

  async function fetchIidsByUser() {
    const id = parseInt(userId, 10)
    if (Number.isNaN(id)) { setErr('Enter a valid user ID'); return }
    setLoading('iids'); setErr(''); setIids(null)
    try {
      const r = await fetch(`/admin/users/${id}/iids`)
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.detail || 'Failed')
      setIids(d.iids || [])
    } catch (e) { setErr(e.message) }
    finally { setLoading('') }
  }

  async function fetchUsersByIid() {
    const t = iidQuery.trim()
    if (!t) { setErr('Enter an IID'); return }
    setLoading('users'); setErr(''); setIidUsers(null); setIidIps(null)
    try {
      const [ru, ri] = await Promise.all([
        fetch(`/admin/iid/${encodeURIComponent(t)}/users`),
        fetch(`/admin/iid/${encodeURIComponent(t)}/ip`),
      ])
      const du = await ru.json().catch(() => ({}))
      const di = await ri.json().catch(() => ({}))
      if (!ru.ok) throw new Error(du.detail || 'User lookup failed')
      if (!ri.ok) throw new Error(di.detail || 'IP lookup failed')
      setIidUsers(du)
      setIidIps(di)
    } catch (e) { setErr(e.message) }
    finally { setLoading('') }
  }

  return (
    <div>
      <p className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
        Full IIDs are stored per connection (IPInfo hash). Mods only see the short hash prefix elsewhere.
      </p>

      <label className="mt-label">User ID → IIDs</label>
      <div className="quick-role-row" style={{ marginBottom: 12 }}>
        <input className="mt-input" type="number" placeholder="User ID" value={userId}
          onChange={e => setUserId(e.target.value)} onKeyDown={e => e.key === 'Enter' && fetchIidsByUser()} style={{ width: 100 }} />
        <button className="mt-btn primary" onClick={fetchIidsByUser} disabled={loading === 'iids'}>Lookup</button>
      </div>
      {iids && (
        <ul className="iid-list" style={{ listStyle: 'none', padding: 0, marginBottom: 16 }}>
          {iids.length === 0 && <li className="muted">No IIDs found.</li>}
          {iids.map(iid => (
            <li key={iid} style={{ marginBottom: 4 }}>
              <code style={{ cursor: 'pointer', fontSize: 11 }} title="Click to copy" onClick={() => copyCoord(iid)}>{iid}</code>
            </li>
          ))}
        </ul>
      )}

      <label className="mt-label">IID → users &amp; IPs</label>
      <div className="quick-role-row" style={{ marginBottom: 8 }}>
        <input className="mt-input" placeholder="Full UUID or prefix" value={iidQuery}
          onChange={e => setIidQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && fetchUsersByIid()} style={{ flex: 1 }} />
        <button className="mt-btn primary" onClick={fetchUsersByIid} disabled={loading === 'users'}>Resolve</button>
      </div>
      {iidUsers && (
        <div style={{ marginBottom: 12 }}>
          <div className="mt-label" style={{ fontSize: 11 }}>Users ({iidUsers.users?.length ?? 0})</div>
          {(iidUsers.users || []).map(u => (
            <div key={u.id} className="inspector-row">
              <span className="urow-name">#{u.id} {u.username}</span>
              <span className={`role-badge role-${u.role}`}>{u.role}</span>
              {u.banned && <span className="banned-tag">BANNED</span>}
            </div>
          ))}
        </div>
      )}
      {iidIps && (
        <div>
          <div className="mt-label" style={{ fontSize: 11 }}>IPs ({iidIps.ips?.length ?? 0})</div>
          {(iidIps.ips || []).map(row => (
            <div key={row.ip} className="inspector-row">
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{row.ip}</span>
              <span className="urow-stat">{row.country} · {row.cidr}</span>
              <code style={{ fontSize: 10, opacity: 0.7 }}>{row.iid}</code>
            </div>
          ))}
        </div>
      )}
      {err && <div className="mt-status error">{err}</div>}
    </div>
  )
}

function ChatSettingsTab() {
  const [minPixels, setMinPixels] = useState(5000)
  const [draft, setDraft] = useState('5000')
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const r = await fetch('/admin/chat/config')
      if (!r.ok) return
      const d = await r.json()
      const value = Number(d.min_pixels ?? 5000)
      setMinPixels(value)
      setDraft(String(value))
    } catch { }
  }

  useEffect(() => { load() }, [])

  async function save() {
    const value = parseInt(draft, 10)
    if (Number.isNaN(value) || value < 0) {
      setMsg('✗ Enter a non-negative whole number (0 disables the gate)')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/admin/chat/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ min_pixels: value }),
      })
      const d = await r.json().catch(() => ({}))
      if (r.ok) {
        setMinPixels(d.min_pixels)
        setDraft(String(d.min_pixels))
        setMsg(d.min_pixels === 0 ? '✓ Chat unlocked for everyone' : `✓ Chat requires ${Number(d.min_pixels).toLocaleString()} pixels`)
      } else {
        setMsg(`✗ ${d.detail || 'Save failed'}`)
      }
    } catch {
      setMsg('✗ Network error')
    }
    setSaving(false)
    setTimeout(() => setMsg(''), 4000)
  }

  return (
    <div className="mt-tabcontent">
      <h3 className="void-section-title">💬 Chat Settings</h3>
      <p className="muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
        Minimum total pixels (all canvases) required before a player can send chat messages.
        Staff are exempt. Set to <strong>0</strong> to disable the requirement.
      </p>
      <div className="void-cfg-row">
        <label className="void-cfg-label">Min pixels to chat</label>
        <input
          className="void-cfg-input"
          type="number"
          min="0"
          step="1"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <button className="mt-btn" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          Current: {minPixels === 0 ? 'disabled' : `${minPixels.toLocaleString()} px`}
        </span>
      </div>
      {msg && <div className="void-msg" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}

function AdminTab() {
  const [sub, setSub] = useState('void')
  return (
    <div className="mt-tabcontent">
      <div className="mt-tabs" style={{ marginBottom: 12 }}>
        <button type="button" className={`mt-tab void-tab-btn${sub === 'void' ? ' active' : ''}`} onClick={() => setSub('void')}>🌑 Void</button>
        <button type="button" className={`mt-tab${sub === 'chat' ? ' active' : ''}`} onClick={() => setSub('chat')}>💬 Chat</button>
        <button type="button" className={`mt-tab${sub === 'iid' ? ' active' : ''}`} onClick={() => setSub('iid')}>🔑 IID ↔ IP</button>
      </div>
      {sub === 'void' && <VoidTab />}
      {sub === 'chat' && <ChatSettingsTab />}
      {sub === 'iid' && <IidAdminTab />}
    </div>
  )
}

// ── Owner Tools Tab ──────────────────────────────────────────────────────────

function OwnerToolsTab() {
  const [userId, setUserId] = useState('')
  const [pixelAmount, setPixelAmount] = useState('')
  const [canvasId, setCanvasId] = useState('all')
  const [discordId, setDiscordId] = useState('')
  const [googleId, setGoogleId] = useState('')
  const [status, setStatus] = useState('')
  const [userInfo, setUserInfo] = useState(null)
  const [copiedField, setCopiedField] = useState(null)

  async function loadUser() {
    if (!userId) return
    try {
      const r = await fetch(`/admin/users/${userId}/profile`)
      if (!r.ok) {
        setStatus('User not found')
        setUserInfo(null)
        return
      }
      const data = await r.json()
      setUserInfo(data)
      setDiscordId(data.discord_id || '')
      setGoogleId(data.google_id || '')
      setStatus('')
    } catch (err) {
      setStatus('Failed to load user')
      setUserInfo(null)
    }
  }

  async function handlePixelAction(action) {
    if (!userId || !pixelAmount) {
      setStatus('Please enter user ID and amount')
      return
    }
    const amount = parseInt(pixelAmount, 10)
    if (isNaN(amount) || amount <= 0) {
      setStatus('Invalid amount')
      return
    }

    try {
      const r = await fetch(`/admin/owner/pixels/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, amount, canvas_id: canvasId })
      })
      const data = await r.json()
      if (r.ok) {
        setStatus(`✓ ${data.message}`)
        await loadUser()
      } else {
        setStatus(`✗ ${data.detail || 'Failed'}`)
      }
    } catch (err) {
      setStatus(`✗ Network error`)
    }
  }

  async function handleLinkDiscord() {
    if (!userId || !discordId) {
      setStatus('Please enter user ID and Discord ID')
      return
    }

    try {
      const r = await fetch('/admin/owner/link-discord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, discord_id: discordId })
      })
      const data = await r.json()
      if (r.ok) {
        setStatus(`✓ ${data.message}`)
        await loadUser()
      } else {
        setStatus(`✗ ${data.detail || 'Failed'}`)
      }
    } catch (err) {
      setStatus(`✗ Network error`)
    }
  }

  async function handleUnlinkDiscord() {
    if (!userId) {
      setStatus('Please enter user ID')
      return
    }

    if (!confirm(`Unlink Discord from user ${userInfo?.username || userId}?`)) return

    try {
      const r = await fetch('/admin/owner/unlink-discord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId })
      })
      const data = await r.json()
      if (r.ok) {
        setStatus(`✓ ${data.message}`)
        await loadUser()
      } else {
        setStatus(`✗ ${data.detail || 'Failed'}`)
      }
    } catch (err) {
      setStatus(`✗ Network error`)
    }
  }

  async function handleLinkGoogle() {
    if (!userId || !googleId) {
      setStatus('Please enter user ID and Google ID')
      return
    }

    try {
      const r = await fetch('/admin/owner/link-google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, google_id: googleId })
      })
      const data = await r.json()
      if (r.ok) {
        setStatus(`✓ ${data.message}`)
        await loadUser()
      } else {
        setStatus(`✗ ${data.detail || 'Failed'}`)
      }
    } catch (err) {
      setStatus(`✗ Network error`)
    }
  }

  async function handleUnlinkGoogle() {
    if (!userId) {
      setStatus('Please enter user ID')
      return
    }

    if (!confirm(`Unlink Google from user ${userInfo?.username || userId}?`)) return

    try {
      const r = await fetch('/admin/owner/unlink-google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId })
      })
      const data = await r.json()
      if (r.ok) {
        setStatus(`✓ ${data.message}`)
        await loadUser()
      } else {
        setStatus(`✗ ${data.detail || 'Failed'}`)
      }
    } catch (err) {
      setStatus(`✗ Network error`)
    }
  }

  async function handleDeleteUser() {
    if (!userId) {
      setStatus('Please enter user ID')
      return
    }

    const username = userInfo?.username || userId
    if (!confirm(`⚠️ PERMANENTLY DELETE user ${username} (ID: ${userId})?\n\nThis will:\n- Delete the account\n- Anonymize all pixel placements\n- Remove from leaderboards\n- Delete all sessions\n\nThis action is IRREVERSIBLE!`)) {
      return
    }

    if (!confirm(`Are you absolutely sure you want to delete ${username}? Type the username to confirm.`)) {
      return
    }

    try {
      const r = await fetch('/admin/owner/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId })
      })
      const data = await r.json()
      if (r.ok) {
        setStatus(`✓ ${data.message}`)
        setUserInfo(null)
        setUserId('')
        setDiscordId('')
        setGoogleId('')
      } else {
        setStatus(`✗ ${data.detail || 'Failed'}`)
      }
    } catch (err) {
      setStatus(`✗ Network error`)
    }
  }

  return (
    <div className="mt-tab-content">
      <h2>⚠️ Owner Tools</h2>
      <p className="muted" style={{ marginBottom: '20px' }}>
        Advanced user management tools. Use with caution.
      </p>

      {/* User Lookup */}
      <div className="mt-section">
        <h3>User Lookup</h3>
        <div className="mt-row">
          <input
            type="text"
            placeholder="User ID"
            value={userId}
            onChange={e => setUserId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadUser()}
            style={{ flex: 1 }}
          />
          <button className="mt-btn secondary" onClick={loadUser}>Load User</button>
        </div>
        
        {userInfo && (() => {
          const copy = async (val, fieldKey) => {
            if (val === undefined || val === null || val === '') return
            const str = String(val)
            let success = false
            try {
              if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(str)
                success = true
              }
            } catch {}
            if (!success) {
              try {
                const ta = document.createElement('textarea')
                ta.value = str
                ta.style.position = 'fixed'
                ta.style.left = '-9999px'
                ta.style.top = '0'
                document.body.appendChild(ta)
                ta.focus()
                ta.select()
                success = document.execCommand('copy')
                document.body.removeChild(ta)
              } catch {}
            }
            if (fieldKey) {
              setCopiedField(fieldKey)
              setTimeout(() => setCopiedField(prev => prev === fieldKey ? null : prev), 1500)
            }
            window.dispatchEvent(new CustomEvent('pixmap:toast', {
              detail: { msg: `✓ Copied: ${str.length > 35 ? str.slice(0, 35) + '…' : str}`, type: 'success' }
            }))
          }

          const CopyRow = ({ label, fieldKey, value, display }) => value !== undefined && value !== null && value !== '' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <span style={{ color: 'var(--muted)', fontSize: '11px', minWidth: 100, flexShrink: 0 }}>{label}</span>
              <span
                onClick={() => copy(value, fieldKey)}
                title="Click to copy"
                style={{ flex: 1, fontFamily: 'monospace', fontSize: '12px', wordBreak: 'break-all', cursor: 'pointer', userSelect: 'all' }}
              >
                {display || value}
              </span>
              <button
                onClick={() => copy(value, fieldKey)}
                title="Copy"
                style={{
                  background: copiedField === fieldKey ? 'rgba(76, 175, 80, 0.25)' : 'rgba(255,255,255,0.07)',
                  border: 'none',
                  borderRadius: 4,
                  padding: '2px 7px',
                  cursor: 'pointer',
                  color: copiedField === fieldKey ? '#4caf50' : '#aaa',
                  fontSize: 11,
                  flexShrink: 0,
                  transition: 'all 0.2s'
                }}
              >
                {copiedField === fieldKey ? '✓ Copied' : '📋'}
              </button>
            </div>
          ) : null

          return (
            <div style={{ marginTop: '10px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {userInfo.avatar && <img src={userInfo.avatar} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{userInfo.username}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {userInfo.online ? '🟢 Online' : '⚫ Offline'} · {getRoleString(userInfo.role)}
                    {userInfo.is_banned && <span style={{ color: '#ff4444', marginLeft: 8 }}>⛔ Banned</span>}
                  </div>
                </div>
                <button
                  onClick={() => copy(JSON.stringify(userInfo, null, 2), 'all_json')}
                  title="Copy all data as JSON"
                  style={{
                    background: copiedField === 'all_json' ? 'rgba(76, 175, 80, 0.25)' : 'rgba(255,255,255,0.07)',
                    border: 'none',
                    borderRadius: 4,
                    padding: '4px 8px',
                    cursor: 'pointer',
                    color: copiedField === 'all_json' ? '#4caf50' : '#aaa',
                    fontSize: 11
                  }}
                >
                  {copiedField === 'all_json' ? '✓ Copied' : '📋 All JSON'}
                </button>
              </div>

              {/* Profile Fields */}
              <div style={{ padding: '6px 12px' }}>
                <CopyRow label="User ID" fieldKey="uid" value={userInfo.id} />
                <CopyRow label="Username" fieldKey="uname" value={userInfo.username} />
                <CopyRow label="Email" fieldKey="email" value={userInfo.email} />
                <CopyRow label="Discord ID" fieldKey="did" value={userInfo.discord_id} display={
                  userInfo.discord_id ? (
                    <a href={`https://discord.com/users/${userInfo.discord_id}`} target="_blank" rel="noopener noreferrer" style={{ color: '#5865F2' }}>
                      {userInfo.discord_username ? `@${userInfo.discord_username} (${userInfo.discord_id})` : userInfo.discord_id} ↗
                    </a>
                  ) : null
                } />
                <CopyRow label="Discord User" fieldKey="duser" value={userInfo.discord_username} />
                <CopyRow label="Google ID" fieldKey="gid" value={userInfo.google_id} />
                <CopyRow label="Country" fieldKey="country" value={userInfo.country} />
                <CopyRow label="Bio" fieldKey="bio" value={userInfo.bio} />
                <CopyRow label="Pixels" fieldKey="pixels" value={userInfo.pixels_placed} display={(userInfo.pixels_placed || 0).toLocaleString()} />
                <CopyRow label="Joined" fieldKey="joined" value={userInfo.created_at} display={userInfo.created_at ? new Date(userInfo.created_at).toLocaleString() : null} />
                <CopyRow label="Last Login" fieldKey="last_login" value={userInfo.last_login} display={userInfo.last_login ? new Date(userInfo.last_login).toLocaleString() : null} />
              </div>

              {/* Distinct IIDs Section */}
              {userInfo.iids?.length > 0 && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '8px 12px', background: 'rgba(255,255,255,0.01)' }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>🔑 IIDs / Hardware Identifiers ({userInfo.iids.length})</span>
                    <button
                      onClick={() => copy(userInfo.iids.join('\n'), 'all_iids')}
                      style={{
                        background: copiedField === 'all_iids' ? 'rgba(76, 175, 80, 0.25)' : 'rgba(255,255,255,0.07)',
                        border: 'none',
                        borderRadius: 4,
                        padding: '2px 6px',
                        cursor: 'pointer',
                        color: copiedField === 'all_iids' ? '#4caf50' : '#aaa',
                        fontSize: 10
                      }}
                    >
                      {copiedField === 'all_iids' ? '✓ Copied' : '📋 All IIDs'}
                    </button>
                  </div>
                  {userInfo.iids.map((iid, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.03)', fontSize: 12 }}>
                      <span
                        onClick={() => copy(iid, `iid_${i}`)}
                        title="Click to copy"
                        style={{ fontFamily: 'monospace', flex: 1, wordBreak: 'break-all', cursor: 'pointer', userSelect: 'all', color: '#e0e0e0' }}
                      >
                        {iid}
                      </span>
                      <button
                        onClick={() => copy(iid, `iid_${i}`)}
                        title="Copy IID"
                        style={{
                          background: copiedField === `iid_${i}` ? 'rgba(76, 175, 80, 0.25)' : 'rgba(255,255,255,0.07)',
                          border: 'none',
                          borderRadius: 4,
                          padding: '2px 6px',
                          cursor: 'pointer',
                          color: copiedField === `iid_${i}` ? '#4caf50' : '#aaa',
                          fontSize: 10,
                          flexShrink: 0
                        }}
                      >
                        {copiedField === `iid_${i}` ? '✓ Copied' : '📋 Copy'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* IP History Section */}
              {userInfo.ip_history?.length > 0 && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '8px 12px' }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>🌐 IP History ({userInfo.ip_history.length})</span>
                    <button
                      onClick={() => copy(userInfo.ip_history.map(i => i.ip).join('\n'), 'all_ips')}
                      style={{
                        background: copiedField === 'all_ips' ? 'rgba(76, 175, 80, 0.25)' : 'rgba(255,255,255,0.07)',
                        border: 'none',
                        borderRadius: 4,
                        padding: '2px 6px',
                        cursor: 'pointer',
                        color: copiedField === 'all_ips' ? '#4caf50' : '#aaa',
                        fontSize: 10
                      }}
                    >
                      {copiedField === 'all_ips' ? '✓ Copied' : '📋 All IPs'}
                    </button>
                  </div>
                  {userInfo.ip_history.map((ip, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 12 }}>
                      <span style={{ minWidth: 18, textAlign: 'center', fontSize: 10, color: 'var(--muted)' }}>{ip.country || '?'}</span>
                      <span
                        onClick={() => copy(ip.ip, `ip_${i}`)}
                        title="Click to copy IP"
                        style={{ fontFamily: 'monospace', flex: 1, wordBreak: 'break-all', cursor: 'pointer', userSelect: 'all' }}
                      >
                        {ip.ip}
                      </span>
                      <span style={{ color: 'var(--muted)', fontSize: 10, flexShrink: 0 }}>
                        {ip.last_seen ? new Date(ip.last_seen).toLocaleDateString() : ''}
                      </span>
                      <button
                        onClick={() => copy(ip.ip, `ip_${i}`)}
                        title="Copy IP"
                        style={{
                          background: copiedField === `ip_${i}` ? 'rgba(76, 175, 80, 0.25)' : 'rgba(255,255,255,0.07)',
                          border: 'none',
                          borderRadius: 4,
                          padding: '2px 6px',
                          cursor: 'pointer',
                          color: copiedField === `ip_${i}` ? '#4caf50' : '#aaa',
                          fontSize: 10,
                          flexShrink: 0
                        }}
                      >
                        {copiedField === `ip_${i}` ? '✓ Copied' : '📋 IP'}
                      </button>
                      {ip.iid_hash && (
                        <button
                          onClick={() => copy(ip.iid_hash, `ip_iid_${i}`)}
                          title={`Copy IID: ${ip.iid_hash}`}
                          style={{
                            background: copiedField === `ip_iid_${i}` ? 'rgba(76, 175, 80, 0.25)' : 'rgba(255,255,255,0.07)',
                            border: 'none',
                            borderRadius: 4,
                            padding: '2px 6px',
                            cursor: 'pointer',
                            color: copiedField === `ip_iid_${i}` ? '#4caf50' : '#aaa',
                            fontSize: 10,
                            flexShrink: 0
                          }}
                        >
                          {copiedField === `ip_iid_${i}` ? '✓ IID' : '🔑 IID'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
      </div>


      {/* Pixel Management */}
      <div className="mt-section">
        <h3>Pixel Management</h3>
        <div className="mt-row">
          <input
            type="number"
            placeholder="Amount"
            value={pixelAmount}
            onChange={e => setPixelAmount(e.target.value)}
            style={{ flex: 1 }}
          />
          <select value={canvasId} onChange={e => setCanvasId(e.target.value)} style={{ flex: 1 }}>
            <option value="all">All Canvases</option>
            <option value="0">Canvas 0</option>
            <option value="1">Canvas 1</option>
            <option value="2">Canvas 2</option>
          </select>
        </div>
        <div className="mt-row" style={{ marginTop: '8px' }}>
          <button className="mt-btn primary" onClick={() => handlePixelAction('add')}>
            ➕ Add Pixels
          </button>
          <button className="mt-btn secondary" onClick={() => handlePixelAction('remove')}>
            ➖ Remove Pixels
          </button>
          <button className="mt-btn secondary" onClick={() => handlePixelAction('set')}>
            ⚙️ Set Exact Count
          </button>
        </div>
      </div>

      {/* Discord Management */}
      <div className="mt-section">
        <h3>Discord Account Linking</h3>
        <p className="muted" style={{ fontSize: '12px', marginBottom: '8px' }}>
          Up to 2 accounts can share the same Discord ID.
        </p>
        <div className="mt-row">
          <input
            type="text"
            placeholder="Discord ID (18 digits)"
            value={discordId}
            onChange={e => setDiscordId(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>
        <div className="mt-row" style={{ marginTop: '8px' }}>
          <button className="mt-btn primary" onClick={handleLinkDiscord}>
            🔗 Link Discord
          </button>
          <button className="mt-btn danger-sm" onClick={handleUnlinkDiscord}>
            ❌ Unlink Discord
          </button>
        </div>
      </div>

      {/* Google Management */}
      <div className="mt-section">
        <h3>Google Account Linking</h3>
        <div className="mt-row">
          <input
            type="text"
            placeholder="Google ID or Email (e.g., user@gmail.com)"
            value={googleId}
            onChange={e => setGoogleId(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>
        <div className="mt-row" style={{ marginTop: '8px' }}>
          <button className="mt-btn primary" onClick={handleLinkGoogle}>
            🔗 Link Google
          </button>
          <button className="mt-btn danger-sm" onClick={handleUnlinkGoogle}>
            ❌ Unlink Google
          </button>
        </div>
      </div>

      {/* Danger Zone - Account Deletion */}
      <div className="mt-section" style={{ borderTop: '2px solid rgba(255,0,0,0.3)', paddingTop: '20px', marginTop: '30px' }}>
        <h3 style={{ color: '#ff4444' }}>⚠️ Danger Zone</h3>
        <p className="muted" style={{ marginBottom: '12px', fontSize: '13px' }}>
          Permanently delete a user account. This action cannot be undone.
        </p>
        <button 
          className="mt-btn danger" 
          onClick={handleDeleteUser}
          disabled={!userId || !userInfo}
          style={{ 
            width: '100%', 
            backgroundColor: '#cc0000',
            opacity: (!userId || !userInfo) ? 0.5 : 1,
            cursor: (!userId || !userInfo) ? 'not-allowed' : 'pointer'
          }}
        >
          🗑️ Permanently Delete User
        </button>
      </div>

      {status && (
        <div className={`mt-status ${status.startsWith('✓') ? 'success' : status.startsWith('✗') ? 'error' : 'info'}`}>
          {status}
        </div>
      )}
    </div>
  )
}

function FactionsTab({ configs }) {
  const [factions, setFactions] = useState([])
  const [unlockedCanvases, setUnlockedCanvases] = useState([])
  const [unlockCanvasId, setUnlockCanvasId] = useState(1)

  const loadFactions = async () => {
    try {
      const res = await fetch('/api/factions')
      if (res.ok) {
        const data = await res.json()
        setFactions(data.factions || [])
      }
      const uRes = await fetch('/api/factions/admin/unlocked-canvases')
      if (uRes.ok) {
        const uData = await uRes.json()
        setUnlockedCanvases(uData.unlocked || [])
      }
    } catch {}
  }

  useEffect(() => { loadFactions() }, [])

  async function handleDisband(id, name) {
    if (!confirm(`Are you sure you want to disband the faction "${name}"?`)) return
    try {
      const res = await fetch(`/api/factions/${id}`, { method: 'DELETE' })
      if (res.ok) loadFactions()
    } catch {}
  }

  async function handleWarnLeader(id, name, leaderName) {
    const reason = prompt(`Reason for warning faction "${name}" (Leader: ${leaderName}):`, 'Inappropriate content / behavior')
    if (!reason || !reason.strip?.() && !reason.trim()) return
    try {
      const formData = new FormData()
      formData.append('reason', reason.trim())
      const res = await fetch(`/api/factions/${id}/warn`, { method: 'POST', body: formData })
      if (res.ok) {
        alert(`Official warning issued to faction "${name}"!`)
        loadFactions()
      }
    } catch {}
  }

  async function handleDeleteTemplate(id, name) {
    if (!confirm(`Delete template for faction "${name}"?`)) return
    try {
      const res = await fetch(`/api/factions/${id}/template`, { method: 'DELETE' })
      if (res.ok) {
        alert(`Template deleted for faction "${name}"!`)
        loadFactions()
      }
    } catch {}
  }

  async function handleUnlockCanvas() {
    try {
      const formData = new FormData()
      formData.append('canvas_id', unlockCanvasId)
      const res = await fetch('/api/factions/admin/unlock-canvas', { method: 'POST', body: formData })
      if (res.ok) loadFactions()
    } catch {}
  }

  return (
    <div className="mt-tabcontent">
      <h3 className="mt-label">Unlock Canvases for Factions</h3>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
        <select className="mt-input" value={unlockCanvasId} onChange={e => setUnlockCanvasId(Number(e.target.value))}>
          {configs && Object.entries(configs).map(([id, cfg]) => (
            <option key={id} value={id}>Canvas #{id} ({cfg.name})</option>
          ))}
        </select>
        <button className="mt-btn primary btn-compact" onClick={handleUnlockCanvas}>Unlock Canvas</button>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '16px' }}>
        Unlocked Canvases: <strong>{unlockedCanvases.length ? unlockedCanvases.join(', ') : 'Earth (Default)'}</strong>
      </div>

      <h3 className="mt-label">All Factions ({factions.length})</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {factions.map(f => (
          <div key={f.id} className="user-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px', padding: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <img src={f.logo_url || 'https://cdn.discordapp.com/embed/avatars/0.png'} alt="" className="urow-avatar" style={{ imageRendering: 'pixelated' }} />
              <div className="urow-info" style={{ flex: 1 }}>
                <span className="urow-name">{f.name}</span>
                <span className="urow-stat">Leader: <strong>{f.owner_username}</strong> • 👥 {f.member_count} members • 🎨 {f.total_pixels.toLocaleString()} total px</span>
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button className="mt-btn secondary btn-compact" onClick={() => handleWarnLeader(f.id, f.name, f.owner_username)}>⚠️ Warn Leader</button>
                <button className="mt-btn danger-sm" onClick={() => handleDisband(f.id, f.name)}>Disband</button>
              </div>
            </div>

            {/* Template details & Mod control */}
            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '6px 8px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px' }}>
              <span>
                🎨 <strong>Template:</strong> {f.template_url ? `Canvas #${f.template_canvas_id} at (${f.template_x}, ${f.template_y})` : 'None uploaded'}
              </span>
              {f.template_url && (
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <a href={f.template_url} target="_blank" rel="noreferrer" style={{ color: '#5b9cff', textDecoration: 'underline' }}>View Image</a>
                  <button className="mt-btn danger-sm" onClick={() => handleDeleteTemplate(f.id, f.name)}>Delete Template</button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

function hasTabAccess(roleNum, tabKey) {
  const r = Number(roleNum) || 0;
  if (r >= 254) return true;
  if (r >= 200) {
    if (tabKey === 'owner') return false;
    return true;
  }

  const allowed = [];
  if (r >= 150) {
    allowed.push('canvas', 'users', 'watch', 'alts', 'iidlookup', 'lookup', 'discord', 'iidhistory', 'factions');
  } else if (r >= 100) {
    allowed.push('canvas', 'users', 'watch', 'lookup', 'discord', 'iidhistory', 'factions');
  }

  return allowed.includes(tabKey);
}

export default function ModtoolsPanel({ currentUser, canvasRef, canvasSize, canvasId, configs, onClose }) {
  const isAdmin = (currentUser?.role ?? 0) >= 200
  const isMod = (currentUser?.role ?? 0) >= 100
  const isOwner = (currentUser?.role ?? 0) >= 254
  const [tab, setTab] = useState('canvas')
  const [iconVer, setIconVer] = useState(0)

  const role = currentUser?.role ?? 0

  return (
    <ModtoolsContext.Provider value={{ configs: configs || {}, canvasRef, canvasId: canvasId || 0, canvasSize: canvasSize || 0 }}>
      <div id="panel-modtools" className="panel">
      <PanelHeader
        title={isOwner ? 'Owner / Admin Tools' : isAdmin ? 'Admin / Mod Tools' : 'Mod Tools'}
        titleId="modtools-title"
        panelId="panel-modtools"
        onClose={onClose}
      />
      <div className="panel-body modtools-body">
        <div className="mt-tabs">
          {hasTabAccess(role, 'canvas') && <button type="button" className={`mt-tab${tab === 'canvas' ? ' active' : ''}`} onClick={() => setTab('canvas')}>🎨 Canvas</button>}
          {hasTabAccess(role, 'factions') && <button type="button" className={`mt-tab${tab === 'factions' ? ' active' : ''}`} onClick={() => setTab('factions')}>🛡️ Factions</button>}
          {hasTabAccess(role, 'canvases') && <button type="button" className={`mt-tab${tab === 'canvases' ? ' active' : ''}`} onClick={() => setTab('canvases')}>🗺 Canvases</button>}
          {hasTabAccess(role, 'icons') && <button type="button" className={`mt-tab${tab === 'icons' ? ' active' : ''}`} onClick={() => setTab('icons')}>🏅 Icons</button>}
          {hasTabAccess(role, 'cosmetics') && <button type="button" className={`mt-tab${tab === 'cosmetics' ? ' active' : ''}`} onClick={() => setTab('cosmetics')}>✨ Cosmetics</button>}
          {hasTabAccess(role, 'users') && <button type="button" className={`mt-tab${tab === 'users' ? ' active' : ''}`} onClick={() => setTab('users')}>👥 Users</button>}
          {hasTabAccess(role, 'lookup') && <button type="button" className={`mt-tab${tab === 'lookup' ? ' active' : ''}`} onClick={() => setTab('lookup')}>🔍 Lookup</button>}
          {hasTabAccess(role, 'watch') && <button type="button" className={`mt-tab${tab === 'watch' ? ' active' : ''}`} onClick={() => setTab('watch')}>🔍 Watch</button>}
          {hasTabAccess(role, 'alts') && <button type="button" className={`mt-tab${tab === 'alts' ? ' active' : ''}`} onClick={() => setTab('alts')}>🕵️ Alts</button>}
          {hasTabAccess(role, 'iidlookup') && <button type="button" className={`mt-tab${tab === 'iidlookup' ? ' active' : ''}`} onClick={() => setTab('iidlookup')}>🔑 IID</button>}
          {hasTabAccess(role, 'discord') && <button type="button" className={`mt-tab${tab === 'discord' ? ' active' : ''}`} onClick={() => setTab('discord')}>Discord</button>}
          {hasTabAccess(role, 'iidhistory') && <button type="button" className={`mt-tab${tab === 'iidhistory' ? ' active' : ''}`} onClick={() => setTab('iidhistory')}>🕵️ IID History</button>}
          {hasTabAccess(role, 'owner') && <button type="button" className={`mt-tab owner-tab-btn${tab === 'owner' ? ' active' : ''}`} onClick={() => setTab('owner')}>👑 Owner</button>}
          {hasTabAccess(role, 'admin') && <button type="button" className={`mt-tab void-tab-btn${tab === 'admin' ? ' active' : ''}`} onClick={() => setTab('admin')}>⚙️ Admin</button>}
          {hasTabAccess(role, 'logs') && <button type="button" className={`mt-tab${tab === 'logs' ? ' active' : ''}`} onClick={() => setTab('logs')}>📋 Logs</button>}
        </div>
        {tab === 'canvas' && hasTabAccess(role, 'canvas') && (
          <CanvasTab canvasRef={canvasRef} canvasSize={canvasSize} canvasId={canvasId} configs={configs} />
        )}
        {tab === 'factions' && hasTabAccess(role, 'factions') && <FactionsTab configs={configs} />}
        {tab === 'canvases' && hasTabAccess(role, 'canvases') && <CanvasesTab />}
        {tab === 'icons' && hasTabAccess(role, 'icons') && <IconsTab key={iconVer} onIconsChange={() => setIconVer(v => v + 1)} />}
        {tab === 'cosmetics' && hasTabAccess(role, 'cosmetics') && <CosmeticsTab />}
        {tab === 'users' && hasTabAccess(role, 'users') && <UsersTab currentUser={currentUser} />}
        {tab === 'lookup' && hasTabAccess(role, 'lookup') && <UserLookupTab />}
        {tab === 'watch' && hasTabAccess(role, 'watch') && <WatchTab canvasRef={canvasRef} canvasSize={canvasSize} canvasId={canvasId} configs={configs} />}
        {tab === 'alts' && hasTabAccess(role, 'alts') && <AltsTab />}
        {tab === 'iidlookup' && hasTabAccess(role, 'iidlookup') && <IidLookupTab />}
        {tab === 'discord' && hasTabAccess(role, 'discord') && <DiscordLookupTab />}
        {tab === 'iidhistory' && hasTabAccess(role, 'iidhistory') && <IidHistoryTab />}
        {tab === 'owner' && hasTabAccess(role, 'owner') && <OwnerToolsTab />}
        {tab === 'admin' && hasTabAccess(role, 'admin') && <AdminTab />}
        {tab === 'logs' && hasTabAccess(role, 'logs') && <LogsTab />}
      </div>
    </div>
  </ModtoolsContext.Provider>
)
}

