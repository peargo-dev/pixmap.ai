import { WS_URL } from './config.js'

const OP = {
  PING:              0x00,
  PLACE:             0x10,
  SET_CANVAS:        0x11,
  CHUNK_SUBSCRIBE:   0x12,
  CHUNK_UNSUBSCRIBE: 0x13,
  PLACE_RETURN:      0x14,
  COOLDOWN:          0x15,
  REFRESH_CHUNKS:    0x16,
  ALERT:             0x40,
  ONLINE:            0xB1,
  DELETE_MESSAGES:   0xC1,
  CHAT_ERROR:        0xC2,
  CHAT:              'c',
  VOID_STATE:        'v',
  CAPTCHA:           's',
  ANNOUNCEMENT:      'a',
  FACTION_INVITE:       'fi',
  FACTION_ANNOUNCEMENT: 'fa',
  FACTION_TEMPLATE:     'ft',
  FACTION_VIEW:         'fv',
  FACTION_WARN:         'fw',
}

class PixmapSocket extends EventTarget {
  constructor() {
    super()
    this._ws = null
    this._delay = 1000
    this._pingTimer = null
    this._reconnectTimer = null
    this._dead = false
    this._currentCanvasStack = 120000 // default stack size
  }

  setCurrentCanvasStack(stack) {
    this._currentCanvasStack = stack || 120000
  }

  get readyState() {
    return this._ws?.readyState ?? WebSocket.CLOSED
  }

  connect() {
    if (this._dead) return
    const state = this._ws?.readyState
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return

    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null

    // Drop any stale socket before opening a new one.
    if (this._ws) {
      this._ws.onopen = null
      this._ws.onclose = null
      this._ws.onmessage = null
      this._ws.onerror = null
      if (state !== WebSocket.CLOSED) this._ws.close()
      this._ws = null
    }

    const ws = new WebSocket(WS_URL)
    this._ws = ws
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('open',    () => { if (this._ws === ws) this._onOpen() })
    ws.addEventListener('close',   e  => { if (this._ws === ws) this._onClose(e) })
    ws.addEventListener('message', e  => { if (this._ws === ws) this._onMessage(e) })
    ws.addEventListener('error',   () => { if (this._ws === ws) this._onError() })
  }

  /** Reconnect immediately when the socket is closed; no-op while open/connecting. */
  reconnect() {
    if (this._dead) return
    const state = this.readyState
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    this._delay = 1000
    this.connect()
  }

  sendPing() {
    this._send(new Uint8Array([OP.PING]))
  }

  destroy() {
    this._dead = true
    clearInterval(this._pingTimer)
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    this._ws?.close()
  }

  _onOpen() {
    this._delay = 1000
    clearInterval(this._pingTimer)
    this._pingTimer = setInterval(() => this._send(new Uint8Array([OP.PING])), 20000)
    this.dispatchEvent(new Event('connect'))
  }

  _onError() {
    this.dispatchEvent(new Event('error'))
  }

  _onClose(e) {
    clearInterval(this._pingTimer)
    this._ws = null
    this.dispatchEvent(new CustomEvent('disconnect', { detail: e.code }))
    if (!this._dead) {
      this._reconnectTimer = setTimeout(() => this.connect(), this._delay)
      this._delay = Math.min(this._delay * 2, 30000)
    }
  }

