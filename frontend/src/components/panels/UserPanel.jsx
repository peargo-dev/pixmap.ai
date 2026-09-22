import { useState, useEffect } from 'react'
import FlairBadge from '../FlairBadge'
import PanelHeader from '../PanelHeader.jsx'
import { getAvatarUrl } from '../../lib/avatar.js'

function esc(s) { return String(s) }

const MILESTONES = [10_000, 100_000, 1_000_000]
const TIER_NAMES = ['No tier', 'Tier 1', 'Tier 2', 'Tier 3']
const TIER_DESC  = [
  'Place pixels to unlock cosmetics!',
  'Unlocked: Custom profile picture',
  'Unlocked: Username style, banner colour, chat effects',
  'Unlocked: Rainbow & animated effects, full customization',
]

const USERNAME_STYLES = [
  { key: 'gold',    label: '✨ Gold',    tier: 2 },
  { key: 'fire',    label: '🔥 Fire',    tier: 2 },
  { key: 'ice',     label: '❄️ Ice',     tier: 2 },
  { key: 'rainbow', label: '🌈 Rainbow', tier: 3 },
  { key: 'void',    label: '🌑 Void',    tier: 3 },
]

const MSG_STYLES = [
  { key: 'glow',      label: '✦ Glow',      tier: 2 },
  { key: 'highlight', label: '▌Highlight',   tier: 2 },
]

const BANNER_PRESETS = [
  '#1a1a2e', '#16213e', '#0f3460', '#533483',
  '#1b4332', '#2d4a22', '#7a1e1e', '#4a0e0e',
  '#2c2c54', '#00204a', '#1a1a1a', '#000000',
]

const USERNAME_RE = /^[A-Za-z0-9]{3,20}$/

function countryFlag(code) {
  if (!code || code.length !== 2) return null
  const c = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return null
  return String.fromCodePoint(...[...c].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65))
}

function formatRankSuffix(rank) {
  if (rank == null || rank <= 0) return ''
  return ` (#${rank.toLocaleString()})`
}

function TierBar({ px, tier }) {
  const current  = MILESTONES[tier - 1] ?? 0
  const next     = MILESTONES[tier]
  const progress = next ? Math.min((px - current) / (next - current), 1) : 1
  return (
    <div className="flair-tier-bar-wrap">
      <div className="flair-tier-bar" style={{ '--prog': `${progress * 100}%` }} />
      <span className="flair-tier-label">
        {next
          ? `${(px).toLocaleString()} / ${next.toLocaleString()} px → Tier ${tier + 1}`
          : `${px.toLocaleString()} px — Max tier reached 🎉`}
      </span>
    </div>
  )
}

function LockIcon() {
  return (
    <svg className="lock-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="7" width="10" height="8" rx="1.5"/>
      <path d="M5 7V5a3 3 0 0 1 6 0v2"/>
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg className="profile-linked-icon profile-linked-icon-google" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  )
}

function DiscordIcon() {
  return (
    <svg className="profile-linked-icon profile-linked-icon-discord" viewBox="0 0 127.14 96.36" aria-hidden="true">
      <path fill="currentColor" d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15zM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69z"/>
    </svg>
  )
}

