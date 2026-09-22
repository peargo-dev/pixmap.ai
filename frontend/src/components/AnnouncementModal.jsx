import { useState, useEffect } from 'react'
import ChatMessageText from './ChatMessageText'
import { getAvatarUrl } from '../lib/avatar.js'

export default function AnnouncementModal({ announcement, onClose }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (announcement) {
      setVisible(true)
    }
  }, [announcement])

  function handleClose() {
    setVisible(false)
    setTimeout(() => onClose?.(), 150)
  }

  if (!announcement && !visible) return null
  if (!announcement) return null

  const { userId, username, avatar, discord_id, role, message, x, y, canvas_id } = announcement

  const avatarUrl = getAvatarUrl({ avatar, discord_id }, 64)

  const isWarning = username?.includes('WARNING') || announcement.isWarning
  const isFaction = username?.includes('Faction') || announcement.isFaction

  const badgeText = isWarning ? '⚠️ FACTION WARNING' : isFaction ? '🛡️ FACTION ANNOUNCEMENT' : '📢 ANNOUNCEMENT'
  const roleName = role >= 254 ? 'Owner' : role >= 200 ? 'Admin' : role >= 150 ? 'Moderator' : role >= 100 ? 'Trial Mod' : role != null ? 'Player' : null
  const roleColorClass = role >= 254 ? 'role-owner' : role >= 200 ? 'role-admin' : 'role-mod'

  return (
    <div
      className="announcement-overlay"
      onClick={e => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div className="announcement-card" style={isWarning ? { borderColor: '#ff4444' } : {}}>
        <div className="announcement-header">
          <div className="announcement-header-left">
            <span className="announcement-badge" style={isWarning ? { background: 'rgba(255,68,68,0.2)', color: '#ff6666' } : {}}>{badgeText}</span>
          </div>
          <button type="button" className="panel-close" onClick={handleClose} aria-label="Close">✕</button>
        </div>

        <div className="announcement-body">
          <div className="announcement-author-row">
            <img className="announcement-avatar" src={avatarUrl} alt="" />
            <div className="announcement-author-info">
              <div className="announcement-author-top">
                <span className="announcement-username">{username || 'Announcement'}</span>
                {roleName && <span className={`role-badge ${roleColorClass}`}>{roleName}</span>}
              </div>
              {userId != null && <span className="announcement-user-id">#{userId}</span>}
            </div>
          </div>

          <div className="announcement-message">
            <ChatMessageText text={message} />
          </div>

          {x != null && y != null && (
            <div style={{ marginTop: '10px' }}>
              <button
                type="button"
                className="mt-btn secondary btn-compact"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('pixmap:navigate', { detail: { x: Number(x), y: Number(y), canvasId: canvas_id != null ? Number(canvas_id) : undefined, zoom: 35 } }))
                  handleClose()
                }}
              >
                🎯 Go to Coordinates ({x}, {y})
              </button>
            </div>
          )}
        </div>

        <div className="announcement-footer">
          <button type="button" className="mt-btn primary" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
