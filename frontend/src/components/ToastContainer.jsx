import { useState, useEffect, useRef } from 'react'

export default function ToastContainer() {
  const [toast, setToast] = useState(null)
  const dismissTimer = useRef(null)
  const exitTimer = useRef(null)
  const activeDedup = useRef(null)

  useEffect(() => {
    const clearTimers = () => {
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current)
        dismissTimer.current = null
      }
      if (exitTimer.current) {
        clearTimeout(exitTimer.current)
        exitTimer.current = null
      }
    }

    const scheduleDismiss = () => {
      dismissTimer.current = setTimeout(() => {
        setToast(prev => (prev ? { ...prev, out: true } : null))
        exitTimer.current = setTimeout(() => {
          setToast(null)
          activeDedup.current = null
        }, 400)
      }, 2500)
    }

    const handler = (e) => {
      const { msg, type, dedup } = e.detail

      if (dedup && activeDedup.current === dedup) return

      clearTimers()
      activeDedup.current = dedup ?? null
      setToast({ msg, type, out: false })
      scheduleDismiss()
    }

    window.addEventListener('pixmap:toast', handler)
    return () => {
      window.removeEventListener('pixmap:toast', handler)
      clearTimers()
    }
  }, [])

  return (
    <div id="alert-container">
      {toast && (
        <div className={`toast ${toast.type}${toast.out ? ' out' : ''}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
