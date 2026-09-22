import { useState, useEffect, useCallback, useRef } from 'react'
import PanelHeader from '../PanelHeader.jsx'
import { getAvatarUrl } from '../../lib/avatar.js'

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return Number(n).toLocaleString()
}

function avatarUrl() {
  return 'https://cdn.discordapp.com/embed/avatars/0.png'
}

const ROLE_COLOR = { 254: '#FFD700', 200: '#4A9EFF', 150: '#3DDB7A', 100: '#40D9CC' }
function roleColor(r) {
  for (const [min, col] of Object.entries(ROLE_COLOR).sort((a, b) => b[0] - a[0]))
    if (r >= min) return col
  return 'rgba(255,255,255,.7)'
}

const MEDAL = ['🥇', '🥈', '🥉']

function countryFlag(code) {
  if (!code || code.length !== 2) return '🌐'
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  )
}

// ── SVG Sparkline ─────────────────────────────────────────────────────────────

function SparkLine({ data, color = '#4A9EFF' }) {
  const [tooltip, setTooltip] = useState(null)
  const containerRef = useRef(null)

  if (!data || data.length < 2)
    return <div className="spark-empty">History accumulates daily — check back tomorrow!</div>
  if (!data.some(d => d.pixels > 0))
    return <div className="spark-empty">No pixel activity recorded yet for this period.</div>

  const W = 500, H = 110
  const PAD = { t: 14, b: 24, l: 8, r: 8 }
  const pW = W - PAD.l - PAD.r
  const pH = H - PAD.t - PAD.b
  const vals   = data.map(d => d.pixels)
  const maxVal = Math.max(...vals, 1)
  const n      = vals.length
  const X = i => PAD.l + (i / (n - 1)) * pW
  const Y = v => PAD.t + pH - (v / maxVal) * pH
  const pts  = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`)
  const line = 'M ' + pts.join(' L ')
  const fill = `M ${X(0)},${Y(vals[0])} L ${pts.join(' L ')} L ${X(n-1)},${H-PAD.b} L ${X(0)},${H-PAD.b} Z`
  const labelIdx = [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1]
  const colW = pW / n

  return (
    <div ref={containerRef} className="spark-wrap" onMouseLeave={() => setTooltip(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="spark-svg">
        <defs>
          <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.3"/>
            <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
          </linearGradient>
        </defs>
        <line x1={PAD.l} x2={W-PAD.r} y1={Y(maxVal*0.5)} y2={Y(maxVal*0.5)} stroke="rgba(255,255,255,.05)" strokeWidth="1"/>
        <line x1={PAD.l} x2={W-PAD.r} y1={H-PAD.b}       y2={H-PAD.b}       stroke="rgba(255,255,255,.08)" strokeWidth="1"/>
        <path d={fill} fill={`url(#sg-${color.replace('#','')})`}/>
        <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>

        {tooltip != null && (
          <rect
            x={X(tooltip) - colW / 2} y={PAD.t}
            width={colW} height={pH}
            fill="rgba(255,255,255,0.06)" rx="2"
          />
        )}

        {vals.map((v, i) => (
          <circle key={i} cx={X(i)} cy={Y(v)}
                  r={tooltip === i ? 4.5 : i === n-1 ? 3.5 : 1.8}
                  fill={color} opacity={tooltip === i || i === n-1 ? 1 : 0.5}/>
        ))}

        {labelIdx.map(i => (
          <text key={i} x={X(i)} y={H-6} fontSize="9" fill="rgba(255,255,255,.3)"
                textAnchor={i===0 ? 'start' : i===n-1 ? 'end' : 'middle'}>
            {data[i].date.slice(5)}
          </text>
        ))}
        <text x={PAD.l+2} y={PAD.t+1} fontSize="8" fill="rgba(255,255,255,.25)" dominantBaseline="hanging">
          {fmt(maxVal)}
        </text>

        {data.map((d, i) => (
          <rect
            key={i}
            x={X(i) - colW / 2} y={PAD.t}
            width={colW} height={pH}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            onMouseEnter={() => setTooltip(i)}
          />
        ))}
      </svg>

      {tooltip != null && (
        <div className="spark-tooltip" style={{ left: `${(X(tooltip) / W) * 100}%` }}>
          <div className="spark-tooltip-date">{data[tooltip].date}</div>
          <div className="spark-tooltip-val">{fmt(data[tooltip].pixels)} px</div>
        </div>
      )}
    </div>
  )
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, icon, trend }) {
  const trendUp   = trend != null && trend > 0
  const trendDown = trend != null && trend < 0
  return (
    <div className="st-card" style={color ? { '--st-accent': color } : {}}>
      {icon && <span className="st-card-icon">{icon}</span>}
      <span className="st-card-val">{value}</span>
      {trend != null && (
        <span className={`st-trend ${trendUp ? 'up' : trendDown ? 'down' : 'flat'}`}>
          {trendUp ? '▲' : trendDown ? '▼' : '—'} {Math.abs(trend).toFixed(1)}%
        </span>
      )}
      <span className="st-card-lbl">{label}</span>
      {sub && <span className="st-card-sub">{sub}</span>}
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function OverviewTab({ data }) {
  return (
    <div className="stats-tab-content">
      <div className="st-cards-grid">
        <StatCard icon="🎨" label="Total Pixels" value={fmt(data.total_pixels)}/>
        <StatCard icon="📅" label="Pixels Today" value={fmt(data.today_pixels)}
                  trend={data.today_change_pct}
                  sub={data.yesterday_pixels ? `vs ${fmt(data.yesterday_pixels)} yesterday` : null}/>
        <StatCard icon="⚡" label="Active Today" value={fmt(data.active_today)}
                  sub="users placed a pixel today"/>
        <StatCard icon="🏆" label="Peak Day"     value={fmt(data.peak_pixels)}
                  sub={data.peak_day} color="#FFD700"/>
      </div>
      <div className="stats-section">
        <div className="stats-section-title">Daily Activity — last 30 days</div>
        <SparkLine data={data.daily_history}/>
      </div>
    </div>
  )
}

const CANVAS_OPTS = [
  { id: -1, label: 'All Canvases' },
  { id:  0, label: '🌍 Earth'     },
  { id:  1, label: '🌏 New Earth' },
  { id:  2, label: '🌕 Moon'      },
  { id: 17, label: '🗺 Minimap'   },
  { id: 23, label: '🗺 Refugee'   },
]

function LeaderboardTab({ data, canvasId, setCanvasId, daily, setDaily }) {
  const canvasKey = canvasId === -1 ? 'all' : String(canvasId)
  const timeKey   = daily ? 'daily' : 'alltime'
  const entries   = data.leaderboards?.[canvasKey]?.[timeKey] ?? []
  const users     = data.users ?? {}

  return (
    <div className="stats-tab-content">
      <div className="lb-controls">
        <div className="lb-toggle">
          <button className={`lb-toggle-btn${!daily ? ' active' : ''}`}
                  onClick={() => setDaily(false)}>All-Time</button>
          <button className={`lb-toggle-btn${ daily ? ' active' : ''}`}
                  onClick={() => setDaily(true)}>Today</button>
        </div>
        <select className="lb-canvas-sel" value={canvasId}
                onChange={e => setCanvasId(Number(e.target.value))}>
          {CANVAS_OPTS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>

      {entries.length === 0
        ? <div className="stats-empty">No data yet.</div>
        : (
          <div className="lb-list">
            {entries.map(e => {
              const u = users[String(e.user_id)] ?? {}
              return (
                <div key={e.user_id} className={`lb-row${e.rank <= 3 ? ` lb-top${e.rank}` : ''}`}>
                  <span className="lb-rank">{e.rank <= 3 ? MEDAL[e.rank-1] : `#${e.rank}`}</span>
                  <img className="lb-avatar" src={getAvatarUrl(u)} alt=""/>
                  <span className="lb-name" style={{ color: roleColor(u.role ?? 0) }}>{u.username ?? `User ${e.user_id}`}</span>
                  <span className="lb-score">{fmt(e.score)} px</span>
                </div>
              )
            })}
          </div>
        )
      }
    </div>
  )
}

// ── Pie chart palette (20 distinct hues) ─────────────────────────────────────

const PIE_COLORS = [
  '#4A9EFF','#FF6B6B','#FFD93D','#6BCB77','#C77DFF',
  '#FF922B','#20C997','#F06595','#74C0FC','#A9E34B',
  '#FFA94D','#63E6BE','#E599F7','#FF8787','#4DABF7',
  '#96F2D7','#FFEC99','#B2F2BB','#D0BFFF','#FFC9C9',
]

const MAX_SLICES = 15   // countries shown as individual slices

function PieChart({ entries, total }) {
  const [hovered, setHovered] = useState(null)

  if (!entries.length) return <div className="stats-empty">No country data yet.</div>

  // Build slices
  const top   = entries.slice(0, MAX_SLICES)
  const rest  = entries.slice(MAX_SLICES)
  const restCount = rest.reduce((s, c) => s + c.count, 0)
  const slices = [
    ...top.map((c, i) => ({ ...c, color: PIE_COLORS[i % PIE_COLORS.length] })),
    ...(restCount > 0 ? [{ code: 'OTHER', count: restCount, color: '#555' }] : []),
  ]

  const CX = 110, CY = 110, R = 95, GAP_DEG = 0.6
  let cursor = -90  // start at top

  const paths = slices.map((s, i) => {
    const pct    = s.count / total
    const deg    = pct * 360 - GAP_DEG
    const startA = (cursor * Math.PI) / 180
    const endA   = ((cursor + deg) * Math.PI) / 180
    cursor      += pct * 360

    const x1 = CX + R * Math.cos(startA)
    const y1 = CY + R * Math.sin(startA)
    const x2 = CX + R * Math.cos(endA)
    const y2 = CY + R * Math.sin(endA)
    const large = deg > 180 ? 1 : 0

    const midA = startA + (endA - startA) / 2
    const mx   = CX + (R * 0.62) * Math.cos(midA)
    const my   = CY + (R * 0.62) * Math.sin(midA)

    const isHov = hovered === i
    const tx    = isHov ? CX + 6 * Math.cos(midA) : 0
    const ty    = isHov ? CY + 6 * Math.sin(midA) : 0

    return { s, i, x1, y1, x2, y2, large, midA, mx, my, isHov, tx, ty, pct, startA, endA, deg }
  })

  const hov = hovered !== null ? paths[hovered] : null

  return (
    <div className="pie-wrap">
      <svg viewBox="0 0 220 220" className="pie-svg"
           onMouseLeave={() => setHovered(null)}>
        {/* Drop shadow filter */}
        <defs>
          <filter id="pie-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.35"/>
          </filter>
        </defs>

        {/* Slices */}
        {paths.map(({ s, i, x1, y1, x2, y2, large, tx, ty, isHov, deg, pct }) => (
          deg > 0.01 && (
            <path
              key={i}
              d={`M ${CX} ${CY} L ${x1.toFixed(3)} ${y1.toFixed(3)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`}
              fill={s.color}
              opacity={hovered === null || isHov ? 1 : 0.55}
              stroke="#1a1a2e"
              strokeWidth={isHov ? 1.5 : 0.8}
              transform={isHov ? `translate(${(tx - CX) * 0.06} ${(ty - CY) * 0.06})` : ''}
              style={{ cursor: 'pointer', transition: 'opacity 0.15s, transform 0.15s' }}
              filter={isHov ? 'url(#pie-shadow)' : ''}
              onMouseEnter={() => setHovered(i)}
            />
          )
        ))}

        {/* Centre hole label */}
        {hov ? (
          <>
            <text x={CX} y={CY - 9} textAnchor="middle" fontSize="18" fill="#fff" dominantBaseline="middle">
              {hov.s.code === 'OTHER' ? '🌐' : countryFlag(hov.s.code)}
            </text>
            <text x={CX} y={CY + 10} textAnchor="middle" fontSize="9.5" fill="#fff" fontWeight="700">
              {hov.s.code}
            </text>
            <text x={CX} y={CY + 22} textAnchor="middle" fontSize="8.5" fill="rgba(255,255,255,.6)">
              {(hov.pct * 100).toFixed(1)}%
            </text>
            <text x={CX} y={CY + 33} textAnchor="middle" fontSize="7.5" fill="rgba(255,255,255,.4)">
              {Number(hov.s.count).toLocaleString()}
            </text>
          </>
        ) : (
          <>
            <text x={CX} y={CY - 5} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,.5)">
              {slices.length} countries
            </text>
            <text x={CX} y={CY + 8} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,.3)">
              Hover to inspect
            </text>
          </>
        )}
      </svg>

      {/* Legend */}
      <div className="pie-legend">
        {slices.map((s, i) => (
          <div key={i} className={`pie-legend-row${hovered === i ? ' pie-legend-hov' : ''}`}
               onMouseEnter={() => setHovered(i)}
               onMouseLeave={() => setHovered(null)}>
            <span className="pie-swatch" style={{ background: s.color }}/>
            <span className="pie-legend-flag">{s.code === 'OTHER' ? '🌐' : countryFlag(s.code)}</span>
            <span className="pie-legend-code">{s.code}</span>
            <span className="pie-legend-pct">{((s.count / total) * 100).toFixed(1)}%</span>
            <span className="pie-legend-count">{Number(s.count).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CommunityTab({ data }) {
  const countries  = data.countries ?? []
  const normalised = countries.map(c => Array.isArray(c) ? { code: c[0], count: c[1] } : c)
                              .sort((a, b) => b.count - a.count)
  const total = normalised.reduce((s, c) => s + (c.count ?? 0), 0)

  return (
    <div className="stats-tab-content">
      <div className="stats-section">
        <div className="stats-section-title">Top Countries by Players</div>
        <PieChart entries={normalised} total={Math.max(total, 1)} />
      </div>
    </div>
  )
}

// ── Main Panel ────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'overview',    label: '📊 Overview'    },
  { key: 'leaderboard', label: '🏆 Leaderboard' },
  { key: 'community',   label: '🌍 Countries'   },
]

export default function StatsPanel({ onClose }) {
  const [tab,      setTab]      = useState('overview')
  const [canvasId, setCanvasId] = useState(-1)
  const [daily,    setDaily]    = useState(false)
  const [data,     setData]     = useState(null)
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    fetch('/stats/all')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  return (
    <div id="panel-stats" className="panel stats-panel">
      <PanelHeader title="Stats & Leaderboard" panelId="panel-stats" onClose={onClose} />

      <div className="stats-tabs">
        {TABS.map(t => (
          <button key={t.key}
                  className={`stats-tab-btn${tab === t.key ? ' active' : ''}`}
                  onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="panel-body stats-body">
        {loading && <div className="stats-loading">Loading…</div>}
        {!loading && !data && <div className="stats-error">Could not load stats.</div>}
        {!loading && data && tab === 'overview'    && <OverviewTab data={data}/>}
        {!loading && data && tab === 'leaderboard' && (
          <LeaderboardTab data={data} canvasId={canvasId} setCanvasId={setCanvasId}
                          daily={daily} setDaily={setDaily}/>
        )}
        {!loading && data && tab === 'community'   && <CommunityTab data={data}/>}
      </div>
    </div>
  )
}