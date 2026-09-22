import { useEffect, useRef } from 'react'
import socket from '../lib/ws.js'

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY

export default function TurnstileModal({ open, onVerified }) {
  const containerRef = useRef(null)
  const widgetId = useRef(null)

  useEffect(() => {
    if (!open) {
      // Clean up widget when modal closes
      if (widgetId.current !== null && window.turnstile) {
        try { window.turnstile.remove(widgetId.current) } catch { }
        widgetId.current = null
      }
      return
    }

    // Poll until turnstile script is ready
    const interval = setInterval(() => {
      if (window.turnstile && containerRef.current) {
        clearInterval(interval)
        widgetId.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          theme: 'dark',
          callback: async (token) => {
            const success = await socket.sendCaptcha(token)
            if (success) {
              onVerified()
            } else if (widgetId.current !== null && window.turnstile) {
              window.turnstile.reset(widgetId.current)
            }
          },
          'error-callback': () => {
            if (widgetId.current !== null && window.turnstile) {
              window.turnstile.reset(widgetId.current)
            }
          },
        })
      }
    }, 100)

    return () => clearInterval(interval)
  }, [open])

  if (!open) return null

  return (
    <div className="turnstile-overlay" role="dialog" aria-modal="true">
      <div className="turnstile-card">
        <div className="turnstile-icon">
          <svg viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="22" stroke="url(#tg)" strokeWidth="2.5" />
            <path d="M15 24l6 6 12-12" stroke="url(#tg2)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <defs>
              <linearGradient id="tg" x1="2" y1="2" x2="46" y2="46">
                <stop stopColor="#a78bfa" /><stop offset="1" stopColor="#60a5fa" />
              </linearGradient>
              <linearGradient id="tg2" x1="15" y1="18" x2="27" y2="30">
                <stop stopColor="#a78bfa" /><stop offset="1" stopColor="#60a5fa" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <h3 className="turnstile-title">Verify you're human</h3>
        <p className="turnstile-sub">Complete the challenge below to place pixels.<br />Your pass lasts <strong>30 minutes</strong>.</p>
        <div ref={containerRef} className="turnstile-widget" />
      </div>
    </div>
  )
}
