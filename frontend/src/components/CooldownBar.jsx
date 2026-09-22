import { useEffect, useRef, useState } from 'react'
import { formatPixelCooldownMs, formatErrorWaitMs, cooldownWaitMs } from '../lib/cooldownFormat.js'

export default function CooldownBar({ placeReturn, topLabel, topActive }) {
  const [bottomLabel, setBottomLabel] = useState('')
  const [bottomActive, setBottomActive] = useState(false)
  const [bottomFail, setBottomFail] = useState(false)
  const hideTimerRef = useRef(null)

  useEffect(() => {
    if (!placeReturn) return

    const placed = Number(placeReturn.placed_pixels) || 0
    const { max_cooldown_ms, new_cooldown_ms, stack_ms } = placeReturn

    if (placed === 0) {
      setBottomLabel(formatErrorWaitMs(cooldownWaitMs(new_cooldown_ms, max_cooldown_ms, stack_ms)))
      setBottomFail(true)
    } else {
      setBottomLabel(formatPixelCooldownMs(max_cooldown_ms))
      setBottomFail(false)
    }

    setBottomActive(true)
    clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setBottomActive(false), 2000)
  }, [placeReturn?.id])

  useEffect(() => () => clearTimeout(hideTimerRef.current), [])

  return (
    <div id="cooldown-wrap">
      <div id="cooldown-top" className={topActive ? 'active' : ''}>{topLabel}</div>
      <div
        id="cooldown-bottom"
        className={`${bottomFail ? 'fail' : 'ok'}${bottomActive ? ' active' : ''}`.trim()}
      >
        {bottomLabel}
      </div>
    </div>
  )
}
