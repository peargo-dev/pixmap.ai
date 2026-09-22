import { useState, useEffect, useCallback } from 'react'
import PanelHeader from '../PanelHeader.jsx'
import { getAvatarUrl } from '../../lib/avatar.js'
import { getCanvasCenter, centerCoordsFromWorld } from '../../lib/canvas/templates.js'

function hexToRgb(hex) {
  if (!hex) return [0, 0, 0]
  hex = hex.replace('#', '')
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
  const num = parseInt(hex, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

function colorDistance(c1, c2) {
  const [r1, g1, b1] = hexToRgb(c1)
  const [r2, g2, b2] = hexToRgb(c2)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

function findSimilarFactionColor(targetColor, existingFactions, excludeFactionId = null) {
  if (!targetColor || !existingFactions?.length) return null
  for (const f of existingFactions) {
    if (excludeFactionId && f.id === excludeFactionId) continue
    if (!f.color) continue
    const dist = colorDistance(targetColor, f.color)
    if (dist < 45) {
      return { name: f.name, color: f.color, distance: Math.round(dist) }
    }
  }
  return null
}

const LOGO_SIZE = 50

/** Resize an image file to LOGO_SIZE×LOGO_SIZE via canvas (browser default smoothing). */
function resizeLogoFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) { resolve(null); return }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = LOGO_SIZE
      canvas.height = LOGO_SIZE
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, LOGO_SIZE, LOGO_SIZE)
      canvas.toBlob(
        blob => {
          if (!blob) { reject(new Error('Failed to resize logo')); return }
          resolve(new File([blob], 'logo.png', { type: 'image/png' }))
        },
        'image/png',
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Invalid image file'))
    }
    img.src = url
  })
}

