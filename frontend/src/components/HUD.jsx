import { useState, useRef, useEffect } from 'react'
import VoidBar from './VoidBar.jsx'
import CoordsDisplay from './CoordsDisplay.jsx'
import { detectTouchDevice } from '../lib/isMobile.js'

const ROLE_MOD   = 100
const ROLE_ADMIN = 200
const BRUSH_CYCLE = [1, 3, 5]
const PENCIL_HOLD_MS = 400

const PENCIL_MODE_LABEL = {
  color: 'Palette',
  template: 'Template',
  history: 'History',
}

const PENCIL_MODE_TOAST = {
  color: 'COLOR',
  template: 'TEMPLATE',
  history: 'HISTORY',
}

function showPencilToast(msg) {
  window.dispatchEvent(new CustomEvent('pixmap:toast', { detail: { msg, type: 'info' } }))
}

export default function HUD({
  canvasName, canvasId, configs, canvasSize,
  online, wsConnected, canvasRef, centerRef, canvasReady, coordsError, onCoordsChange, currentUser,
  pixelCount, dailyPixelCount, showDailyPixels, onTogglePixelDisplay,
  activePanel, onTogglePanel,
  brushSize, onBrushSizeChange,
  pencilMode, onPencilModeChange,
  onSwitchCanvas,
  showPalette, onTogglePalette,
  mobilePencilEnabled, onMobilePencilToggle,
  voidState,
  historyMode,
  defaultCanvasId,
  onDownloadViewport,
  mentionNotification,
  onMentionToastClick,
  onMentionToastDismiss,
}) {
  const isMod   = (currentUser?.role ?? 0) >= ROLE_MOD
  const isAdmin = (currentUser?.role ?? 0) >= ROLE_ADMIN

  const [canvasOpen, setCanvasOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isMobile, setIsMobile] = useState(detectTouchDevice)
  const [activeNav, setActiveNav] = useState(null)
  const dropRef = useRef(null)
  const pencilHoldRef = useRef({ timer: null, held: false })
  const navHoldRef = useRef(null)

  useEffect(() => {
    if (isMobile) return undefined
    const onTouch = () => setIsMobile(true)
    window.addEventListener('touchstart', onTouch, { passive: true })
    return () => window.removeEventListener('touchstart', onTouch)
  }, [isMobile])

  useEffect(() => {
    function endNavHold() {
      const active = navHoldRef.current
      if (!active) return
      active.onRelease()
      navHoldRef.current = null
      setActiveNav(null)
    }
    window.addEventListener('pointerup', endNavHold)
    window.addEventListener('pointercancel', endNavHold)
    return () => {
      window.removeEventListener('pointerup', endNavHold)
      window.removeEventListener('pointercancel', endNavHold)
    }
  }, [])

  function navHoldProps(id, onHold, onRelease, className = '') {
    return {
      className: `uibtn actionbtn ${className}${activeNav === id ? ' active' : ''}`.trim(),
      style: { touchAction: 'none' },
      onPointerDown: e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        if (navHoldRef.current) navHoldRef.current.onRelease()
        navHoldRef.current = { id, onRelease }
        setActiveNav(id)
        onHold()
      },
    }
  }

  function cycleBrush() {
    const idx = BRUSH_CYCLE.indexOf(brushSize)
    const next = BRUSH_CYCLE[(idx + 1) % BRUSH_CYCLE.length]
    onBrushSizeChange?.(next)
  }

  function cyclePencilMode() {
    const next = pencilMode === 'color' ? 'template' : pencilMode === 'template' ? 'history' : 'color'
    onPencilModeChange?.(next)
    showPencilToast(`Pencil mode set to ${PENCIL_MODE_TOAST[next]}`)
  }

  function togglePencilDraw() {
    const next = !mobilePencilEnabled
    onMobilePencilToggle?.()
    showPencilToast(`Pencil turned ${next ? 'ON' : 'OFF'}`)
  }

  function clearPencilHold() {
    if (pencilHoldRef.current.timer) {
      clearTimeout(pencilHoldRef.current.timer)
      pencilHoldRef.current.timer = null
    }
  }

  function onPencilPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    clearPencilHold()
    pencilHoldRef.current.held = false
    pencilHoldRef.current.timer = setTimeout(() => {
      pencilHoldRef.current.held = true
      pencilHoldRef.current.timer = null
    }, PENCIL_HOLD_MS)
  }

  function onPencilPointerUp(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    clearPencilHold()
    const wasHeld = pencilHoldRef.current.held
    pencilHoldRef.current.held = false
    e.preventDefault()
    if (wasHeld) {
      cyclePencilMode()
    } else {
      togglePencilDraw()
    }
  }

  function onPencilPointerCancel() {
    clearPencilHold()
    pencilHoldRef.current.held = false
  }

  useEffect(() => {
    if (!canvasOpen) return
    function handler(e) {
      if (!dropRef.current?.contains(e.target)) setCanvasOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [canvasOpen])

  const canvasList = configs ? Object.entries(configs) : []
  const pencilModeClass = mobilePencilEnabled
    ? ` pencil-on-mode-${pencilMode}`
    : ` pencil-off-mode-${pencilMode}`

  return (
    <>
      {/* Void event health bar */}
      <VoidBar voidState={voidState} canvasSize={canvasSize} defaultCanvasId={defaultCanvasId} />
      {/* Top-left: logo + canvas switcher */}
      <div id="top-bar">
        <div id="logo-btn" className="uibtn logo-favicon-btn" title="pixmap.fun">
          <img src="/favicon.webp" alt="pixmap" className="logo-favicon" />
        </div>

        <div id="canvas-switch-wrap" ref={dropRef}>
          <button
            id="canvas-name-btn"
            className={`uibtn canvas-switch-btn${canvasOpen ? ' open' : ''}`}
            title="Switch canvas"
            onClick={() => setCanvasOpen(o => !o)}
          >
            <span id="canvas-name">{canvasName || '—'}</span>
            <svg className="canvas-switch-arrow" viewBox="0 0 10 6" fill="none"
                 stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1 1l4 4 4-4"/>
            </svg>
          </button>

          {canvasOpen && (
            <div className="canvas-dropdown">
              {canvasList.map(([id, cfg]) => (
                <button
                  key={id}
                  className={`canvas-drop-item${Number(id) === canvasId ? ' active' : ''}`}
                  onClick={() => { setCanvasOpen(false); if (Number(id) !== canvasId) onSwitchCanvas?.(Number(id)) }}
                >
                  <span className="canvas-drop-name">{cfg.name}</span>
                  {cfg.description && <span className="canvas-drop-desc">{cfg.description}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {!historyMode && (
        <div id="left-sidebar">
          {!sidebarCollapsed && (
            <>
              <button id="btn-user" className="uibtn actionbtn" title="Account"
                      onClick={() => onTogglePanel('user')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </button>
              {isMod && (
                <button id="btn-modtools" className="uibtn actionbtn"
                        title={isAdmin ? 'Admin / Mod Tools' : 'Mod Tools'}
                        onClick={() => onTogglePanel('modtools')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </button>
              )}

              <button id="btn-help" className="uibtn actionbtn" title="Help"
                      onClick={() => onTogglePanel('help')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                  <circle cx="12" cy="17" r="0.5" fill="currentColor"/>
                </svg>
              </button>

              <button id="btn-stats" className="uibtn actionbtn" title="Stats &amp; Leaderboard"
                      onClick={() => onTogglePanel('stats')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="20" x2="18" y2="10"/>
                  <line x1="12" y1="20" x2="12" y2="4"/>
                  <line x1="6"  y1="20" x2="6"  y2="14"/>
                </svg>
              </button>

              <button id="btn-settings" className="uibtn actionbtn" title="Settings"
                      onClick={() => onTogglePanel('settings')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>

              <button id="btn-download" className="uibtn actionbtn" title="Download Canvas Viewport"
                      onClick={onDownloadViewport}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>

              <button id="btn-factions" className="uibtn actionbtn" title="Factions"
                      onClick={() => onTogglePanel('factions')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </button>

              <button id="btn-templates" className="uibtn actionbtn" title="Template Overlays"
                      onClick={() => onTogglePanel('templates')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>
                </svg>
              </button>
            </>
          )}

          {/* Collapse / expand arrow */}
          <button
            id="btn-sidebar-toggle"
            className="uibtn actionbtn sidebar-collapse-btn"
            title={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
            onClick={() => setSidebarCollapsed(c => !c)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                 style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
              <path d="M18 15l-6-6-6 6"/>
            </svg>
          </button>
        </div>
      )}

      {/* Status indicators — always visible */}
      {!historyMode && (
        <>
          {isMobile && (
            <div id="mobile-nav-controls">
              <button
                type="button"
                title="Zoom out (Q)"
                aria-label="Zoom out"
                {...navHoldProps('zoom-out',
                  () => canvasRef.current?.setZoomHeld?.('q', true, { center: true }),
                  () => canvasRef.current?.setZoomHeld?.('q', false, { center: true }),
                  'nav-zoom-out')}
              >
                −
              </button>

              <button
                type="button"
                title="Pan up (W)"
                aria-label="Pan up"
                {...navHoldProps('up',
                  () => canvasRef.current?.setPanHeld?.('ArrowUp', true),
                  () => canvasRef.current?.setPanHeld?.('ArrowUp', false),
                  'nav-up')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>
                </svg>
              </button>

              <button
                type="button"
                title="Zoom in (E)"
                aria-label="Zoom in"
                {...navHoldProps('zoom-in',
                  () => canvasRef.current?.setZoomHeld?.('e', true, { center: true }),
                  () => canvasRef.current?.setZoomHeld?.('e', false, { center: true }),
                  'nav-zoom-in')}
              >
                +
              </button>

              <button
                type="button"
                title="Pan left (A)"
                aria-label="Pan left"
                {...navHoldProps('left',
                  () => canvasRef.current?.setPanHeld?.('ArrowLeft', true),
                  () => canvasRef.current?.setPanHeld?.('ArrowLeft', false),
                  'nav-left')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>
                </svg>
              </button>

              <button
                type="button"
                title="Pan down (S)"
                aria-label="Pan down"
                {...navHoldProps('down',
                  () => canvasRef.current?.setPanHeld?.('ArrowDown', true),
                  () => canvasRef.current?.setPanHeld?.('ArrowDown', false),
                  'nav-down')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>
                </svg>
              </button>

              <button
                type="button"
                title="Pan right (D)"
                aria-label="Pan right"
                {...navHoldProps('right',
                  () => canvasRef.current?.setPanHeld?.('ArrowRight', true),
                  () => canvasRef.current?.setPanHeld?.('ArrowRight', false),
                  'nav-right')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
                </svg>
              </button>
            </div>
          )}

          <div id="online-box" className="uibtn" title={wsConnected ? 'Players online · Your pixels placed' : 'Reconnecting… live updates unavailable'}>
            <span className={`dot${wsConnected ? '' : ' offline'}`}/>
            <span id="online-num">{wsConnected ? online.toLocaleString() : '—'}</span>
            {currentUser && pixelCount !== null && (
              <>
                <span className="online-sep">·</span>
                <span
                  id="pixel-count-hud"
                  title={showDailyPixels ? 'Daily pixels — click for total' : 'Total pixels — click for daily'}
                  onClick={onTogglePixelDisplay}
                >
                  {(showDailyPixels ? dailyPixelCount : pixelCount)?.toLocaleString()} px
                </span>
              </>
            )}
          </div>

          <CoordsDisplay
            canvasRef={canvasRef}
            centerRef={centerRef}
            canvasReady={canvasReady}
            historyMode={false}
            onCoordsChange={onCoordsChange}
            canvasIndent={configs?.[canvasId]?.indent}
          />

          {/* Action buttons — bottom-right horizontal bar */}
          <div id="bottom-right-bar">
            <button id="btn-pencil"
                    className={`uibtn actionbtn${pencilModeClass}`}
                    title={`Pencil draw: ${mobilePencilEnabled ? 'on' : 'off'} · Mode: ${PENCIL_MODE_LABEL[pencilMode] ?? pencilMode} (press: toggle draw, hold: change mode)`}
                    onClick={e => e.preventDefault()}
                    onPointerDown={onPencilPointerDown}
                    onPointerUp={onPencilPointerUp}
                    onPointerCancel={onPencilPointerCancel}
                    style={{ touchAction: 'manipulation' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/>
                <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>
              </svg>
            </button>

            <button id="btn-brush" className="uibtn actionbtn"
                    title={`Brush: ${brushSize}×${brushSize} (click to cycle)`}
                    onClick={cycleBrush}>
              <span id="brush-label">{brushSize}×{brushSize}</span>
            </button>

            <div className="chat-btn-wrap">
              {mentionNotification && (
                <div className="chat-mention-toast" onClick={onMentionToastClick}>
                  <span className="chat-mention-toast-icon">💬</span>
                  <div className="chat-mention-toast-body">
                    <span className="chat-mention-toast-title">You got mentioned!</span>
                    <span className="chat-mention-toast-from">{mentionNotification.from}</span>
                  </div>
                  <button
                    className="chat-mention-toast-close"
                    onClick={e => { e.stopPropagation(); onMentionToastDismiss && onMentionToastDismiss() }}
                  >✕</button>
                </div>
              )}
              <button id="btn-chat" className="uibtn actionbtn" title="Chat"
                      onClick={() => onTogglePanel('chat')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </button>
            </div>

            <button id="btn-palette"
                    className={`uibtn actionbtn${showPalette ? ' active' : ''}`}
                    title={showPalette ? 'Hide palette' : 'Show palette'}
                    onClick={onTogglePalette}>
              <svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
                <path d="M464 258.2c0 2.7-1 5.2-4.2 8-3.8 3.1-10.1 5.8-17.8 5.8L344 272c-53 0-96 43-96 96 0 6.8 .7 13.4 2.1 19.8 3.3 15.7 10.2 31.1 14.4 40.6l0 0c.7 1.6 1.4 3 1.9 4.3 5 11.5 5.6 15.4 5.6 17.1 0 5.3-1.9 9.5-3.8 11.8-.9 1.1-1.6 1.6-2 1.8-.3 .2-.8 .3-1.6 .4-2.9 .1-5.7 .2-8.6 .2-114.9 0-208-93.1-208-208S141.1 48 256 48 464 141.1 464 256c0 .7 0 1.4 0 2.2zm48 .5c0-.9 0-1.8 0-2.7 0-141.4-114.6-256-256-256S0 114.6 0 256 114.6 512 256 512c3.5 0 7.1-.1 10.6-.2 31.8-1.3 53.4-30.1 53.4-62 0-14.5-6.1-28.3-12.1-42-4.3-9.8-8.7-19.7-10.8-29.9-.7-3.2-1-6.5-1-9.9 0-26.5 21.5-48 48-48l97.9 0c36.5 0 69.7-24.8 70.1-61.3zM160 256a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zm0-64a32 32 0 1 0 0-64 32 32 0 1 0 0 64zm128-64a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zm64 64a32 32 0 1 0 0-64 32 32 0 1 0 0 64z"/>
              </svg>
            </button>
          </div>
        </>
      )}

      {historyMode && (
        <CoordsDisplay
          canvasRef={canvasRef}
          centerRef={centerRef}
          canvasReady={canvasReady}
          historyMode
        />
      )}

      {coordsError && (
        <div id="coords-box" className="uibtn" style={{ opacity: 0.7 }}>
          <span id="coords">{coordsError}</span>
        </div>
      )}
    </>
  )
}