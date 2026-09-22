import { useState, useEffect, useRef } from 'react'

function dayFromTs(ts) {
  const d = new Date(ts * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
}

export { dayFromTs }

export default function HistoryBar({ ts, selectedDay, onDayChange, onTs, onClose, canvasId }) {
  const [days, setDays] = useState([])
  const [snapshots, setSnapshots] = useState([]) // [{ ts, hhmm }, ...]
  const [loading, setLoading] = useState(true)
  const targetSnapIndexRef = useRef(null) // "first" or "last"

  // Fetch available days on mount / canvas change
  useEffect(() => {
    if (canvasId == null) return
    setLoading(true)
    fetch(`/history/snapshots/${canvasId}`)
      .then(r => r.ok ? r.json() : { days: [] })
      .then(d => {
        const incoming = d.days || []
        setDays(incoming)
        if (incoming.length > 0) {
          const preferred = selectedDay && incoming.includes(selectedDay)
            ? selectedDay
            : (ts ? dayFromTs(ts) : null)
          const day = preferred && incoming.includes(preferred)
            ? preferred
            : incoming[incoming.length - 1]
          if (day !== selectedDay) onDayChange(day)
        }
      })
      .catch(() => setDays([]))
      .finally(() => setLoading(false))
  }, [canvasId])

  // Fetch hours whenever selectedDay changes
  useEffect(() => {
    if (!selectedDay || canvasId == null) return
    fetch(`/history/snapshots/${canvasId}?day=${selectedDay}`)
      .then(r => r.ok ? r.json() : { snapshots: [] })
      .then(d => {
        const snaps = d.snapshots || []
        setSnapshots(snaps)
        if (snaps.length > 0) {
          const mode = targetSnapIndexRef.current
          if (mode === 'first') {
            onTs(snaps[0].ts)
          } else if (mode === 'last') {
            onTs(snaps[snaps.length - 1].ts)
          } else if (ts && snaps.some(s => s.ts === ts)) {
            onTs(ts)
          } else {
            onTs(snaps[snaps.length - 1].ts)
          }
          targetSnapIndexRef.current = null
        }
      })
      .catch(() => setSnapshots([]))
  }, [selectedDay, canvasId])

  // Poll for new snapshots every 30s
  useEffect(() => {
    if (canvasId == null) return
    const id = setInterval(() => {
      if (!selectedDay) return
      fetch(`/history/snapshots/${canvasId}?day=${selectedDay}`)
        .then(r => r.ok ? r.json() : { snapshots: [] })
        .then(d => setSnapshots(d.snapshots || []))
        .catch(() => {})
    }, 30_000)
    return () => clearInterval(id)
  }, [canvasId, selectedDay])

  const flatTs = snapshots.map(s => s.ts)
  const flatIdx = flatTs.indexOf(ts)

  const dayIdx = days.indexOf(selectedDay)
  const hasPrevDay = dayIdx > 0
  const hasNextDay = dayIdx !== -1 && dayIdx < days.length - 1
  const disablePrev = flatIdx === 0 && !hasPrevDay
  const disableNext = flatIdx === flatTs.length - 1 && !hasNextDay

  function step(dir) {
    if (dir === 1 && flatIdx === flatTs.length - 1) {
      if (hasNextDay) {
        targetSnapIndexRef.current = 'first'
        onDayChange(days[dayIdx + 1])
      }
      return
    }
    if (dir === -1 && flatIdx === 0) {
      if (hasPrevDay) {
        targetSnapIndexRef.current = 'last'
        onDayChange(days[dayIdx - 1])
      }
      return
    }
    const next = flatTs[flatIdx + dir]
    if (next !== undefined) onTs(next)
  }

  function fmtDay(yyyymmdd) {
    const y = yyyymmdd.slice(0, 4)
    const m = yyyymmdd.slice(4, 6)
    const d = yyyymmdd.slice(6, 8)
    return new Date(`${y}-${m}-${d}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', timeZone: 'UTC'
    })
  }

  function fmtHour(hhmm) {
    const h = parseInt(hhmm.slice(0, 2))
    const m = hhmm.slice(2, 4)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const h12 = h % 12 || 12
    return `${h12}:${m} ${ampm}`
  }

  return (
    <div id="history-bar">
      <span className="hist-icon">🕐</span>
      {loading ? (
        <span style={{ fontSize: 11, opacity: 0.6 }}>Loading snapshots…</span>
      ) : days.length === 0 ? (
        <span style={{ fontSize: 11, opacity: 0.6 }}>No snapshots yet</span>
      ) : (
        <>
          <button className="hist-jump" onClick={() => step(-1)} disabled={disablePrev}>‹</button>

          <select
            className="hist-input"
            value={selectedDay || ''}
            onChange={e => onDayChange(e.target.value)}
          >
            {days.map(d => (
              <option key={d} value={d}>{fmtDay(d)}</option>
            ))}
          </select>

          <select
            className="hist-input"
            value={ts}
            onChange={e => onTs(Number(e.target.value))}
          >
            {snapshots.map(({ ts: hts, hhmm }) => (
              <option key={hts} value={hts}>{fmtHour(hhmm)}</option>
            ))}
          </select>

          <button className="hist-jump" onClick={() => step(1)} disabled={disableNext}>›</button>
          <span className="hist-notice">{flatIdx + 1} / {flatTs.length}</span>
        </>
      )}
      <button className="hist-exit" onClick={onClose} title="Exit history mode">✕</button>
    </div>
  )
}