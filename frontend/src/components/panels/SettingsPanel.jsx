import { useState, useEffect } from 'react'
import PanelHeader from '../PanelHeader.jsx'
import { applyTheme, getStoredTheme } from '../../theme.js'

const BRUSH_SIZES_BASE  = [1, 3, 5]
const BRUSH_SIZES_STAFF = [1, 3, 5, 7, 9, 11]

export default function SettingsPanel({
  brushSize, onBrushSize,
  pencilMode, onPencilModeChange,
  gridEnabled, onGridChange,
  smoothPlacing, onSmoothPlacingChange,
  allowInvites, onAllowInvitesChange,
  showInSearch, onShowInSearchChange,
  smallPixelsEnabled, onSmallPixelsChange,
  histEnabled, historyMode, onHistoryModeChange,
  currentUser,
  onClose
}) {
  const isStaff = (currentUser?.role ?? 0) >= 100
  const BRUSH_SIZES = isStaff ? BRUSH_SIZES_STAFF : BRUSH_SIZES_BASE
  const [sound, setSound] = useState(() => localStorage.getItem('pixmap:sound') !== 'false')
  const [theme, setTheme] = useState(() => getStoredTheme())

  useEffect(() => {
    const handler = e => setSound(e.detail)
    window.addEventListener('pixmap:sound', handler)
    return () => window.removeEventListener('pixmap:sound', handler)
  }, [])

  function toggleSound() {
    const next = !sound
    setSound(next)
    localStorage.setItem('pixmap:sound', String(next))
    window.dispatchEvent(new CustomEvent('pixmap:sound', { detail: next }))
  }

  function handleThemeChange(next) {
    setTheme(applyTheme(next))
  }

  return (
    <div id="panel-settings" className="panel">
      <PanelHeader title="Settings" panelId="panel-settings" onClose={onClose} />
      <div className="panel-body">
        <h3>User Interface</h3>
        <div className="settings-row">
          <span>Theme</span>
          <select
            className="settings-select"
            value={theme}
            onChange={e => handleThemeChange(e.target.value)}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
        <div className="settings-row">
          <span>Canvas Grid (G)</span>
          <button className={`toggle-btn ${gridEnabled ? 'on' : ''}`} onClick={() => onGridChange(!gridEnabled)}>
            {gridEnabled ? 'On' : 'Off'}
          </button>
        </div>
        <div className="settings-row">
          <span>Smooth Placing</span>
          <button className={`toggle-btn ${smoothPlacing ? 'on' : ''}`} onClick={() => onSmoothPlacingChange(!smoothPlacing)}>
            {smoothPlacing ? 'On' : 'Off'}
          </button>
        </div>

        <div className="settings-row">
          <span>Show Pixel Notifications (X)</span>
          <button className={`toggle-btn ${smallPixelsEnabled ? 'on' : ''}`} onClick={() => onSmallPixelsChange(!smallPixelsEnabled)}>
            {smallPixelsEnabled ? 'On' : 'Off'}
          </button>
        </div>
        {histEnabled && (
          <div className="settings-row">
            <span>History Mode (H)</span>
            <button className={`toggle-btn ${historyMode ? 'on' : ''}`} onClick={() => onHistoryModeChange(!historyMode)}>
              {historyMode ? 'On' : 'Off'}
            </button>
          </div>
        )}

        <h3>Faction Privacy Settings</h3>
        <div className="settings-row">
          <span>Allow Faction Invites</span>
          <button className={`toggle-btn ${allowInvites ? 'on' : ''}`} onClick={() => onAllowInvitesChange(!allowInvites)}>
            {allowInvites ? 'Allow' : 'Block'}
          </button>
        </div>
        <div className="settings-row">
          <span>Show in Invite Search</span>
          <button className={`toggle-btn ${showInSearch ? 'on' : ''}`} onClick={() => onShowInSearchChange(!showInSearch)}>
            {showInSearch ? 'Visible' : 'Hidden'}
          </button>
        </div>
        <div className="settings-row">
          <span>Pencil Mode</span>
          <select
            className="settings-select"
            value={pencilMode}
            onChange={e => onPencilModeChange(e.target.value)}
          >
            <option value="color">From Palette 🖌️</option>
            <option value="template">From Template 🎨</option>
            <option value="history">From History 🕒</option>
          </select>
        </div>

        <h3>Audio</h3>
        <div className="settings-row">
          <span>Sound effects (M)</span>
          <button className={`toggle-btn ${sound ? 'on' : ''}`} onClick={toggleSound}>
            {sound ? 'On' : 'Off'}
          </button>
        </div>

        <h3>Brush size (B)</h3>
        <div className="brush-size-grid">
          {BRUSH_SIZES.map(sz => (
            <button
              key={sz}
              className={`brush-opt${brushSize === sz ? ' active' : ''}`}
              onClick={() => onBrushSize(sz)}
              title={`${sz}×${sz} brush`}
            >
              <div className="brush-preview" style={{ gridTemplateColumns: `repeat(${sz}, 1fr)` }}>
                {Array.from({ length: sz * sz }).map((_, i) => <div key={i} className="brush-dot" />)}
              </div>
              <span>{sz}×{sz}</span>
            </button>
          ))}
        </div>

        <h3>About</h3>
        <p>Brush size controls how many pixels are painted per click. Larger brushes consume more cooldown stack.</p>
      </div>
    </div>
  )
}