  _onMessage(e) {
    // ── Text messages: chat broadcasts ──────────────────────────────────────
    if (typeof e.data === 'string') {
      if (e.data[0] === OP.CHAT) {
        try {
          // Server format: c[userid, [username, avatar, role, flair] | [], msg, msgId, timestamp, channel]
          const payload = JSON.parse(e.data.slice(1))
          if (Array.isArray(payload)) {
            const [userId, userInfo, message, messageId, timestamp, channel = 'ENG'] = payload
            this.dispatchEvent(new CustomEvent('chat', {
              detail: { userId, userInfo, message, messageId, timestamp, channel: channel || 'ENG' }
            }))
          }
        } catch { }
      } else if (e.data[0] === OP.VOID_STATE) {
        try {
          const state = JSON.parse(e.data.slice(1))
          this.dispatchEvent(new CustomEvent('void_state', { detail: state }))
        } catch { }
      } else if (e.data[0] === OP.CAPTCHA) {
        try {
          const [success] = JSON.parse(e.data.slice(1))
          this.dispatchEvent(new CustomEvent('captcha', { detail: { success: !!success } }))
        } catch { }
      } else if (e.data[0] === OP.ANNOUNCEMENT) {
        try {
          const detail = JSON.parse(e.data.slice(1))
          this.dispatchEvent(new CustomEvent('announcement', { detail }))
        } catch { }
      } else if (e.data.startsWith(OP.FACTION_INVITE)) {
        try {
          const detail = JSON.parse(e.data.slice(OP.FACTION_INVITE.length))
          this.dispatchEvent(new CustomEvent('faction_invite', { detail }))
        } catch { }
      } else if (e.data.startsWith(OP.FACTION_ANNOUNCEMENT)) {
        try {
          const detail = JSON.parse(e.data.slice(OP.FACTION_ANNOUNCEMENT.length))
          this.dispatchEvent(new CustomEvent('faction_announcement', { detail }))
        } catch { }
      } else if (e.data.startsWith(OP.FACTION_TEMPLATE)) {
        try {
          const detail = JSON.parse(e.data.slice(OP.FACTION_TEMPLATE.length))
          this.dispatchEvent(new CustomEvent('faction_template', { detail }))
        } catch { }
      } else if (e.data.startsWith(OP.FACTION_VIEW)) {
        try {
          const detail = JSON.parse(e.data.slice(OP.FACTION_VIEW.length))
          this.dispatchEvent(new CustomEvent('faction_view', { detail }))
        } catch { }
      } else if (e.data.startsWith(OP.FACTION_WARN)) {
        try {
          const detail = JSON.parse(e.data.slice(OP.FACTION_WARN.length))
          this.dispatchEvent(new CustomEvent('faction_warn', { detail }))
        } catch { }
      }
      return
    }

    // ── Binary messages ──────────────────────────────────────────────────────
    const data = new Uint8Array(e.data)
    const op   = data[0]

    // ONLINE  →  op(1) + count_u16(2)
    if (op === OP.ONLINE) {
      const count = (data[1] << 8) | data[2]
      this.dispatchEvent(new CustomEvent('online', { detail: count }))
      return
    }

    // PLACE (broadcast from server)  →  op(1) + cx(1) + cy(1) + [offset_u16 + color]…
    if (op === OP.PLACE) {
      const cx = data[1]
      const cy = data[2]
      const pixels = []
      for (let i = 3; i + 2 < data.length; i += 3) {
        const offset = (data[i] << 8) | data[i + 1]
        pixels.push({ cx, cy, offset, color: data[i + 2] })
      }
      this.dispatchEvent(new CustomEvent('place', { detail: pixels }))
      return
    }

    // PLACE_RETURN  →  op(1) + cx(1) + cy(1) + code(1)
    //   [+ placed_u16(2) + ranked_u16(2) + new_cd_u32(4) + max_cd_u32(4) when code==0]
    if (op === OP.PLACE_RETURN) {
      const cx = data[1]
      const cy = data[2]
      const code = data[3]
      const detail = { cx, cy, code }
      if (code === 0) {
        const view = new DataView(e.data)
        detail.placed_pixels   = view.getUint16(4, false)
        detail.ranked_pixels   = view.getUint16(6, false)
        detail.new_cooldown_ms = view.getUint32(8, false)
        detail.max_cooldown_ms = view.getUint32(12, false)
      }
      this.dispatchEvent(new CustomEvent('place_status', { detail }))
      if (code === 0) {
        this.dispatchEvent(new CustomEvent('cooldown', {
          detail: {
            remaining: detail.new_cooldown_ms,
            max: detail.max_cooldown_ms,
          },
        }))
        if (detail.ranked_pixels > 0) {
          this.dispatchEvent(new CustomEvent('pixel_placed', { detail: detail.ranked_pixels }))
        }
      }
      return
    }

    // COOLDOWN (sent on connect)  →  op(1) + [canvas_id(1) + cooldown_ms_u32(4)]…
    if (op === OP.COOLDOWN) {
      const view = new DataView(e.data)
      for (let offset = 1; offset + 5 <= e.data.byteLength; offset += 5) {
        const canvasId = data[offset]
        const remaining = view.getUint32(offset + 1, false)
        this.dispatchEvent(new CustomEvent('cooldown', {
          detail: { remaining, max: this._currentCanvasStack, canvasId },
        }))
      }
      return
    }

    // REFRESH_CHUNKS  →  op(1) + canvas_id(1) + [cx(1) + cy(1)]…
    if (op === OP.REFRESH_CHUNKS) {
      const canvasId = data[1]
      const chunks = []
      for (let i = 2; i + 1 < data.length; i += 2) {
        chunks.push({ cx: data[i], cy: data[i + 1] })
      }
      if (chunks.length) {
        this.dispatchEvent(new CustomEvent('refresh_chunks', {
          detail: { canvasId, chunks },
        }))
      }
      return
    }

    // CHAT_ERROR  →  op(1) + error_code(1)
    if (op === OP.CHAT_ERROR) {
      this.dispatchEvent(new CustomEvent('chat_error', { detail: data[1] }))
      return
    }

    // DELETE_MESSAGES  →  op(1) + [uint32 id]×n  (big-endian 4-byte IDs)
    if (op === OP.DELETE_MESSAGES) {
      const view = new DataView(e.data)
      const ids  = []
      for (let offset = 1; offset + 3 < e.data.byteLength; offset += 4) {
        ids.push(view.getUint32(offset, false))
      }
      if (ids.length) this.dispatchEvent(new CustomEvent('delete_messages', { detail: ids }))
      return
    }

    // ALERT  →  op(1) + len_u16(2) + utf8_bytes
    if (op === OP.ALERT) {
      const len = (data[1] << 8) | data[2]
      const msg = new TextDecoder().decode(data.slice(3, 3 + len))
      this.dispatchEvent(new CustomEvent('alert', { detail: msg }))
    }
  }

