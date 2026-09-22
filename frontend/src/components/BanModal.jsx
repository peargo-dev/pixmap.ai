import { useState, useEffect } from 'react'

function formatExpiry(expiresAt, isPermanent) {
  if (isPermanent) return 'Permanent'
  if (!expiresAt) return 'Permanent'
  const d = new Date(expiresAt)
  const now = new Date()
  const diffMs = d - now
  if (diffMs <= 0) return 'Expired'
  const diffDays = Math.floor(diffMs / 86400000)
  const diffHours = Math.floor((diffMs % 86400000) / 3600000)
  const diffMins = Math.floor((diffMs % 3600000) / 60000)
  if (diffDays > 1) return `${diffDays} days remaining (until ${d.toLocaleDateString()})`
  if (diffDays === 1) return `1 day remaining (until ${d.toLocaleDateString()})`
  if (diffHours > 0) return `${diffHours}h ${diffMins}m remaining`
  return `${diffMins} minutes remaining`
}

function formatBannedAt(bannedAt) {
  if (!bannedAt) return ''
  const d = new Date(bannedAt)
  return d.toLocaleString()
}

export default function BanModal({ open, banInfo, onClose }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (open) {
      setVisible(true)
    }
  }, [open])

  function handleClose() {
    setVisible(false)
    setTimeout(() => onClose?.(), 200)
  }

  if (!open && !visible) return null
  if (!banInfo) return null

  const isActive = open

  return (
    <div
      className="ban-overlay"
      style={{ opacity: isActive ? 1 : 0, transition: 'opacity 0.2s' }}
      onClick={e => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div
        className="ban-card"
        style={{
          transform: isActive ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.97)',
          transition: 'transform 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s',
          opacity: isActive ? 1 : 0,
        }}
      >
        <div className="ban-icon-wrap">
          <div className="ban-icon-ring">
            <svg width="38" height="38" viewBox="0 0 38 38" fill="none">
              <circle cx="19" cy="19" r="17" stroke="url(#bg1)" strokeWidth="2.5" />
              <path d="M19 11v9" stroke="url(#bg1)" strokeWidth="2.5" strokeLinecap="round" />
              <circle cx="19" cy="27" r="1.5" fill="url(#bg1)" />
              <defs>
                <linearGradient id="bg1" x1="2" y1="2" x2="36" y2="36">
                  <stop stopColor="#ff6b6b" />
                  <stop offset="1" stopColor="#ff4444" />
                </linearGradient>
              </defs>
            </svg>
          </div>
        </div>

        <h2 className="ban-title">You are banned</h2>
        <p className="ban-subtitle">Pixel placement is restricted on your account.</p>

        <div className="ban-details">
          <div className="ban-row">
            <span className="ban-label">Reason</span>
            <span className="ban-value">{banInfo.reason || 'No reason provided'}</span>
          </div>
          <div className="ban-row">
            <span className="ban-label">Duration</span>
            <span className={`ban-value ${banInfo.is_permanent ? 'ban-permanent' : ''}`}>
              {formatExpiry(banInfo.expires_at, banInfo.is_permanent)}
            </span>
          </div>
          <div className="ban-row">
            <span className="ban-label">Banned by</span>
            <span className="ban-value ban-mod">{banInfo.mod_username || 'System'}</span>
          </div>
          {banInfo.banned_at && (
            <div className="ban-row">
              <span className="ban-label">Banned on</span>
              <span className="ban-value ban-date">{formatBannedAt(banInfo.banned_at)}</span>
            </div>
          )}
        </div>

        <button className="ban-close-btn" onClick={handleClose}>
          Close
        </button>
      </div>
    </div>
  )
}