export default function UserPanel({
  user,
  icons = {},
  dailyPixelCount,
  onClose,
}) {
  const [bio,           setBio]           = useState(user?.bio ?? '')
  const [username,      setUsername]      = useState(user?.username ?? '')
  const [saveStatus,    setSaveStatus]    = useState('')
  const [usernameStatus, setUsernameStatus] = useState('')
  const [usernameSaving, setUsernameSaving] = useState(false)
  const [flair,         setFlair]         = useState(null)
  const [flairSaving,   setFlairSaving]   = useState(false)

  const [usernameStyle, setUsernameStyle] = useState(null)
  const [msgStyle,      setMsgStyle]      = useState(null)
  const [bannerColor,   setBannerColor]   = useState(null)
  const [profilePic,    setProfilePic]    = useState(null)

  useEffect(() => {
    if (!user) return
    setBio(user.bio ?? '')
    setUsername(user.username ?? '')
    fetch(`/flair/${user.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        setFlair(data)
        setUsernameStyle(data.username_style ?? null)
        setMsgStyle(data.msg_style ?? null)
        setBannerColor(data.banner_color ?? null)
        setProfilePic(data.profile_pic_b64 ?? null)
      })
      .catch(() => {})
  }, [user?.id])

  useEffect(() => {
    if (!user) return
    setBio(user.bio ?? '')
    setUsername(user.username ?? '')
  }, [user?.bio, user?.username])

  async function handleSave() {
    const r = await fetch('/auth/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio }),
    })
    setSaveStatus(r.ok ? '✓ Saved' : '✗ Error')
    setTimeout(() => setSaveStatus(''), 2000)
  }

  async function handleUsernameSave(e) {
    e.preventDefault()
    const nextUsername = username.trim()

    if (!USERNAME_RE.test(nextUsername)) {
      setUsernameStatus('✗ Username must be 3-20 letters/numbers only')
      setTimeout(() => setUsernameStatus(''), 2500)
      return
    }

    if (nextUsername === (user?.username ?? '')) {
      setUsernameStatus('')
      return
    }

    setUsernameSaving(true)
    try {
      const r = await fetch('/auth/username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: nextUsername }),
      })

      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setUsernameStatus(`✗ ${j.detail ?? 'Error'}`)
        setTimeout(() => setUsernameStatus(''), 2500)
        return
      }

      const j = await r.json().catch(() => ({}))
      setUsername(nextUsername)
      setUsernameStatus('✓ Username updated')
      setTimeout(() => {
        setUsernameStatus('')
        if (j?.username) location.reload()
      }, 500)
    } catch {
      setUsernameStatus('✗ Network error')
      setTimeout(() => setUsernameStatus(''), 2500)
    } finally {
      setUsernameSaving(false)
    }
  }

  async function handleLogout() {
    await fetch('/auth/logout', { method: 'POST' })
    location.reload()
  }

  async function saveFlair(patch) {
    setFlairSaving(true)
    try {
      const r = await fetch('/users/me/flair', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setSaveStatus(`✗ ${j.detail ?? 'Error'}`)
      } else {
        setSaveStatus('✓ Saved')
      }
    } catch { setSaveStatus('✗ Network error') }
    setTimeout(() => setSaveStatus(''), 2500)
    setFlairSaving(false)
  }

  async function handlePicUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async ev => {
      const b64 = ev.target.result
      setProfilePic(b64)
      await saveFlair({ profile_pic_b64: b64 })
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const tier    = flair?.effective_tier ?? 0
  const px      = flair?.pixels_placed  ?? (user?.pixels_placed ?? 0)
  const dailyPx = dailyPixelCount ?? user?.pixels_placed_daily ?? 0
  const granted = flair?.granted_tier   ?? 0
  const flag    = countryFlag(user?.country)

  const avatar = (() => {
    if (profilePic) return profilePic
    return getAvatarUrl(user, 128)
  })()

  const since = user
    ? new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : ''

  const bannerStyle = bannerColor ? { background: bannerColor } : {}

  return (
    <div id="panel-user" className="panel">
      <PanelHeader title="Account" panelId="panel-user" onClose={onClose} />
      <div className="panel-body" id="panel-user-body">
        {user ? (
          <>
            <div className={`profile-banner${bannerColor ? ' has-banner' : ''}`} style={bannerStyle}>
              <div className="profile-header">
                <div className={`profile-avatar-wrap tier-${tier}-frame`}>
                  <img className="profile-avatar" src={avatar} alt="avatar" />
                  <span className={`profile-online-dot${user.online ? ' is-online' : ''}`}
                        title={user.online ? 'Online' : 'Offline'} />
                </div>
                <div className="profile-info">
                  <div className="profile-name">
                    <FlairBadge role={user.role} flair={{ ic: null, us: usernameStyle }} icons={icons} size={18} />
                    {' '}
                    <span className={usernameStyle ? `un-${usernameStyle}` : undefined}>{esc(user.username)}</span>
                    {flag && <span className="profile-flag" title={user.country}>{flag}</span>}
                  </div>
                  <span className={`role-badge role-${user.role}`}>
                    {user.role >= 254 ? 'Owner' : user.role >= 200 ? 'Admin' : user.role >= 150 ? 'Moderator' : user.role >= 100 ? 'Trial Mod' : 'Player'}
                  </span>
                </div>
              </div>
            </div>

            <div className="profile-stats">
              <div className="profile-stat-row">
                <span className="profile-stat-lbl">Alltime Pixels</span>
                <span className="profile-stat-val">{px.toLocaleString()}{formatRankSuffix(user.rank_alltime)}</span>
              </div>
              <div className="profile-stat-row">
                <span className="profile-stat-lbl">Daily Pixels</span>
                <span className="profile-stat-val">{dailyPx.toLocaleString()}{formatRankSuffix(user.rank_daily)}</span>
              </div>
              <div className="profile-stat-row">
                <span className="profile-stat-lbl">Member since</span>
                <span className="profile-stat-val">{since}</span>
              </div>
              <div className="profile-stat-row">
                <span className="profile-stat-lbl">User ID</span>
                <span className="profile-stat-val">#{user.id}</span>
              </div>
            </div>

            <section className="profile-section profile-section-compact" aria-label="Edit profile">
              <div className="profile-field">
                <label className="profile-field-label" htmlFor="profile-bio">Bio</label>
                <textarea
                  id="profile-bio"
                  className="profile-field-input"
                  maxLength={500}
                  rows={2}
                  placeholder="Write something about yourself…"
                  value={bio}
                  onChange={e => setBio(e.target.value)}
                />
                <div className="profile-field-actions">
                  <button type="button" className="mt-btn primary btn-compact" onClick={handleSave}>Save bio</button>
                  {saveStatus && (
                    <span className={`profile-field-status${saveStatus.startsWith('✓') ? ' is-ok' : saveStatus.startsWith('✗') ? ' is-err' : ''}`}>
                      {saveStatus}
                    </span>
                  )}
                </div>
              </div>

              <form className="profile-field" onSubmit={handleUsernameSave}>
                <label className="profile-field-label" htmlFor="profile-username">Username</label>
                <div className="profile-inline-row">
                  <input
                    id="profile-username"
                    className="profile-field-input"
                    type="text"
                    maxLength={20}
                    placeholder="Username"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button className="mt-btn primary btn-compact" type="submit" disabled={usernameSaving}>
                    {usernameSaving ? '…' : 'Save'}
                  </button>
                </div>
                {usernameStatus && (
                  <span className={`profile-field-status${usernameStatus.startsWith('✓') ? ' is-ok' : usernameStatus.startsWith('✗') ? ' is-err' : ''}`}>
                    {usernameStatus}
                  </span>
                )}
              </form>
            </section>

            {flair && (
              <details className="profile-flair-details">
                <summary>Cosmetics · {TIER_NAMES[tier]}</summary>
                <div className="flair-section flair-section-compact">
                  <div className="flair-tier-header">
                    {granted > tier && (
                      <span className="tier-granted" title="Staff granted">★ Staff granted</span>
                    )}
                    <span className="tier-desc">{TIER_DESC[tier]}</span>
                  </div>

                  {tier < 3 && <TierBar px={px} tier={tier} />}

                  <div className={`flair-row${tier < 1 ? ' locked' : ''}`}>
                    <div className="flair-row-title">
                      {tier < 1 && <LockIcon />}
                      Custom Profile Picture
                      <span className="tier-req">Tier 1</span>
                    </div>
                    {tier >= 1 ? (
                      <div className="flair-pic-row">
                        {profilePic && (
                          <img src={profilePic} alt="custom pic" className="flair-pic-preview" />
                        )}
                        <label className="mt-btn secondary flair-upload-btn">
                          {profilePic ? '⟳ Change' : '↑ Upload'}
                          <input type="file" accept="image/*" hidden onChange={handlePicUpload} />
                        </label>
                        {profilePic && (
                          <button className="mt-btn danger-sm" onClick={() => { setProfilePic(null); saveFlair({ profile_pic_b64: null }) }}>
                            Remove
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="flair-locked-hint">Place {(10_000 - px).toLocaleString()} more pixels to unlock</p>
                    )}
                  </div>

                  <div className={`flair-row${tier < 2 ? ' locked' : ''}`}>
                    <div className="flair-row-title">
                      {tier < 2 && <LockIcon />}
                      Banner
                      <span className="tier-req">T2</span>
                    </div>
                    {tier >= 2 ? (
                      <div className="flair-colors">
                        {BANNER_PRESETS.map(c => (
                          <button key={c} className={`color-swatch${bannerColor === c ? ' active' : ''}`}
                                  style={{ background: c }}
                                  onClick={() => { setBannerColor(c === bannerColor ? null : c); saveFlair({ banner_color: c === bannerColor ? null : c }) }} />
                        ))}
                        <button className={`color-swatch${!bannerColor ? ' active' : ''}`}
                                style={{ background: 'transparent', border: '1px solid rgba(255,255,255,.2)' }}
                                onClick={() => { setBannerColor(null); saveFlair({ banner_color: null }) }}
                                title="None">✕</button>
                      </div>
                    ) : (
                      <p className="flair-locked-hint">100k px for Tier 2</p>
                    )}
                  </div>

                  <div className={`flair-row${tier < 2 ? ' locked' : ''}`}>
                    <div className="flair-row-title">
                      {tier < 2 && <LockIcon />}
                      Username style
                    </div>
                    {tier >= 2 ? (
                      <div className="style-picker-grid">
                        <button
                          className={`style-preview-btn${!usernameStyle ? ' active' : ''}`}
                          onClick={() => { setUsernameStyle(null); saveFlair({ username_style: null }) }}
                        >
                          <span className="style-default-name">{user.username}</span>
                        </button>
                        {USERNAME_STYLES.map(s => (
                          <button
                            key={s.key}
                            className={`style-preview-btn${usernameStyle === s.key ? ' active' : ''}${tier < s.tier ? ' locked-style' : ''}`}
                            disabled={tier < s.tier}
                            onClick={() => {
                              const next = s.key === usernameStyle ? null : s.key
                              setUsernameStyle(next)
                              saveFlair({ username_style: next })
                            }}
                          >
                            <span className={`un-${s.key}`}>{user.username}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="flair-locked-hint">100k px for Tier 2</p>
                    )}
                  </div>

                  <div className={`flair-row${tier < 2 ? ' locked' : ''}`}>
                    <div className="flair-row-title">
                      {tier < 2 && <LockIcon />}
                      Chat style
                    </div>
                    {tier >= 2 ? (
                      <div className="msg-style-previews msg-style-previews-compact">
                        <button
                          className={`msg-preview-btn${!msgStyle ? ' active' : ''}`}
                          onClick={() => { setMsgStyle(null); saveFlair({ msg_style: null }) }}
                        >
                          Default
                        </button>
                        {MSG_STYLES.map(s => (
                          <button
                            key={s.key}
                            className={`msg-preview-btn${msgStyle === s.key ? ' active' : ''}`}
                            onClick={() => {
                              const next = s.key === msgStyle ? null : s.key
                              setMsgStyle(next)
                              saveFlair({ msg_style: next })
                            }}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="flair-locked-hint">100k px for Tier 2</p>
                    )}
                  </div>

                  {flairSaving && <div className="flair-saving">Saving…</div>}
                </div>
              </details>
            )}

            <section className="profile-section profile-linked-section profile-section-compact" aria-label="Linked accounts">
              <h3 className="profile-section-title">Linked accounts</h3>

              {!user.discord_id && (
                <div className="profile-linked-warn">
                  <strong>2× cooldown</strong> — Link Discord for normal cooldown.
                </div>
              )}

              <div className="profile-linked-card">
                <div className="profile-linked-row">
                  <div className="profile-linked-main">
                    <GoogleIcon />
                    <span className="profile-linked-label">Google</span>
                    <span className={`profile-linked-status${user.google_id ? ' is-linked' : ''}`}>
                      {user.google_id ? 'Linked' : 'Not linked'}
                    </span>
                  </div>
                  <div className="profile-linked-actions">
                    <a href="/auth/google?mode=link" className="mt-btn secondary btn-compact">
                      {user.google_id ? 'Change' : 'Link'}
                    </a>
                    {user.google_id && user.discord_id && (
                      <button type="button" className="mt-btn danger-sm btn-compact" onClick={async () => {
                        if (confirm('Unlink Google account? You must have Discord linked to do this.')) {
                          const r = await fetch('/auth/google/unlink', { method: 'POST' })
                          if (r.ok) location.reload()
                          else {
                            const j = await r.json().catch(() => ({}))
                            alert(j.detail || 'Failed to unlink.')
                          }
                        }
                      }}>Unlink</button>
                    )}
                  </div>
                </div>
              </div>

              <div className="profile-linked-card">
                <div className="profile-linked-row">
                  <div className="profile-linked-main">
                    <DiscordIcon />
                    <span className="profile-linked-label">Discord</span>
                    <span className={`profile-linked-status${user.discord_id ? ' is-linked' : ''}`}>
                      {user.discord_id ? 'Linked' : 'Not linked'}
                    </span>
                  </div>
                  <div className="profile-linked-actions">
                    {!user.discord_id && (
                      <a href="/auth/discord?mode=link" className="mt-btn secondary btn-compact">Link</a>
                    )}
                    {user.discord_id && (
                      <button type="button" className="mt-btn danger-sm btn-compact" onClick={async () => {
                        if (confirm('Unlink your Discord account?')) {
                          const r = await fetch('/auth/discord/unlink', { method: 'POST' })
                          if (r.ok) location.reload()
                        }
                      }}>Unlink</button>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <details className="profile-edit-details profile-danger-zone">
              <summary>Danger zone</summary>
              <div className="profile-danger-box">
                <p>Permanently delete your account. <strong>Cannot be undone.</strong></p>
                <button
                  type="button"
                  className="mt-btn danger-sm profile-danger-btn"
                  onClick={async () => {
                    const confirmation = prompt('Type "DELETE" to permanently delete your account.')
                    if (confirmation !== 'DELETE') return
                    if (!confirm('Are you absolutely sure?')) return
                    try {
                      const r = await fetch('/auth/delete-account', { method: 'POST' })
                      if (r.ok) location.reload()
                      else {
                        const j = await r.json().catch(() => ({}))
                        alert('Failed: ' + (j.detail || 'Unknown error'))
                      }
                    } catch (err) {
                      alert('Network error: ' + err.message)
                    }
                  }}
                >
                  Delete account
                </button>
              </div>
            </details>

            <button type="button" className="logout-btn" onClick={handleLogout}>Logout</button>
          </>
        ) : (
          <>
            <p className="muted">To register a new account, please sign in with Google first.</p>
            <a href="/auth/google" className="google-login-btn">
              <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                <path fill="none" d="M0 0h48v48H0z"/>
              </svg>
              Login with Google
            </a>
            <a href="/auth/discord" className="discord-login-btn">
              <svg viewBox="0 0 127.14 96.36" xmlns="http://www.w3.org/2000/svg">
                <path fill="#fff" d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15zM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69z"/>
              </svg>
              Login with Discord
            </a>
          </>
        )}
      </div>
    </div>
  )
}
