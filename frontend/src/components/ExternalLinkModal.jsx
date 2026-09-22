import { useState, useEffect } from 'react'

function truncateUrl(url, max = 80) {
  if (!url || url.length <= max) return url
  return `${url.slice(0, max - 1)}…`
}

export default function ExternalLinkModal({ url, onClose }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (url) setVisible(true)
  }, [url])

  useEffect(() => {
    if (!url) return
    function onKeyDown(e) {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [url])

  function handleClose() {
    setVisible(false)
    setTimeout(() => onClose?.(), 150)
  }

  function handleOpen() {
    window.open(url, '_blank', 'noopener,noreferrer')
    handleClose()
  }

  if (!url && !visible) return null
  if (!url) return null

  return (
    <div
      className="external-link-overlay"
      onClick={e => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div className="external-link-card">
        <div className="external-link-header">
          <span className="external-link-badge">External link</span>
          <button type="button" className="panel-close" onClick={handleClose} aria-label="Close">✕</button>
        </div>

        <div className="external-link-body">
          <h2 className="external-link-title">Leaving pixmap.fun</h2>
          <p className="external-link-subtitle">
            This link goes to an external site. Only follow links you trust.
          </p>
          <div className="external-link-url" title={url}>
            {truncateUrl(url)}
          </div>
        </div>

        <div className="external-link-footer">
          <button type="button" className="mt-btn secondary" onClick={handleClose}>
            Cancel
          </button>
          <button type="button" className="mt-btn primary" onClick={handleOpen}>
            Open link
          </button>
        </div>
      </div>
    </div>
  )
}