  _send(buf) {
    if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(buf)
  }

  sendSetCanvas(id) {
    this._send(new Uint8Array([OP.SET_CANVAS, id]))
  }

  sendSubscribe(chunks) {
    const buf = new Uint8Array(1 + chunks.length * 2)
    buf[0] = OP.CHUNK_SUBSCRIBE
    chunks.forEach(({ cx, cy }, i) => { buf[1 + i*2] = cx; buf[2 + i*2] = cy })
    this._send(buf)
  }

  sendUnsubscribe(chunks) {
    const buf = new Uint8Array(1 + chunks.length * 2)
    buf[0] = OP.CHUNK_UNSUBSCRIBE
    chunks.forEach(({ cx, cy }, i) => { buf[1 + i*2] = cx; buf[2 + i*2] = cy })
    this._send(buf)
  }

  sendPlace(cx, cy, pixels) {
    const buf = new Uint8Array(3 + pixels.length * 3)
    buf[0] = OP.PLACE; buf[1] = cx; buf[2] = cy
    for (let i = 0; i < pixels.length; i++) {
      const b = 3 + i * 3
      buf[b]     = (pixels[i].offset >> 8) & 0xff
      buf[b + 1] = pixels[i].offset & 0xff
      buf[b + 2] = pixels[i].color
    }
    this._send(buf)
  }

  sendChat(text, channel = 'ENG') {
    // Server expects: c["text", "channel"]
    this._send(`c${JSON.stringify([text, channel])}`)
  }

  sendCaptcha(token) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.removeEventListener('captcha', onCaptcha)
        resolve(false)
      }, 15000)

      const onCaptcha = (e) => {
        clearTimeout(timeout)
        this.removeEventListener('captcha', onCaptcha)
        resolve(e.detail.success)
      }

      this.addEventListener('captcha', onCaptcha)
      this._send(`s${JSON.stringify([token])}`)
    })
  }
}

export default new PixmapSocket()
