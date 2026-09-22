import { useState, useRef, useEffect, useCallback } from 'react'
import FlairBadge from '../FlairBadge'
import ChatMessageText from '../ChatMessageText'
import { getAvatarUrl } from '../../lib/avatar.js'

const ROLE_MOD = 100
const DEFAULT_CHAT_MIN_PIXELS = 5000
const HOVER_REPLY_MS = 1000

const COUNTRY_MAP = {
  TR: { code: 'TUR', name: 'Turkish', flag: '🇹🇷' },
  ES: { code: 'ESP', name: 'Spanish', flag: '🇪🇸' },
  SP: { code: 'ESP', name: 'Spanish', flag: '🇪🇸' },
  DE: { code: 'GER', name: 'German', flag: '🇩🇪' },
  FR: { code: 'FRA', name: 'French', flag: '🇫🇷' },
  UA: { code: 'UKR', name: 'Ukrainian', flag: '🇺🇦' },
  RU: { code: 'RUS', name: 'Russian', flag: '🇷🇺' },
}

const MOD_CHANNEL_OPTIONS = [
  { code: 'TUR', name: 'Turkish', flag: '🇹🇷' },
  { code: 'ESP', name: 'Spanish', flag: '🇪🇸' },
  { code: 'GER', name: 'German', flag: '🇩🇪' },
  { code: 'FRA', name: 'French', flag: '🇫🇷' },
  { code: 'UKR', name: 'Ukrainian', flag: '🇺🇦' },
  { code: 'RUS', name: 'Russian', flag: '🇷🇺' },
]

export function getCountryInfo(code) {
  if (!code) return null
  const c = String(code).toUpperCase().trim()
  return COUNTRY_MAP[c] || null
}

