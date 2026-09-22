import { useState, useEffect } from 'react'
import { playSelectColor } from '../lib/sounds.js'

export default function Palette({ colors, onSelect, modColorCount = 0, isMod = false, initialColor }) {
  const defaultColor = initialColor ?? (isMod ? 0 : modColorCount)
  const [selected, setSelected] = useState(defaultColor)

  useEffect(() => {
    const handler = e => setSelected(e.detail)
    window.addEventListener('pixmap:select-color', handler)
    return () => window.removeEventListener('pixmap:select-color', handler)
  }, [])

  useEffect(() => {
    if (initialColor == null) return
    setSelected(initialColor)
  }, [initialColor])

  function pick(idx) {
    setSelected(idx)
    onSelect(idx)
    playSelectColor()
  }

  const visibleColors = isMod ? colors : colors.slice(modColorCount)
  const indexOffset   = isMod ? 0 : modColorCount

  return (
    <div id="palette-wrap">
      <div id="palette-colors">
        {visibleColors.map((rgb, i) => {
          const realIdx = i + indexOffset
          const isModColor = realIdx < modColorCount
          return (
            <button
              key={realIdx}
              className={`swatch${isModColor ? ' mod-swatch' : ''}${selected === realIdx ? ' active' : ''}`}
              style={{ background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` }}
              onClick={() => pick(realIdx)}
            />
          )
        })}
      </div>
    </div>
  )
}