export default function FactionsPanel({
  currentUser,
  canvasRef,
  configs,
  canvasId,
  onClose
}) {
  const [activeTab, setActiveTab] = useState('leaderboard')
  const [factions, setFactions] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [publicOnly, setPublicOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [myFactionData, setMyFactionData] = useState(null)

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({
    name: '',
    description: '',
    color: '#ff4444',
    is_public: false,
    min_join_px: 10000,
    canvas_id: 0,
    logoFile: null
  })
  const [createError, setCreateError] = useState(null)

  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteUsersList, setInviteUsersList] = useState([])
  const [inviteSearchQuery, setInviteSearchQuery] = useState('')
  const [selectedInviteUser, setSelectedInviteUser] = useState(null)
  const [inviteStatus, setInviteStatus] = useState(null)

  const [announcementForm, setAnnouncementForm] = useState({ message: '', x: '', y: '' })
  const [announcementStatus, setAnnouncementStatus] = useState(null)

  const [templateForm, setTemplateForm] = useState({ canvas_id: 0, x: 0, y: 0, file: null })
  const [templateStatus, setTemplateStatus] = useState(null)
  const [picking, setPicking] = useState(false)

  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [settingsForm, setSettingsForm] = useState({ description: '', color: '#ff4444', is_public: false, min_join_px: 10000, logoFile: null })

  useEffect(() => () => { canvasRef.current?.stopTemplatePick?.() }, [canvasRef])

  const loadFactions = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams()
      if (searchQuery) query.set('search', searchQuery)
      if (publicOnly) query.set('public_only', 'true')
      const res = await fetch(`/api/factions?${query.toString()}`)
      if (res.ok) {
        const data = await res.json()
        setFactions(data.factions || [])
      }
    } catch {}
    setLoading(false)
  }, [searchQuery, publicOnly])

  const loadMyFaction = useCallback(async () => {
    try {
      const res = await fetch('/api/factions/my')
      if (res.ok) {
        const data = await res.json()
        setMyFactionData(data)
        if (data.faction) {
          setSettingsForm({
            description: data.faction.description || '',
            color: data.faction.color || '#ff4444',
            is_public: !!data.faction.is_public,
            min_join_px: data.faction.min_join_px || 10000
          })
        }
      }
    } catch {}
  }, [])

  useEffect(() => {
    loadFactions()
    if (currentUser) loadMyFaction()
  }, [loadFactions, loadMyFaction, currentUser])

  const handleSearchInviteUsers = useCallback(async (q) => {
    try {
      const res = await fetch(`/api/factions/users/search?query=${encodeURIComponent(q || '')}`)
      if (res.ok) {
        const data = await res.json()
        setInviteUsersList(data.users || [])
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (showInviteModal) handleSearchInviteUsers(inviteSearchQuery)
  }, [showInviteModal, inviteSearchQuery, handleSearchInviteUsers])

  async function handleCreateFaction(e) {
    e.preventDefault()
    setCreateError(null)
    if (!createForm.name.trim()) { setCreateError('Faction name is required'); return }
    let logoFile = null
    try {
      logoFile = await resizeLogoFile(createForm.logoFile)
    } catch (err) {
      setCreateError(err.message || 'Failed to process logo'); return
    }
    const formData = new FormData()
    formData.append('name', createForm.name.trim())
    formData.append('description', createForm.description)
    formData.append('color', createForm.color)
    formData.append('is_public', createForm.is_public)
    formData.append('min_join_px', createForm.min_join_px)
    formData.append('canvas_id', createForm.canvas_id)
    if (logoFile) formData.append('logo', logoFile)
    try {
      const res = await fetch('/api/factions', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) { setCreateError(data.detail || 'Failed to create faction'); return }
      setShowCreateModal(false)
      setCreateForm({ name: '', description: '', color: '#ff4444', is_public: false, min_join_px: 10000, canvas_id: 0, logoFile: null })
      loadMyFaction()
      loadFactions()
    } catch { setCreateError('Network error') }
  }

  async function handleSendInvite() {
    if (!selectedInviteUser || !myFactionData?.faction) return
    setInviteStatus(null)
    try {
      const formData = new FormData()
      formData.append('target_user_id', selectedInviteUser.id)
      const res = await fetch(`/api/factions/${myFactionData.faction.id}/invite`, { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) { setInviteStatus({ type: 'error', msg: data.detail || 'Failed to send invite' }); return }
      setInviteStatus({ type: 'ok', msg: data.message })
      setSelectedInviteUser(null)
    } catch { setInviteStatus({ type: 'error', msg: 'Network error' }) }
  }

  async function handleAcceptInvite(inviteId) {
    try {
      const res = await fetch(`/api/factions/invites/${inviteId}/accept`, { method: 'POST' })
      if (res.ok) { loadMyFaction(); loadFactions() }
    } catch {}
  }

  async function handleDeclineInvite(inviteId) {
    try {
      const res = await fetch(`/api/factions/invites/${inviteId}/decline`, { method: 'POST' })
      if (res.ok) loadMyFaction()
    } catch {}
  }

  async function handleJoinPublic(factionId) {
    try {
      const res = await fetch(`/api/factions/${factionId}/join`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { alert(data.detail || 'Could not join faction'); return }
      loadMyFaction(); loadFactions()
    } catch {}
  }

  async function handleLeaveFaction() {
    if (!myFactionData?.faction) return
    const isOwner = myFactionData.my_role === 4
    const memberCount = myFactionData.roster?.length || 1
    if (isOwner && memberCount > 1) {
      alert('As the Faction Owner, you cannot leave the faction while other members are present. Please transfer ownership to another member in the roster first.')
      return
    }
    if (!confirm(isOwner ? 'You are the only member. Leaving will disband this faction. Are you sure?' : 'Are you sure you want to leave your faction?')) return
    try {
      const res = await fetch(`/api/factions/${myFactionData.faction.id}/leave`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.detail || 'Failed to leave faction')
        return
      }
      loadMyFaction(); loadFactions()
    } catch {}
  }

  async function handleUpdateRole(targetUserId, newRole) {
    if (!myFactionData?.faction) return
    if (newRole === 4) {
      if (!confirm('Are you sure you want to transfer Faction Ownership to this member? You will become an Admin.')) return
    }
    try {
      const formData = new FormData()
      formData.append('new_role', newRole)
      const res = await fetch(`/api/factions/${myFactionData.faction.id}/members/${targetUserId}/role`, { method: 'POST', body: formData })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.detail || 'Failed to update role')
        return
      }
      loadMyFaction()
    } catch {}
  }

  async function handleKickMember(targetUserId) {
    if (!myFactionData?.faction) return
    if (!confirm('Are you sure you want to kick this member?')) return
    try {
      const res = await fetch(`/api/factions/${myFactionData.faction.id}/members/${targetUserId}`, { method: 'DELETE' })
      if (res.ok) loadMyFaction()
    } catch {}
  }

  async function handlePostAnnouncement(e) {
    e.preventDefault()
    if (!myFactionData?.faction || !announcementForm.message.trim()) return
    setAnnouncementStatus(null)
    try {
      const formData = new FormData()
      formData.append('message', announcementForm.message.trim())
      if (announcementForm.x !== '' && announcementForm.y !== '') {
        formData.append('x', announcementForm.x)
        formData.append('y', announcementForm.y)
      }
      const res = await fetch(`/api/factions/${myFactionData.faction.id}/announcements`, { method: 'POST', body: formData })
      if (res.ok) {
        setAnnouncementStatus({ type: 'ok', msg: 'Announcement posted!' })
        setAnnouncementForm({ message: '', x: '', y: '' })
        loadMyFaction()
      }
    } catch { setAnnouncementStatus({ type: 'error', msg: 'Failed to post' }) }
  }

  async function handleUploadTemplate(e) {
    e.preventDefault()
    if (!myFactionData?.faction || !templateForm.file) return
    setTemplateStatus(null)
    if (templateForm.file.size > 10 * 1024 * 1024) {
      setTemplateStatus({ type: 'error', msg: 'File exceeds 10MB' }); return
    }
    try {
      const formData = new FormData()
      formData.append('file', templateForm.file)
      formData.append('canvas_id', templateForm.canvas_id)
      formData.append('x', templateForm.x)
      formData.append('y', templateForm.y)
      const res = await fetch(`/api/factions/${myFactionData.faction.id}/template`, { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) { setTemplateStatus({ type: 'error', msg: data.detail || 'Upload failed' }); return }
      setTemplateStatus({ type: 'ok', msg: 'Template updated!' })
      loadMyFaction()
    } catch { setTemplateStatus({ type: 'error', msg: 'Upload error' }) }
  }

  async function handleSaveSettings(e) {
    e.preventDefault()
    if (!myFactionData?.faction) return
    let logoFile = null
    try {
      logoFile = await resizeLogoFile(settingsForm.logoFile)
    } catch (err) {
      alert(err.message || 'Failed to process logo')
      return
    }
    try {
      const formData = new FormData()
      formData.append('description', settingsForm.description)
      formData.append('color', settingsForm.color)
      formData.append('is_public', settingsForm.is_public)
      formData.append('min_join_px', settingsForm.min_join_px)
      if (logoFile) {
        formData.append('logo', logoFile)
      }
      const res = await fetch(`/api/factions/${myFactionData.faction.id}`, { method: 'PATCH', body: formData })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(data.detail || 'Failed to save settings')
        return
      }
      setShowSettingsModal(false)
      loadMyFaction()
      loadFactions()
    } catch {
      alert('Network error')
    }
  }

  function handlePickTemplateCoords() {
    if (!canvasRef.current?.startTemplatePick) return
    setPicking(true)
    const cid = templateForm.canvas_id ?? canvasId ?? 0
    canvasRef.current.startTemplatePick(null, (wx, wy) => {
      setPicking(false)
      const center = getCanvasCenter(configs, cid)
      const { x, y } = centerCoordsFromWorld(wx, wy, center)
      setTemplateForm(prev => ({ ...prev, x, y }))
    })
  }

  const roleLabel = (role) => role === 4 ? 'Owner' : role === 3 ? 'Admin' : role === 2 ? 'General' : 'Soldier'
  const roleBadgeClass = (role) => role === 4 ? 'role-owner' : role === 3 ? 'role-admin' : role === 2 ? 'role-moderator' : 'role-user'

  return (
    <div id="panel-factions" className="panel">
      <PanelHeader title="🛡️ Factions" panelId="panel-factions" onClose={onClose} />

      <div className="mt-tabs">
        <button className={`mt-tab ${activeTab === 'leaderboard' ? 'active' : ''}`} onClick={() => setActiveTab('leaderboard')}>
          🏆 All Factions
        </button>
        <button className={`mt-tab ${activeTab === 'my' ? 'active' : ''}`} onClick={() => setActiveTab('my')}>
          🛡️ My Faction {myFactionData?.invites?.length > 0 && `(${myFactionData.invites.length})`}
        </button>
      </div>

      <div className="panel-body" style={{ flex: 1, overflowY: 'auto' }}>
        {activeTab === 'leaderboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="text" className="mt-input" style={{ flex: 1 }} placeholder="Search factions..."
                value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              />
              <button className={`toggle-btn ${publicOnly ? 'on' : ''}`} onClick={() => setPublicOnly(!publicOnly)}>
                {publicOnly ? 'Public Only' : 'All'}
              </button>
            </div>

            {loading ? (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px' }}>Loading factions...</div>
            ) : factions.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px' }}>No factions found.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {factions.map((f, i) => (
                  <div key={f.id} className="canvas-list-row" style={{ borderLeft: `3px solid ${f.color || '#ff4444'}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: '700', color: 'var(--muted)', fontSize: '11px', width: '20px' }}>#{i + 1}</span>
                      <img
                        src={f.logo_url || 'https://cdn.discordapp.com/embed/avatars/0.png'} alt=""
                        style={{ width: '36px', height: '36px', borderRadius: '6px', objectFit: 'cover', imageRendering: 'pixelated' }}
                      />
                      <div className="canvas-list-info">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span className="canvas-list-name">{f.name}</span>
                          {f.is_public ? (
                            <span className="banned-tag" style={{ background: 'rgba(60,200,100,0.15)', color: '#5ddc8a', borderColor: 'rgba(60,200,100,0.3)' }}>Public</span>
                          ) : (
                            <span className="banned-tag" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--muted)', borderColor: 'rgba(255,255,255,0.15)' }}>Invite Only</span>
                          )}
                        </div>
                        <span className="canvas-list-meta">Leader: <strong>{f.owner_username}</strong> • 👥 {f.member_count} members</span>
                        <span className="canvas-list-meta">🎨 {f.total_pixels.toLocaleString()} total px • ⚡ {f.daily_pixels.toLocaleString()} daily px</span>
                      </div>
                    </div>
                    <div className="canvas-list-actions">
                      {f.is_public && !myFactionData?.faction && (
                        <button className="mt-btn primary btn-compact" onClick={() => handleJoinPublic(f.id)}>Join</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'my' && (
          <div>
            {!myFactionData?.faction ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ background: 'rgba(255,255,255,0.04)', padding: '16px', borderRadius: '8px', border: '1px solid var(--btn-border)', textAlign: 'center' }}>
                  <h3 style={{ margin: '0 0 6px 0', fontSize: '14px', color: 'var(--text)' }}>You are not in a Faction</h3>
                  <p style={{ fontSize: '12px', color: 'var(--muted)', margin: '0 0 12px 0' }}>
                    Join a public faction from the leaderboard or create your own! (Requires 200,000+ placed pixels).
                  </p>
                  <button className="mt-btn primary" onClick={() => setShowCreateModal(true)}>➕ Create a Faction</button>
                </div>

                {myFactionData?.invites?.length > 0 && (
                  <div>
                    <h3 className="mt-label">Pending Invitations ({myFactionData.invites.length})</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {myFactionData.invites.map(inv => (
                        <div key={inv.id} className="canvas-list-row">
                          <img src={inv.faction_logo || 'https://cdn.discordapp.com/embed/avatars/0.png'} alt="" style={{ width: '32px', height: '32px', borderRadius: '6px' }} />
                          <div className="canvas-list-info">
                            <span className="canvas-list-name">{inv.faction_name}</span>
                            <span className="canvas-list-meta">Invited by <strong>{inv.invited_by}</strong></span>
                          </div>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button className="mt-btn primary btn-compact" onClick={() => handleAcceptInvite(inv.id)}>Accept</button>
                            <button className="mt-btn secondary btn-compact" onClick={() => handleDeclineInvite(inv.id)}>Decline</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'rgba(255,255,255,0.04)', padding: '12px', borderRadius: '8px', borderLeft: `4px solid ${myFactionData.faction.color}` }}>
                  <img src={myFactionData.faction.logo_url || 'https://cdn.discordapp.com/embed/avatars/0.png'} alt="" style={{ width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover', imageRendering: 'pixelated' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text)' }}>{myFactionData.faction.name}</span>
                      <span className={`role-badge ${roleBadgeClass(myFactionData.my_role)}`}>{roleLabel(myFactionData.my_role)}</span>
                    </div>
                    <p style={{ fontSize: '11px', color: 'var(--muted)', margin: '2px 0 4px 0' }}>{myFactionData.faction.description || 'No description provided.'}</p>
                    <div style={{ fontSize: '11px', color: 'var(--text)', display: 'flex', gap: '10px' }}>
                      <span>🎨 {myFactionData.faction.total_pixels.toLocaleString()} total px</span>
                      <span>⚡ {myFactionData.faction.daily_pixels.toLocaleString()} daily px</span>
                      <span>👥 {myFactionData.faction.member_count} members</span>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {myFactionData.my_role >= 3 && (
                    <>
                      <button className="mt-btn primary btn-compact" onClick={() => setShowInviteModal(true)}>✉️ Invite Member</button>
                      <button className="mt-btn secondary btn-compact" onClick={() => setShowSettingsModal(true)}>⚙️ Settings</button>
                    </>
                  )}
                  <button className="mt-btn danger btn-compact" onClick={handleLeaveFaction}>Leave Faction</button>
                </div>

                {myFactionData.faction.template_url && (
                  <div style={{ background: 'rgba(60,200,100,0.08)', border: '1px solid rgba(60,200,100,0.2)', padding: '10px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ fontSize: '11px' }}>
                      <strong style={{ color: '#5ddc8a' }}>Active Faction Template</strong><br />
                      <span style={{ color: 'var(--muted)' }}>Canvas #{myFactionData.faction.template_canvas_id} at ({myFactionData.faction.template_x}, {myFactionData.faction.template_y})</span>
                    </div>
                    <button
                      className="mt-btn primary btn-compact"
                      onClick={() => window.dispatchEvent(new CustomEvent('pixmap:apply-faction-template', { detail: myFactionData.faction }))}
                    >
                      🎨 Load Preset
                    </button>
                  </div>
                )}

                {myFactionData.my_role >= 3 && (
                  <details style={{ background: 'rgba(255,255,255,0.03)', padding: '8px', borderRadius: '6px', border: '1px solid var(--btn-border)' }}>
                    <summary style={{ cursor: 'pointer', fontSize: '11px', fontWeight: '600', color: 'var(--text)' }}>
                      🎨 Upload Faction Template (Max 10MB)
                    </summary>
                    <form onSubmit={handleUploadTemplate} style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                      <div className="coords-row">
                        <label>Canvas: <input type="number" className="coord-input" value={templateForm.canvas_id} onChange={e => setTemplateForm({ ...templateForm, canvas_id: parseInt(e.target.value) || 0 })} /></label>
                        <label>X: <input type="number" className="coord-input" value={templateForm.x} onChange={e => setTemplateForm({ ...templateForm, x: parseInt(e.target.value) || 0 })} /></label>
                        <label>Y: <input type="number" className="coord-input" value={templateForm.y} onChange={e => setTemplateForm({ ...templateForm, y: parseInt(e.target.value) || 0 })} /></label>
                        <button type="button" className={`mt-btn ${picking ? 'primary' : 'secondary'} btn-compact`} onClick={handlePickTemplateCoords}>
                          {picking ? '🎯 Click canvas...' : '🎯 Pick on Canvas'}
                        </button>
                      </div>
                      <input type="file" accept="image/*" className="mt-file-input" onChange={e => setTemplateForm({ ...templateForm, file: e.target.files[0] })} />
                      <button type="submit" className="mt-btn primary btn-compact" style={{ alignSelf: 'flex-start' }}>Upload & Broadcast</button>
                      {templateStatus && <div className={`mt-status ${templateStatus.type}`}>{templateStatus.msg}</div>}
                    </form>
                  </details>
                )}

                {myFactionData.my_role >= 3 && (
                  <details style={{ background: 'rgba(255,255,255,0.03)', padding: '8px', borderRadius: '6px', border: '1px solid var(--btn-border)' }}>
                    <summary style={{ cursor: 'pointer', fontSize: '11px', fontWeight: '600', color: 'var(--text)' }}>
                      📢 Post Faction Announcement
                    </summary>
                    <form onSubmit={handlePostAnnouncement} style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                      <textarea
                        className="mt-input" rows={2} placeholder="Write message for faction members..."
                        value={announcementForm.message} onChange={e => setAnnouncementForm({ ...announcementForm, message: e.target.value })}
                      />
                      <div className="coords-row">
                        <label>X: <input type="number" className="coord-input" placeholder="Opt" value={announcementForm.x} onChange={e => setAnnouncementForm({ ...announcementForm, x: e.target.value })} /></label>
                        <label>Y: <input type="number" className="coord-input" placeholder="Opt" value={announcementForm.y} onChange={e => setAnnouncementForm({ ...announcementForm, y: e.target.value })} /></label>
                      </div>
                      <button type="submit" className="mt-btn primary btn-compact" style={{ alignSelf: 'flex-start' }}>Post Announcement</button>
                      {announcementStatus && <div className={`mt-status ${announcementStatus.type}`}>{announcementStatus.msg}</div>}
                    </form>
                  </details>
                )}

                {myFactionData.announcements?.length > 0 && (
                  <div>
                    <h3 className="mt-label">Announcements</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {myFactionData.announcements.map(a => (
                        <div key={a.id} className="chat-system">
                          <span className="chat-system-icon">📢</span>
                          <div style={{ flex: 1, fontSize: '11px' }}>
                            <strong>{a.author_username}:</strong> {a.message}
                            {a.x !== null && a.y !== null && (
                              <button
                                style={{ background: 'none', border: 'none', color: '#5b9cff', cursor: 'pointer', marginLeft: '6px', textDecoration: 'underline' }}
                                onClick={() => canvasRef.current?.navigateTo(a.x, a.y)}
                              >
                                ({a.x}, {a.y})
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <h3 className="mt-label">Members Roster</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {myFactionData.roster.map(m => (
                      <div key={m.user_id} className="user-row" style={{ padding: '6px 8px' }}>
                        <img src={getAvatarUrl(m)} alt="" className="urow-avatar" />
                        <div className="urow-info" style={{ flex: 1 }}>
                          <span className="urow-name">{m.username}</span>
                          <span className={`role-badge ${roleBadgeClass(m.role)}`}>{roleLabel(m.role)}</span>
                          <span className="urow-stat">🎨 {m.total_pixels.toLocaleString()} total px</span>
                        </div>
                        {myFactionData.my_role >= 3 && m.user_id !== currentUser?.id && m.role < myFactionData.my_role && (
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                            <select className="role-sel" value={m.role} onChange={e => handleUpdateRole(m.user_id, parseInt(e.target.value))}>
                              {myFactionData.my_role === 4 && <option value={4}>👑 Transfer Ownership</option>}
                              <option value={1}>Soldier</option>
                              <option value={2}>General</option>
                              {myFactionData.my_role === 4 && <option value={3}>Admin</option>}
                            </select>
                            <button className="mt-btn danger-sm" onClick={() => handleKickMember(m.user_id)}>Kick</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showCreateModal && (
        <div className="announcement-overlay" onClick={e => { if (e.target === e.currentTarget) setShowCreateModal(false) }}>
          <div className="announcement-card" style={{ maxWidth: '420px' }}>
            <div className="announcement-header">
              <span className="announcement-badge">🛡️ Create Faction</span>
              <button type="button" className="panel-close" onClick={() => setShowCreateModal(false)}>✕</button>
            </div>
            <form onSubmit={handleCreateFaction} style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '11px', color: 'var(--muted)' }}>Faction Name:
                <input type="text" className="mt-input" required value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })} />
              </label>
              <label style={{ fontSize: '11px', color: 'var(--muted)' }}>Description:
                <textarea className="mt-input" rows={2} value={createForm.description} onChange={e => setCreateForm({ ...createForm, description: e.target.value })} />
              </label>
              <div style={{ display: 'flex', gap: '10px' }}>
                <label style={{ fontSize: '11px', color: 'var(--muted)', flex: 1 }}>Color:
                  <input type="color" className="mt-input" style={{ height: '30px', padding: '2px' }} value={createForm.color} onChange={e => setCreateForm({ ...createForm, color: e.target.value })} />
                </label>
                <label style={{ fontSize: '11px', color: 'var(--muted)', flex: 1 }}>Access:
                  <select className="mt-input" value={createForm.is_public ? 'public' : 'private'} onChange={e => setCreateForm({ ...createForm, is_public: e.target.value === 'public' })}>
                    <option value="private">Invite Only</option>
                    <option value="public">Public</option>
                  </select>
                </label>
              </div>
              {(() => {
                const sim = findSimilarFactionColor(createForm.color, factions)
                if (!sim) return null
                return (
                  <div style={{ background: 'rgba(234, 179, 8, 0.12)', border: '1px solid rgba(234, 179, 8, 0.4)', borderRadius: '4px', padding: '6px 8px', fontSize: '11px', color: '#fde047', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>⚠️</span>
                    <span>This color is very similar to <strong>{sim.name}</strong> (<span style={{ display: 'inline-block', width: '9px', height: '9px', background: sim.color, borderRadius: '2px', verticalAlign: 'middle' }}></span> {sim.color}). Territory borders may blend together on canvas.</span>
                  </div>
                )
              })()}
              <label style={{ fontSize: '11px', color: 'var(--muted)' }}>Min Pixels to Join: ({createForm.min_join_px.toLocaleString()} px)
                <input type="range" min={10000} max={1000000} step={10000} value={createForm.min_join_px} onChange={e => setCreateForm({ ...createForm, min_join_px: parseInt(e.target.value) })} style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: '11px', color: 'var(--muted)' }}>Logo (max 2MB; resized to 50×50):
                <input type="file" accept="image/*" className="mt-file-input" onChange={e => setCreateForm({ ...createForm, logoFile: e.target.files[0] })} />
              </label>
              {createError && <div className="mt-status error">{createError}</div>}
              <button type="submit" className="mt-btn primary" style={{ marginTop: '8px' }}>Create Faction</button>
            </form>
          </div>
        </div>
      )}

      {showInviteModal && (
        <div className="announcement-overlay" onClick={e => { if (e.target === e.currentTarget) setShowInviteModal(false) }}>
          <div className="announcement-card" style={{ maxWidth: '380px' }}>
            <div className="announcement-header">
              <span className="announcement-badge">✉️ Invite Member</span>
              <button type="button" className="panel-close" onClick={() => setShowInviteModal(false)}>✕</button>
            </div>
            <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <input
                type="text" className="mt-input" placeholder="Search username..."
                value={inviteSearchQuery} onChange={e => setInviteSearchQuery(e.target.value)}
              />
              <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {inviteUsersList.map(u => (
                  <div
                    key={u.id}
                    className={`user-row ${selectedInviteUser?.id === u.id ? 'active-sub' : ''}`}
                    onClick={() => setSelectedInviteUser(u)}
                    style={{ cursor: 'pointer', padding: '4px 8px' }}
                  >
                    <img src={getAvatarUrl(u)} alt="" className="urow-avatar" style={{ width: '22px', height: '22px' }} />
                    <span className="urow-name">{u.username}</span>
                  </div>
                ))}
              </div>
              {inviteStatus && <div className={`mt-status ${inviteStatus.type}`}>{inviteStatus.msg}</div>}
              <button className="mt-btn primary" disabled={!selectedInviteUser} onClick={handleSendInvite}>
                Send Invite{selectedInviteUser ? ` to ${selectedInviteUser.username}` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettingsModal && (
        <div className="announcement-overlay" onClick={e => { if (e.target === e.currentTarget) setShowSettingsModal(false) }}>
          <div className="announcement-card" style={{ maxWidth: '400px' }}>
            <div className="announcement-header">
              <span className="announcement-badge">⚙️ Faction Settings</span>
              <button type="button" className="panel-close" onClick={() => setShowSettingsModal(false)}>✕</button>
            </div>
            <form onSubmit={handleSaveSettings} style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '11px', color: 'var(--muted)' }}>Description:
                <textarea className="mt-input" rows={2} value={settingsForm.description} onChange={e => setSettingsForm({ ...settingsForm, description: e.target.value })} />
              </label>
              <div style={{ display: 'flex', gap: '10px' }}>
                <label style={{ fontSize: '11px', color: 'var(--muted)', flex: 1 }}>Color:
                  <input type="color" className="mt-input" style={{ height: '30px', padding: '2px' }} value={settingsForm.color} onChange={e => setSettingsForm({ ...settingsForm, color: e.target.value })} />
                </label>
                <label style={{ fontSize: '11px', color: 'var(--muted)', flex: 1 }}>Access:
                  <select className="mt-input" value={settingsForm.is_public ? 'public' : 'private'} onChange={e => setSettingsForm({ ...settingsForm, is_public: e.target.value === 'public' })}>
                    <option value="private">Invite Only</option>
                    <option value="public">Public</option>
                  </select>
                </label>
              </div>
              {(() => {
                const sim = findSimilarFactionColor(settingsForm.color, factions, myFactionData?.faction?.id)
                if (!sim) return null
                return (
                  <div style={{ background: 'rgba(234, 179, 8, 0.12)', border: '1px solid rgba(234, 179, 8, 0.4)', borderRadius: '4px', padding: '6px 8px', fontSize: '11px', color: '#fde047', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span>⚠️</span>
                    <span>This color is very similar to <strong>{sim.name}</strong> (<span style={{ display: 'inline-block', width: '9px', height: '9px', background: sim.color, borderRadius: '2px', verticalAlign: 'middle' }}></span> {sim.color}). Territory borders may blend together on canvas.</span>
                  </div>
                )
              })()}
              <label style={{ fontSize: '11px', color: 'var(--muted)' }}>Min Pixels to Join: ({settingsForm.min_join_px.toLocaleString()} px)
                <input type="range" min={10000} max={1000000} step={10000} value={settingsForm.min_join_px} onChange={e => setSettingsForm({ ...settingsForm, min_join_px: parseInt(e.target.value) })} style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: '11px', color: 'var(--muted)' }}>Update logo (optional, max 2MB; resized to 50×50):
                <input type="file" accept="image/*" className="mt-file-input" onChange={e => setSettingsForm({ ...settingsForm, logoFile: e.target.files[0] })} />
              </label>
              <button type="submit" className="mt-btn primary" style={{ marginTop: '8px' }}>Save Settings</button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