export default function ChatPanel({
  messages,
  currentUser,
  pixelCount,
  socket,
  icons,
  users = {},
  activeChannel = 'ENG',
  onChangeChannel,
  onClose
}) {
  const [input, setInput]         = useState('')
  const [replyingTo, setReplyingTo] = useState(null)   // { name, messageId }
  const [actionMenu, setActionMenu] = useState(null)   // { msg, x, y }
  const [mentionMenu, setMentionMenu] = useState(null) // { query, x, y, index }
  const boxRef                    = useRef(null)
  const inputRef                  = useRef(null)
  const hoverTimerRef             = useRef(null)
  const touchTimerRef             = useRef(null)
  const actionMenuRef             = useRef(null)

  const isMod      = (currentUser?.role ?? 0) >= ROLE_MOD
  const pixels     = pixelCount ?? currentUser?.pixels_placed ?? 0
  const minPixels  = currentUser?.chat_min_pixels ?? DEFAULT_CHAT_MIN_PIXELS
  const needsPixels = !!currentUser && !isMod && minPixels > 0 && pixels < minPixels
  const canChat    = !!currentUser && !needsPixels

  const userCountryInfo = getCountryInfo(currentUser?.country)

  // Available tabs for current user
  const channelTabs = [
    { code: 'ENG', label: 'ENG', flag: '🇬🇧', title: 'Main Chat (English Only)' },
    { code: 'INT', label: 'INT', flag: '🌐', title: 'International Chat (All Languages)' }
  ]

  if (userCountryInfo) {
    channelTabs.push({
      code: userCountryInfo.code,
      label: userCountryInfo.code,
      flag: userCountryInfo.flag,
      title: `${userCountryInfo.name} Chat`
    })
  }

  useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [messages])

  // Close action menu on outside click
  useEffect(() => {
    if (!actionMenu) return
    const handler = e => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target)) {
        setActionMenu(null)
      }
    }
    window.addEventListener('mousedown', handler)
    window.addEventListener('touchstart', handler)
    return () => {
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('touchstart', handler)
    }
  }, [actionMenu])

  // Build user list from messages (real state → always current) + merge avatars from users prop
  const userList = (() => {
    const seen = new Map()
    for (const m of messages) {
      if (m.userId && m.name && m.name !== 'System' && !seen.has(m.userId)) {
        const u = users[m.userId] || {}
        seen.set(m.userId, {
          id: String(m.userId),
          username: m.name,
          avatar: u.avatar || m.avatar || null,
          discord_id: u.discord_id || m.discord_id || null,
          role: m.role || 0,
        })
      }
    }
    return Array.from(seen.values())
  })()

  // Detect @mention query in input
  function detectMentionQuery(val) {
    const cursorPos = inputRef.current?.selectionStart ?? val.length
    const before = val.slice(0, cursorPos)
    const atMatch = before.match(/@([a-zA-Z0-9_]*)$/)
    if (!atMatch) return null
    return atMatch[1].toLowerCase()
  }

  function getFilteredUsers(query) {
    if (query === null) return []
    return userList
      .filter(u => u.username.toLowerCase().startsWith(query))
      .slice(0, 8)
  }

  function doSend() {
    const txt = input.trim()
    if (!txt || !socket) return
    const isVoidCmd = txt.toLowerCase() === '!void'
    if (!isVoidCmd && !canChat) return

    let finalText = txt
    if (replyingTo) {
      // Prefix with @username if not already there
      const prefix = `@${replyingTo.name} `
      if (!finalText.startsWith(prefix)) {
        finalText = prefix + finalText
      }
    }

    socket.sendChat(finalText, activeChannel)
    setInput('')
    setReplyingTo(null)
    setMentionMenu(null)
  }

  function handleKey(e) {
    // Navigate mention menu with arrow keys
    if (mentionMenu && mentionMenu.users?.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionMenu(m => ({ ...m, index: Math.min(m.index + 1, m.users.length - 1) }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionMenu(m => ({ ...m, index: Math.max(m.index - 1, 0) }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = mentionMenu.users[mentionMenu.index]
        if (selected) insertMention(selected.username)
        return
      }
      if (e.key === 'Escape') {
        setMentionMenu(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  function handleInputChange(e) {
    const val = e.target.value
    setInput(val)

    const query = detectMentionQuery(val)
    if (query !== null) {
      const filtered = getFilteredUsers(query)
      if (filtered.length > 0) {
        setMentionMenu({ query, users: filtered, index: 0 })
      } else {
        setMentionMenu(null)
      }
    } else {
      setMentionMenu(null)
    }
  }

  function insertMention(username) {
    const val = input
    const cursorPos = inputRef.current?.selectionStart ?? val.length
    const before = val.slice(0, cursorPos)
    const after = val.slice(cursorPos)
    const atIdx = before.lastIndexOf('@')
    const newVal = before.slice(0, atIdx) + '@' + username + ' ' + after
    setInput(newVal)
    setMentionMenu(null)
    setTimeout(() => {
      inputRef.current?.focus()
      const pos = atIdx + username.length + 2
      inputRef.current?.setSelectionRange(pos, pos)
    }, 0)
  }

  function openReply(msg) {
    setReplyingTo({ name: msg.name, messageId: msg.messageId })
    setActionMenu(null)
    // Pre-fill @username in input if empty
    if (!input.trim()) {
      setInput(`@${msg.name} `)
    }
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  // ── Hover / touch-hold handlers ───────────────────────────────────────────
  function handleMouseEnter(e, msg) {
    const el = e.currentTarget
    hoverTimerRef.current = setTimeout(() => {
      const rect = el.getBoundingClientRect()
      setActionMenu({ msg, x: rect.right - 4, y: rect.top })
    }, HOVER_REPLY_MS)
  }

  function handleMouseLeave() {
    clearTimeout(hoverTimerRef.current)
  }

  function handleTouchStart(e, msg) {
    const touch = e.touches[0]
    touchTimerRef.current = setTimeout(() => {
      setActionMenu({ msg, x: touch.clientX, y: touch.clientY - 40 })
    }, HOVER_REPLY_MS)
  }

  function handleTouchEnd() {
    clearTimeout(touchTimerRef.current)
  }

  function handleTouchMove() {
    clearTimeout(touchTimerRef.current)
  }

  // ── Message renderer ──────────────────────────────────────────────────────
  function renderMessage(m, i) {
    const isSystem = m.userId === 0 || m.name === 'System'
    if (isSystem) {
      return (
        <div key={`${m.messageId}-${i}`} className="chat-msg chat-system">
          <span className="chat-system-icon">⚙</span>
          <span className="chat-system-text"><ChatMessageText text={m.message} currentUsername={currentUser?.username} /></span>
        </div>
      )
    }

    const flair    = m.flair   || {}
    const role     = m.role    || 0
    const us       = flair.us  || null  // username style
    const ms       = flair.ms  || null  // message style

    // Highlight row if current user is mentioned
    const myName = currentUser?.username
    const isMentioned = myName && m.message && new RegExp(`@${myName}\\b`, 'i').test(m.message)

    return (
      <div
        key={`${m.messageId}-${i}`}
        className={`chat-msg${ms ? ` msg-${ms}` : ''}${isMentioned ? ' chat-msg-mention' : ''}`}
        onMouseEnter={e => handleMouseEnter(e, m)}
        onMouseLeave={handleMouseLeave}
        onTouchStart={e => handleTouchStart(e, m)}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
      >
        <FlairBadge role={role} flair={flair} icons={icons} />
        <span className={`chat-name${us ? ` un-${us}` : ''} role-color-${role}`}>
          {m.name}
        </span>
        <span className="chat-text"> <ChatMessageText text={m.message} currentUsername={currentUser?.username} /></span>
      </div>
    )
  }

  let placeholder = 'Login to chat'
  if (currentUser) {
    placeholder = needsPixels
      ? `Need ${minPixels.toLocaleString()} pixels to chat · !void works`
      : `Say something in ${activeChannel}… (@ to mention)`
  }

  const canType = !!currentUser

  // Filter messages by active channel if message objects contain channel tag
  const filteredMessages = messages.filter(m => !m.channel || m.channel === activeChannel)

  return (
    <div id="panel-chat" className="panel chat-panel">
      <div className="panel-header">
        <span>Chat</span>
        <button className="panel-close" onClick={onClose}>✕</button>
      </div>

      {/* Language Channel Tabs Bar */}
      <div className="chat-channels-bar">
        {channelTabs.map(tab => (
          <button
            key={tab.code}
            className={`chat-channel-tab ${activeChannel === tab.code ? 'active' : ''}`}
            onClick={() => onChangeChannel && onChangeChannel(tab.code)}
            title={tab.title}
          >
            <span className="channel-flag">{tab.flag}</span>
            <span className="channel-code">{tab.label}</span>
          </button>
        ))}

        {isMod && (
          <select
            className="chat-channel-select-mod"
            value={activeChannel}
            onChange={e => onChangeChannel && onChangeChannel(e.target.value)}
            title="Moderator Channel Switcher"
          >
            <option value="ENG">🇬🇧 ENG</option>
            <option value="INT">🌐 INT</option>
            {MOD_CHANNEL_OPTIONS.map(c => (
              <option key={c.code} value={c.code}>
                {c.flag} {c.code} ({c.name})
              </option>
            ))}
          </select>
        )}
      </div>

      <div id="chat-messages" className="chat-messages" ref={boxRef}>
        {filteredMessages.slice(-150).map((m, i) => renderMessage(m, i))}
      </div>

      {needsPixels && (
        <div className="chat-pixel-gate">
          Place <strong>{minPixels.toLocaleString()}</strong> pixels to unlock chat.
          <span> You have {pixels.toLocaleString()} / {minPixels.toLocaleString()}.</span>
        </div>
      )}

      {isMod && (
        <div className="chat-mod-hint">
          <span>Commands: <code>/mute id/name secs</code> · <code>/unmute id/name</code> · <code>/purge id/name count</code></span>
        </div>
      )}

      {/* Reply banner */}
      {replyingTo && (
        <div className="chat-reply-bar">
          <span className="chat-reply-label">
            Replying to <strong>@{replyingTo.name}</strong>
          </span>
          <button
            className="chat-reply-cancel"
            onClick={() => { setReplyingTo(null); setInput('') }}
            title="Cancel reply"
          >✕</button>
        </div>
      )}

      {/* @mention autocomplete — rendered in normal flex flow just above the input */}
      {mentionMenu && mentionMenu.users?.length > 0 && (
        <div className="chat-mention-autocomplete">
          {mentionMenu.users.map((u, idx) => (
            <button
              key={u.id}
              className={`chat-mention-option${idx === mentionMenu.index ? ' selected' : ''}`}
              onMouseDown={e => { e.preventDefault(); insertMention(u.username) }}
            >
              <img
                className="chat-mention-avatar"
                src={getAvatarUrl(u, 40)}
                alt=""
                onError={e => {
                  e.currentTarget.onerror = null
                  e.currentTarget.src = 'https://cdn.discordapp.com/embed/avatars/0.png'
                }}
              />
              <span className="chat-mention-name">{u.username}</span>
            </button>
          ))}
        </div>
      )}

      <div className="chat-input-row">
        <input
          id="chat-input"
          ref={inputRef}
          className="chat-input"
          type="text"
          maxLength={200}
          placeholder={placeholder}
          disabled={!canType}
          autoComplete="off"
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKey}
        />
        <button
          id="chat-send"
          className="chat-send-btn"
          disabled={!canType}
          onClick={doSend}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      {/* Hover / hold action menu */}
      {actionMenu && (
        <div
          ref={actionMenuRef}
          className="chat-msg-action-menu"
          style={{
            position: 'fixed',
            left: Math.min(actionMenu.x, window.innerWidth - 120),
            top: Math.max(actionMenu.y - 4, 4),
          }}
        >
          <button
            className="chat-msg-action-btn"
            onMouseDown={e => { e.preventDefault(); openReply(actionMenu.msg) }}
          >
            ↩ Reply
          </button>
        </div>
      )}
    </div>
  )
}
