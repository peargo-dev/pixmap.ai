import { useEffect, useRef, useState } from 'react'
import { formatRemainingCooldown } from '../lib/cooldownFormat.js'
import { playCooldownEnd } from '../lib/sounds.js'

export function useCooldownRemaining() {
  const cdEndRef = useRef(0)
  const wasActiveRef = useRef(false)
  const [state, setState] = useState({ label: '', active: false })

  useEffect(() => {
    function sync() {
      const rem = Math.max(0, cdEndRef.current - Date.now())
      const active = rem > 0
      if (wasActiveRef.current && !active) {
        playCooldownEnd()
      }
      wasActiveRef.current = active
      setState({
        label: rem > 0 ? formatRemainingCooldown(rem) : '',
        active,
      })
    }

    const onCooldown = (e) => {
      const remaining_ms = e.detail.remaining_ms ?? e.detail.remaining ?? 0
      cdEndRef.current = remaining_ms > 0 ? Date.now() + remaining_ms : 0
      sync()
    }

    window.addEventListener('pixmap:cooldown', onCooldown)
    const interval = setInterval(sync, 1000)
    sync()

    return () => {
      window.removeEventListener('pixmap:cooldown', onCooldown)
      clearInterval(interval)
    }
  }, [])

  return state
}
