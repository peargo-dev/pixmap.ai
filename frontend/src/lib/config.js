const proto = location.protocol === 'https:' ? 'wss' : 'ws'

export const API_BASE = `${location.protocol}//${location.host}`
export const WS_URL = `${proto}://${location.host}/ws`
export const CHUNK_PX = 256
export const MIN_SCALE = 0.01
export const MAX_SCALE = 40
