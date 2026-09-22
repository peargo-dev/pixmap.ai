import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchCanvases, fetchHistoryEnabled } from './lib/api.js'
import socket from './lib/ws.js'
import { parseHash, hashToViewport, computeCenter, centerForHash } from './lib/hashViewport.js'

import Canvas from './components/Canvas.jsx'
import HUD from './components/HUD.jsx'
import Palette from './components/Palette.jsx'
import CooldownBar from './components/CooldownBar.jsx'
import ToastContainer from './components/ToastContainer.jsx'
import HelpPanel from './components/panels/HelpPanel.jsx'
import UserPanel from './components/panels/UserPanel.jsx'
import ChatPanel from './components/panels/ChatPanel.jsx'
import ModtoolsPanel from './components/panels/ModtoolsPanel.jsx'
import SettingsPanel from './components/panels/SettingsPanel.jsx'
import TemplatePanel from './components/panels/TemplatePanel.jsx'
import StatsPanel from './components/panels/StatsPanel.jsx'
import FactionsPanel from './components/panels/FactionsPanel.jsx'
import TurnstileModal from './components/TurnstileModal.jsx'
import BanModal from './components/BanModal.jsx'
import AnnouncementModal from './components/AnnouncementModal.jsx'
import ExternalLinkModal from './components/ExternalLinkModal.jsx'
import HistoryBar, { dayFromTs } from './components/HistoryBar.jsx'
import { useCooldownRemaining } from './hooks/useCooldownRemaining.js'
import { useCooldownTabTitle } from './hooks/useCooldownTabTitle.js'
import {
  stripTemplateUiFields,
  templateMetadataForStorage,
  saveTemplateImageToDB,
  buildTemplateAssets,
  makeTemplateThumbnail,
  getCanvasCenter,
  worldCoordsFromCenter
} from './lib/canvas/templates.js'
import { resolveSelectedColor, saveSelectedColor } from './lib/canvas/colorStorage.js'
import {
  playAlert,
  playChatMessage,
  playNotification,
  playPixelPlaced,
  playStackUsedUp,
  resumeSoundContext,
} from './lib/sounds.js'

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

const DB_NAME = 'PixmapTemplates'
const DB_VERSION = 1
const STORE_NAME = 'images'

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

async function getImageFromDB(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function buildFromBlob(blob) {
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.src = url
  await img.decode()
  const bitmap = await createImageBitmap(img)
  
  const samplerCanvas = document.createElement('canvas')
  samplerCanvas.width = img.naturalWidth
  samplerCanvas.height = img.naturalHeight
  const ctx = samplerCanvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  
  URL.revokeObjectURL(url)
  return { bitmap, samplerCanvas, width: bitmap.width, height: bitmap.height }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('pixmap:toast', { detail: { msg, type } }))
}

function setCooldownUI(remaining_ms, max_ms) {
  window.dispatchEvent(new CustomEvent('pixmap:cooldown', { detail: { remaining_ms, max_ms } }))
}

function normalizeMsg([userId, userInfo, message, messageId, timestamp, channel], usersMap) {
  const u = usersMap[userId] || {}
  const name = (Array.isArray(userInfo) && userInfo[0]) || u.username || `User ${userId}`
  const role = (Array.isArray(userInfo) && userInfo[2] !== undefined) ? userInfo[2] : (u.role || 0)
  const flair = (Array.isArray(userInfo) && userInfo[3]) || u.flair || {}
  return {
    userId,
    name,
    role,
    flair,
    message,
    messageId,
    timestamp,
    channel: (channel || 'ENG').toUpperCase()
  }
}

async function fetchChatChannel(channelId = 'ENG') {
  const r = await fetch(`/api/channels/${channelId}`)
  if (!r.ok) return null
  return r.json()
}

function normalizeColors(cfg) {
  return { ...cfg, colors: cfg.colors.map(c => Array.isArray(c) ? c : [c[0], c[1], c[2]]) }
}


const BRUSH_CYCLE_BASE  = [1, 3, 5]
const BRUSH_CYCLE_STAFF = [1, 3, 5, 7, 9, 11]
const PANEL_NAMES = ['help', 'user', 'chat', 'modtools', 'settings', 'templates', 'stats']

function getFirstOpenPanel(openPanels) {
  return PANEL_NAMES.find(name => openPanels[name]) ?? null
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  const [currentUser, setCurrentUser] = useState(null)
  const [configs, setConfigs] = useState({})
  const configsRef = useRef({})
  configsRef.current = configs
  const [canvasId, setCanvasId] = useState(0)
  const [canvasName, setCanvasName] = useState('—')
  const [colors, setColors] = useState([])
  const [online, setOnline] = useState(0)
  const [wsConnected, setWsConnected] = useState(false)
  const [pixelCount, setPixelCount] = useState(null)
  const [dailyPixelCount, setDailyPixelCount] = useState(null)
  const [showDailyPixels, setShowDailyPixels] = useState(false)
  const [coordsError, setCoordsError] = useState(null)
  const coordsRef = useRef({ x: 0, y: 0 })
  const [canvasReady, setCanvasReady] = useState(false)
  const [messages, setMessages] = useState([])
  const [activeChannel, setActiveChannel] = useState('ENG')
  const activeChannelRef = useRef('ENG')
  activeChannelRef.current = activeChannel
  const [activePanel, setActivePanel] = useState(null)
  const [openPanels, setOpenPanels] = useState(() => Object.fromEntries(PANEL_NAMES.map(name => [name, false])))
  const openPanelsRef = useRef(openPanels)
  openPanelsRef.current = openPanels
  const activePanelRef = useRef(activePanel)
  activePanelRef.current = activePanel
  const [showCaptcha, setShowCaptcha] = useState(false)
  const [ready, setReady] = useState(false)
  const [icons, setIcons] = useState({})
  const [brushSize, setBrushSizeState] = useState(() => { const s = parseInt(localStorage.getItem('pixmap:brush') || '1'); return BRUSH_CYCLE_STAFF.includes(s) ? s : 1 })
  const [autoColor, setAutoColorState] = useState(() => localStorage.getItem('pixmap:autoColor') === 'true')
  const [overlaysEnabled, setOverlaysEnabled] = useState(() => localStorage.getItem('pixmap:overlaysEnabled') !== 'false')
  const [smallPixelsEnabled, setSmallPixelsEnabled] = useState(() => localStorage.getItem('pixmap:smallPixelsEnabled') !== 'false')
  const [gridEnabled, setGridEnabled] = useState(() => localStorage.getItem('pixmap:gridEnabled') === 'true')
  const [pencilMode, setPencilModeState] = useState(() => localStorage.getItem('pixmap:pencilMode') || 'color')
  const [showPalette, setShowPalette] = useState(true)
  const [histEnabled, setHistEnabled] = useState(false)
  const [historyMode, setHistoryMode] = useState(false)
  const [historyTs, setHistoryTs] = useState(0)
  const [historyDay, setHistoryDay] = useState(null)
  const [smoothPlacing, setSmoothPlacingState] = useState(() => localStorage.getItem('pixmap:smoothPlacing') === 'true')
  const [allowInvites, setAllowInvites] = useState(true)
  const [showInSearch, setShowInSearch] = useState(true)
  const [mobilePencilEnabled, setMobilePencilEnabled] = useState(false)
  const [voidState, setVoidState] = useState(null)
  const [placeReturn, setPlaceReturn] = useState(null)
  const placeReturnSeq = useRef(0)
  const [showBanModal, setShowBanModal] = useState(false)
  const [banInfo, setBanInfo] = useState(null)
  const [announcement, setAnnouncement] = useState(null)
  const [pendingExternalUrl, setPendingExternalUrl] = useState(null)
  const [mentionNotification, setMentionNotification] = useState(null)
  const mentionDismissTimer = useRef(null)

  const checkBanStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/me/ban')
      if (r.ok) {
        const data = await r.json()
        if (data.banned) {
          setBanInfo(data)
          setShowBanModal(true)
        }
      }
    } catch { }
  }, [])

  const canvasRef = useRef(null)
  const { label: cooldownLabel, active: cooldownActive } = useCooldownRemaining()
  useCooldownTabTitle(cooldownLabel)
  const cfgRef = useRef({})
  const canvasIdRef = useRef(0)
  const usersRef = useRef({})
  const currentUserRef = useRef(null)
  const loadChannelRef = useRef(null)
  const rendererReady = useRef(false)
  const socketConnected = useRef(false)
  const initialHashApplied = useRef(false)

  useEffect(() => { currentUserRef.current = currentUser }, [currentUser])

  /**
   * Single source of truth for the renderer→canvas coordinate offset.
   * Always equals (activeCanvas.size * 256) / 2.
   * Updated in one place (updateActiveCanvas) and read everywhere else.
   */
  const centerRef = useRef(0)

  /**
   * Refs for settings restored from localStorage on mount.
   * tryAttach() reads these to push correct initial values into the renderer
   * right after attach() — otherwise the renderer always starts with its
   * hardcoded constructor defaults (brushSize=1 etc.) regardless of what
   * the user had saved.
   */
  const brushSizeRef = useRef(1)
  const pencilModeRef = useRef('color')
  const overlaysEnabledRef = useRef(true)
  const smallPixelsEnabledRef = useRef(true)
  const gridEnabledRef = useRef(false)
  const templatesOpacityRef = useRef(0.55)
  const templatesRef = useRef([])

  cfgRef.current = configs
  canvasIdRef.current = canvasId
  brushSizeRef.current = brushSize
  pencilModeRef.current = pencilMode
  overlaysEnabledRef.current = overlaysEnabled
  smallPixelsEnabledRef.current = smallPixelsEnabled
  gridEnabledRef.current = gridEnabled



  // ── Single place that updates all canvas-dependent state ──────────────────
  function updateActiveCanvas(newId, allConfigs) {
    const cfg = allConfigs[newId]
    setCanvasId(newId)
    setCanvasName(cfg?.name ?? '—')
    setColors(cfg?.colors ?? [])
    centerRef.current = computeCenter(cfg)
    canvasIdRef.current = newId
    // Update socket with the current canvas stack for cooldown calculations
    socket.setCurrentCanvasStack(cfg?.stack || 120000)
  }

  function getSelectedColorForCanvas(id, allConfigs, mod) {
    const cfg = allConfigs[id]
    return resolveSelectedColor(id, {
      modColorCount: cfg?.unset_pixels_below ?? 0,
      isMod: mod,
      colorCount: cfg?.colors?.length ?? 0,
    })
  }

  function applyCanvasSelectedColor(id, allConfigs, mod) {
    const color = getSelectedColorForCanvas(id, allConfigs, mod)
    canvasRef.current?.setSelectedColor(color)
    return color
  }

  // ── Apply viewport from URL hash ───────────────────────────────────────────
  function applyHashViewport(hash) {
    const parsed = parseHash(hash)
    if (!parsed || !canvasRef.current) return
    const center = centerForHash(parsed, cfgRef.current, canvasIdRef.current)
    if (!center) return
    const r = canvasRef.current.renderer
    const { viewX, viewY, scale } = hashToViewport(parsed, center, r?._historyMode)
    canvasRef.current.setViewport(viewX, viewY, scale)
  }

  function applyInitialHashIfNeeded() {
    if (initialHashApplied.current || !rendererReady.current) return
    const hash = window.location.hash.substring(1)
    if (!hash) {
      initialHashApplied.current = true
      return
    }
    const parsed = parseHash(hash)
    if (!parsed || !centerForHash(parsed, cfgRef.current, canvasIdRef.current)) return
    initialHashApplied.current = true
    applyHashViewport(hash)
  }

  // ── Attach helper (runs whichever side wins the race) ────────────────────
  function tryAttach() {
    if (!rendererReady.current) return
    const cfg = cfgRef.current
    const id = canvasIdRef.current
    const minimapId = null
    canvasRef.current?.attach(cfg, id, minimapId, socket)

    // Push localStorage-restored settings into the renderer immediately after attach().
    canvasRef.current?.setBrushSize(brushSizeRef.current)
    canvasRef.current?.setPencilMode(pencilModeRef.current)
    canvasRef.current?.setOverlayOpacity(templatesOpacityRef.current)
    canvasRef.current?.setOverlaysEnabled(overlaysEnabledRef.current)
    canvasRef.current?.setSmallPixelsEnabled(smallPixelsEnabledRef.current)
    canvasRef.current?.setGridEnabled(gridEnabledRef.current)
    canvasRef.current?.setSmoothPlacing(localStorage.getItem('pixmap:smoothPlacing') === 'true')
    canvasRef.current?.setIsMod((currentUser?.role ?? 0) >= 100)

    applyCanvasSelectedColor(id, cfg, (currentUser?.role ?? 0) >= 100)

    canvasRef.current?.setOverlays(
      templatesRef.current.filter(t => t.visible && t.bitmap && (t.canvasId == null || t.canvasId === id))
               .map(t => ({ ...t, opacity: templatesOpacityRef.current }))
    )

    if (socketConnected.current) {
      socket.sendSetCanvas(id)
      canvasRef.current?.syncChunkSubscriptions({ reset: true })
    }

    applyInitialHashIfNeeded()
  }

  const [templates, setTemplates] = useState([])
  const [templatesOpacity, setTemplatesOpacity] = useState(() => {
    try {
      const v = localStorage.getItem('pixmap:templatesOpacity')
      return v !== null ? parseFloat(v) : 0.55
    } catch {
      return 0.55
    }
  })
  const loadedRef = useRef(false)
  templatesRef.current = templates
  const [isMobilePanels, setIsMobilePanels] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(max-width: 640px)').matches
  })
  const isMobilePanelsRef = useRef(isMobilePanels)
  isMobilePanelsRef.current = isMobilePanels

  // Load stored templates on mount
  useEffect(() => {
    async function loadTemplates() {
      try {
        const stored = JSON.parse(localStorage.getItem('pixmap:templates') || '[]')
        if (stored.length > 0) {
          const loaded = []
          for (const meta of stored) {
            try {
              // Check if this is an old-format template with dataUrl
              if (meta.dataUrl && !meta.thumbnailUrl) {
                // Migration: convert old dataUrl format to new IndexedDB format
                console.log('Migrating old template:', meta.name)
                
                // Load the old dataUrl image
                const img = new Image()
                img.src = meta.dataUrl
                await img.decode()
                
                // Create blob and save to IndexedDB
                const canvas = document.createElement('canvas')
                canvas.width = img.naturalWidth
                canvas.height = img.naturalHeight
                const ctx = canvas.getContext('2d', { willReadFrequently: true })
                ctx.drawImage(img, 0, 0)
                
                // Remap moderator colors
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
                const data = imageData.data
                for (let i = 0; i < data.length; i += 4) {
                  const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
                  if (a < 128) continue
                  if (r === 255 && g === 255 && b === 255) {
                    data[i] = 202
                    data[i + 1] = 227
                    data[i + 2] = 255
                  }
                }
                ctx.putImageData(imageData, 0, 0)
                
                // Save to IndexedDB
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.9))
                const db = await openDB()
                await new Promise((resolve, reject) => {
                  const tx = db.transaction(STORE_NAME, 'readwrite')
                  const store = tx.objectStore(STORE_NAME)
                  const request = store.put(blob, meta.id)
                  request.onsuccess = () => resolve()
                  request.onerror = () => reject(request.error)
                })
                
                // Create thumbnail
                const thumbCanvas = document.createElement('canvas')
                const maxThumbSize = 100
                const scale = Math.min(1, maxThumbSize / Math.max(img.naturalWidth, img.naturalHeight))
                thumbCanvas.width = Math.floor(img.naturalWidth * scale)
                thumbCanvas.height = Math.floor(img.naturalHeight * scale)
                const thumbCtx = thumbCanvas.getContext('2d')
                thumbCtx.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height)
                const thumbnailUrl = thumbCanvas.toDataURL('image/jpeg', 0.6)
                
                // Build runtime objects
                const bitmap = await createImageBitmap(img)
                const samplerCanvas = document.createElement('canvas')
                samplerCanvas.width = img.naturalWidth
                samplerCanvas.height = img.naturalHeight
                samplerCanvas.getContext('2d').drawImage(img, 0, 0)
                
                loaded.push({
                  ...stripTemplateUiFields(meta),
                  thumbnailUrl,
                  bitmap,
                  samplerCanvas,
                  width: bitmap.width,
                  height: bitmap.height,
                  dataUrl: undefined // Remove old dataUrl
                })
              } else {
                // New format: load blob from IndexedDB
                const blob = await getImageFromDB(meta.id)
                if (blob) {
                  // Build bitmap and sampler canvas
                  const { bitmap, samplerCanvas, width, height } = await buildFromBlob(blob)
                  loaded.push({
                    ...stripTemplateUiFields(meta),
                    bitmap,
                    samplerCanvas,
                    width,
                    height
                  })
                } else {
                  // Blob not found, keep metadata but no bitmap
                  loaded.push({ ...stripTemplateUiFields(meta), bitmap: null, samplerCanvas: null })
                }
              }
            } catch (err) {
              console.error('Failed to load template:', meta.id, err)
              // Keep the metadata even if loading failed
              loaded.push({ ...stripTemplateUiFields(meta), bitmap: null, samplerCanvas: null })
            }
          }
          setTemplates(loaded)
        }
        loadedRef.current = true
      } catch (e) {
        console.error('Failed to load templates from localStorage:', e)
        loadedRef.current = true
      }
    }
    loadTemplates()
  }, [])

  // Persist templates (metadata only)
  useEffect(() => {
    if (!loadedRef.current) return
    // Only save metadata to localStorage (thumbnails, coords, settings)
    // Actual image data is in IndexedDB
    const toSave = templates.map(templateMetadataForStorage)
    try {
      localStorage.setItem('pixmap:templates', JSON.stringify(toSave))
    } catch (err) {
      console.error('Failed to save templates metadata:', err)
      // If even metadata doesn't fit, try saving without thumbnails
      const minimal = templates.map(t => {
        const { thumbnailUrl, ...rest } = templateMetadataForStorage(t)
        return rest
      })
      try {
        localStorage.setItem('pixmap:templates', JSON.stringify(minimal))
      } catch {
        console.error('Failed to save even minimal template metadata')
      }
    }
  }, [templates])

  useEffect(() => {
    const handler = async (e) => {
      const faction = e.detail
      if (!faction?.template_url) return
      try {
        const res = await fetch(faction.template_url)
        if (!res.ok) {
          showToast(`⚠️ Could not fetch template file (${res.status})`, 'error')
          return
        }
        const blob = await res.blob()
        const id = `faction-tpl-${faction.id}`
        await saveTemplateImageToDB(id, blob)
        const { bitmap, samplerCanvas, width, height } = await buildTemplateAssets(blob)
        const thumbnailUrl = makeTemplateThumbnail(bitmap)
        const canvasId = faction.template_canvas_id || 0
        const center = getCanvasCenter(configs, canvasId)
        const { wx, wy } = worldCoordsFromCenter(faction.template_x || 0, faction.template_y || 0, center)

        setTemplates(prev => {
          const filtered = prev.filter(t => t.id !== id)
          return [...filtered, {
            id,
            name: `🛡️ ${faction.name} Template`,
            thumbnailUrl,
            wx,
            wy,
            visible: true,
            canvasId,
            bitmap,
            samplerCanvas,
            width,
            height
          }]
        })
        setOpenPanels(prev => ({ ...prev, templates: true }))
        setActivePanel('templates')
        showToast(`🎨 Loaded Faction template: ${faction.name}`, 'info')
      } catch (err) {
        console.error('Failed to load faction template preset:', err)
        showToast(`⚠️ Failed to load template: ${err.message}`, 'error')
      }
    }
    window.addEventListener('pixmap:apply-faction-template', handler)
    return () => window.removeEventListener('pixmap:apply-faction-template', handler)
  }, [configs])

  useEffect(() => {
    templatesOpacityRef.current = templatesOpacity
    localStorage.setItem('pixmap:templatesOpacity', String(templatesOpacity))
  }, [templatesOpacity])

  // Sync templates to canvas renderer whenever they, active canvas, or global opacity changes
  useEffect(() => {
    canvasRef.current?.setOverlayOpacity(templatesOpacity)
    canvasRef.current?.setOverlays(
      templates.filter(t => t.visible && t.bitmap && (t.canvasId == null || t.canvasId === canvasId))
               .map(t => ({ ...t, opacity: templatesOpacity }))
    )
  }, [templates, canvasId, templatesOpacity])

  // ── Panel drag-to-move (mouse + touch / tablets) ─────────────────────────
  useEffect(() => {
    function onPointerDown(e) {
      // Fullscreen mobile layout — no free drag
      if (window.matchMedia('(max-width: 640px)').matches) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const header = e.target.closest('.panel-header')
      if (!header || e.target.closest('.panel-close') || e.target.closest('.panel-ctrl')) return
      const panel = header.closest('.panel')
      if (!panel || panel.classList.contains('panel-fullscreen')) return

      e.preventDefault()
      const { left, top } = panel.getBoundingClientRect()
      const ox = e.clientX - left
      const oy = e.clientY - top
      const pointerId = e.pointerId

      function onMove(ev) {
        if (ev.pointerId !== pointerId) return
        panel.style.left = `${ev.clientX - ox}px`
        panel.style.top = `${ev.clientY - oy}px`
        panel.style.right = 'auto'
        panel.style.bottom = 'auto'
      }

      function onUp(ev) {
        if (ev.pointerId !== pointerId) return
        try { header.releasePointerCapture(pointerId) } catch {}
        header.removeEventListener('pointermove', onMove)
        header.removeEventListener('pointerup', onUp)
        header.removeEventListener('pointercancel', onUp)
      }

      header.setPointerCapture(pointerId)
      header.addEventListener('pointermove', onMove)
      header.addEventListener('pointerup', onUp)
      header.addEventListener('pointercancel', onUp)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  // ── Panel layout mode (desktop multi-open vs mobile single-open) ─────────
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(max-width: 640px)')
    const update = e => setIsMobilePanels(e.matches)
    update(mq)
    if (mq.addEventListener) {
      mq.addEventListener('change', update)
      return () => mq.removeEventListener('change', update)
    }
    mq.addListener(update)
    return () => mq.removeListener(update)
  }, [])

  useEffect(() => {
    if (isMobilePanels) {
      const next = activePanel && openPanels[activePanel] ? activePanel : getFirstOpenPanel(openPanels)
      setActivePanel(next)
      setOpenPanels(Object.fromEntries(PANEL_NAMES.map(name => [name, name === next])))
    } else if (activePanel) {
      setOpenPanels(prev => (prev[activePanel] ? prev : { ...prev, [activePanel]: true }))
    }
  }, [isMobilePanels])

  const closeAllPanels = useCallback(() => {
    setActivePanel(null)
    setOpenPanels(Object.fromEntries(PANEL_NAMES.map(name => [name, false])))
  }, [])

  const closePanel = useCallback(name => {
    if (isMobilePanels) {
      setOpenPanels(Object.fromEntries(PANEL_NAMES.map(panel => [panel, false])))
      setActivePanel(null)
      return
    }
    setOpenPanels(prev => ({ ...prev, [name]: false }))
  }, [isMobilePanels])

  const togglePanel = useCallback(name => {
    if (isMobilePanels) {
      const next = activePanel === name ? null : name
      setActivePanel(next)
      setOpenPanels(Object.fromEntries(PANEL_NAMES.map(panel => [panel, panel === next])))
      return
    }

    setActivePanel(name)
    setOpenPanels(prev => ({ ...prev, [name]: !prev[name] }))
  }, [isMobilePanels, activePanel])

  // ── Boot ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const resume = () => resumeSoundContext()
    window.addEventListener('pointerdown', resume, { once: true, passive: true })
    window.addEventListener('keydown', resume, { once: true })
    return () => {
      window.removeEventListener('pointerdown', resume)
      window.removeEventListener('keydown', resume)
    }
  }, [])

  useEffect(() => {
    async function boot() {
      fetchHistoryEnabled().then(setHistEnabled)

      try {
        const r = await fetch('/auth/me')
        if (r.ok) {
          const u = await r.json()
          setCurrentUser(u)
          setPixelCount(u.pixels_placed ?? 0)
          setDailyPixelCount(u.pixels_placed_daily ?? 0)
          if (u.banned) {
            checkBanStatus()
          }
        }
      } catch { }

      const reloadCanvases = async () => {
        try {
          const data = await fetchCanvases()
          const allCfg = Object.fromEntries(Object.entries(data.canvases).map(([k, v]) => [+k, normalizeColors({ id: +k, ...v })]))
          setConfigs(allCfg)
          return allCfg
        } catch { return null }
      }

      try {
        const data = await fetchCanvases()
        const allCfg = Object.fromEntries(Object.entries(data.canvases).map(([k, v]) => [+k, normalizeColors({ id: +k, ...v })]))
        let initialCanvasId = data.default ?? 0

        const hash = window.location.hash.substring(1)
        if (hash) {
          const parts = hash.split(',')
          const found = Object.entries(allCfg).find(([_, v]) => v.indent === parts[0])
          if (found) initialCanvasId = Number(found[0])
        } else {
          const cfg = allCfg[initialCanvasId]
          if (cfg && cfg.indent) {
            window.history.replaceState(null, '', `#${cfg.indent},0,0,0`)
          }
        }

        setConfigs(allCfg)
        updateActiveCanvas(initialCanvasId, allCfg)
        setCoordsError(null)
        setReady(true)
        window.dispatchEvent(new CustomEvent('pixmap:ready'))
        applyInitialHashIfNeeded()
      } catch {
        setCoordsError('Could not reach server.')
      }

      const canvasesHandler = () => { reloadCanvases() }
      window.addEventListener('pixmap:canvases-updated', canvasesHandler)

      const loadChannel = async (channelName) => {
        const ch = (channelName || 'ENG').toUpperCase()
        setActiveChannel(ch)
        activeChannelRef.current = ch
        try {
          const data = await fetchChatChannel(ch)
          if (data) {
            const { messages: rawMsgs, users } = data
            usersRef.current = users || {}
            setMessages(rawMsgs.map(m => normalizeMsg(m, users || {})))
          }
        } catch { }
      }
      loadChannelRef.current = loadChannel

      try {
        const data = await fetchChatChannel('ENG')
        if (data) {
          const { messages: rawMsgs, users } = data
          usersRef.current = users || {}
          setMessages(rawMsgs.map(m => normalizeMsg(m, users || {})))
        }
      } catch { }

      try {
        const r = await fetch('/icons')
        if (r.ok) {
          const { icons: list } = await r.json()
          setIcons(Object.fromEntries((list || []).map(ic => [ic.id, ic.image_b64])))
        }
      } catch { }
    }
    boot()
  }, [])

  // ── Socket wiring ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return

    const loadChannel = async (channelName) => {
      const ch = (channelName || 'ENG').toUpperCase()
      setActiveChannel(ch)
      activeChannelRef.current = ch
      try {
        const data = await fetchChatChannel(ch)
        if (data) {
          const { messages: rawMsgs, users } = data
          usersRef.current = users || {}
          setMessages(rawMsgs.map(m => normalizeMsg(m, users || {})))
        }
      } catch { }
    }

    const refetchChatMessages = async () => {
      try {
        const ch = activeChannelRef.current || 'ENG'
        const data = await fetchChatChannel(ch)
        if (!data) return
        const { messages: rawMsgs, users } = data
        usersRef.current = users || {}
        setMessages(rawMsgs.map(m => normalizeMsg(m, users || {})))
      } catch { }
    }

    const onConnect = () => {
      socketConnected.current = true
      setWsConnected(true)
      tryAttach()
      canvasRef.current?.syncChunkSubscriptions({ reset: true })
      socket.sendPing()
    }
    const onDisconnect = () => {
      socketConnected.current = false
      setWsConnected(false)
      setOnline(0)
      refetchChatMessages()
    }
    const onOnline = e => setOnline(e.detail)
    const onPlace = e => canvasRef.current?.applyPixels(e.detail)
    const onRefreshChunks = e => {
      const { canvasId: cid, chunks } = e.detail || {}
      canvasRef.current?.refreshChunks?.(cid, chunks)
    }

    const onChat = e => {
      const { userId, userInfo, message, messageId, timestamp, channel } = e.detail
      if (userInfo?.length) {
        usersRef.current[userId] = { username: userInfo[0], avatar: userInfo[1], role: userInfo[2] ?? 0, flair: userInfo[3] ?? {} }
      }
      const u = usersRef.current[userId] || {}
      const ch = (channel || 'ENG').toUpperCase()
      setMessages(prev => {
        const next = [...prev, { userId, name: u.username || `User ${userId}`, role: u.role || 0, flair: u.flair || {}, message, messageId, timestamp, channel: ch }]
        return next.length > 150 ? next.slice(-150) : next
      })

      const me = currentUserRef.current
      if (userId !== me?.id) {
        const isChatOpen = isMobilePanelsRef.current
          ? activePanelRef.current === 'chat'
          : openPanelsRef.current.chat
        const viewingChannel = activeChannelRef.current
        const isPing = Boolean(me?.username && message.includes(`@${me.username}`))
        if (!isChatOpen || ch !== viewingChannel || isPing) {
          playChatMessage({ isPing })
        }
        // Show mention toast if mentioned and chat closed
        if (isPing && !isChatOpen) {
          clearTimeout(mentionDismissTimer.current)
          setMentionNotification({ from: u.username || `User ${userId}`, text: message })
          mentionDismissTimer.current = setTimeout(() => setMentionNotification(null), 6000)
        }
      }
    }

    const onCooldown = e => {
      canvasRef.current?.setServerCooldown(e.detail.remaining)
      if (e.detail.remaining > 0) setCooldownUI(e.detail.remaining, e.detail.max)
    }

    const onAlert = e => {
      playAlert()
      showToast(e.detail, 'warn')
    }
    const onPixelPlaced = e => {
      const n = Number(e.detail) || 0
      setPixelCount(prev => (prev ?? 0) + n)
      setDailyPixelCount(prev => (prev ?? 0) + n)
    }
    const onDeleteMessages = e => { const del = new Set(e.detail); setMessages(prev => prev.filter(m => !del.has(m.messageId))) }

    const onChatError = e => {
      const minPx = currentUserRef.current?.chat_min_pixels ?? 5000
      const errors = [
        'Must be logged in to chat',
        'Message too long',
        'You are sending messages too fast',
        'You are muted.',
        minPx > 0
          ? `You need ${Number(minPx).toLocaleString()} pixels placed to chat.`
          : 'Chat is currently unavailable.',
      ]
      showToast(errors[e.detail] || 'Chat error', 'warn')
    }

    const onPlaceStatus = e => {
      const { cx, cy, code, placed_pixels, max_cooldown_ms, new_cooldown_ms } = e.detail
      canvasRef.current?.finalizePlace(cx, cy, code, placed_pixels ?? 0)
      if (code === 0) {
        const placed = Number(placed_pixels) || 0
        const paletteLen = configsRef.current[canvasIdRef.current]?.colors?.length ?? 1
        const batch = canvasRef.current?.renderer?._placeSoundBatch
        if (placed > 0) {
          if (batch && !batch.pixelPlayed) {
            playPixelPlaced(batch.firstColor, paletteLen)
            batch.pixelPlayed = true
          }
        } else if (batch && !batch.stackPlayed && !batch.pixelPlayed) {
          playStackUsedUp()
          batch.stackPlayed = true
        }

        placeReturnSeq.current += 1
        setPlaceReturn({
          id: placeReturnSeq.current,
          placed_pixels: placed,
          max_cooldown_ms: max_cooldown_ms ?? 0,
          new_cooldown_ms: new_cooldown_ms ?? 0,
          stack_ms: cfgRef.current?.stack ?? 120000,
        })
      } else if (code === 5) {
        playAlert('captcha')
      } else if (code !== 0) {
        playAlert()
      }
      if (code === 1) showToast('Proxy/VPN detected. Placement restricted.', 'warn')
      if (code === 2) checkBanStatus()
      if (code === 3) showToast('You must be logged in to place pixels.', 'info')
      if (code === 4) showToast('Invalid canvas selection.', 'error')
      if (code === 5) setShowCaptcha(true)
      if (code === 6) showToast('Those colors are for moderators only.', 'warn')
      if (code === 8) {
        showToast('Device verification required. Reloading...', 'error')
        setTimeout(() => location.reload(), 1500)
      }
    }

    const onVoidState = e => setVoidState(e.detail)
    const onAnnouncement = e => {
      setAnnouncement(e.detail)
      playNotification()
    }
    const onFactionInvite = e => {
      const data = e.detail || {}
      showToast(`🛡️ Inviting to Faction "${data.faction_name || ''}" by ${data.invited_by || ''}`, 'info')
      playNotification()
    }
    const onFactionAnnouncement = e => {
      const data = e.detail || {}
      const coordsText = (data.x != null && data.y != null) ? ` (${data.x}, ${data.y})` : ''
      showToast(`📢 Faction Announcement from ${data.author || 'Leader'}: ${data.message || ''}${coordsText}`, 'info')
      setAnnouncement({
        username: `🛡️ ${data.author || 'Faction Leader'} (Faction Announcement)`,
        message: data.message || '',
        x: data.x,
        y: data.y,
        canvas_id: data.canvas_id
      })
      playNotification()
    }
    const onFactionTemplate = () => {
      showToast('🎨 Faction template updated!', 'info')
    }
    const onFactionWarn = e => {
      const data = e.detail || {}
      setAnnouncement({
        username: `⚠️ FACTION WARNING — "${data.faction_name || 'Your Faction'}"`,
        message: `Your faction has received an official warning from Staff (${data.warned_by || 'Moderator'}).\n\nReason: ${data.reason || 'Violation of community guidelines.'}`,
        x: null,
        y: null
      })
      playNotification()
      playAlert()
    }

    socket.addEventListener('connect', onConnect)
    socket.addEventListener('disconnect', onDisconnect)
    socket.addEventListener('online', onOnline)
    socket.addEventListener('place', onPlace)
    socket.addEventListener('refresh_chunks', onRefreshChunks)
    socket.addEventListener('chat', onChat)
    socket.addEventListener('cooldown', onCooldown)
    socket.addEventListener('pixel_placed', onPixelPlaced)
    socket.addEventListener('delete_messages', onDeleteMessages)
    socket.addEventListener('chat_error', onChatError)
    socket.addEventListener('place_status', onPlaceStatus)
    socket.addEventListener('void_state', onVoidState)
    socket.addEventListener('announcement', onAnnouncement)
    socket.addEventListener('faction_invite', onFactionInvite)
    socket.addEventListener('faction_announcement', onFactionAnnouncement)
    socket.addEventListener('faction_template', onFactionTemplate)
    socket.addEventListener('faction_warn', onFactionWarn)
    socket.connect()

    return () => {
      socket.removeEventListener('connect', onConnect)
      socket.removeEventListener('disconnect', onDisconnect)
      socket.removeEventListener('online', onOnline)
      socket.removeEventListener('place', onPlace)
      socket.removeEventListener('refresh_chunks', onRefreshChunks)
      socket.removeEventListener('chat', onChat)
      socket.removeEventListener('cooldown', onCooldown)
      socket.removeEventListener('pixel_placed', onPixelPlaced)
      socket.removeEventListener('delete_messages', onDeleteMessages)
      socket.removeEventListener('chat_error', onChatError)
      socket.removeEventListener('place_status', onPlaceStatus)
      socket.removeEventListener('void_state', onVoidState)
      socket.removeEventListener('announcement', onAnnouncement)
      socket.removeEventListener('faction_invite', onFactionInvite)
      socket.removeEventListener('faction_announcement', onFactionAnnouncement)
      socket.removeEventListener('faction_template', onFactionTemplate)
      socket.removeEventListener('faction_warn', onFactionWarn)
    }
  }, [ready])

  // Auto-fetch messages whenever chat panel opens or active channel changes
  useEffect(() => {
    if (!ready) return
    const isChatOpen = isMobilePanels ? activePanel === 'chat' : openPanels.chat
    if (isChatOpen) {
      fetchChatChannel(activeChannel).then(data => {
        if (data) {
          const { messages: rawMsgs, users } = data
          usersRef.current = users || {}
          setMessages(rawMsgs.map(m => normalizeMsg(m, users || {})))
        }
      }).catch(() => {})
    }
  }, [ready, activeChannel, openPanels.chat, activePanel, isMobilePanels])

  // ── Resume socket state when tab/network becomes active (iOS backgrounding) ─
  useEffect(() => {
    if (!ready) return

    const onResume = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return

      canvasRef.current?.resumeRendering()

      if (socket.readyState !== WebSocket.OPEN) {
        socket.reconnect()
        return
      }

      socket.sendPing()
      if (socketConnected.current) {
        socket.sendSetCanvas(canvasIdRef.current)
        canvasRef.current?.syncChunkSubscriptions({ reset: true })
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        canvasRef.current?.pauseRendering()
      } else {
        onResume()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onResume)
    window.addEventListener('online', onResume)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onResume)
      window.removeEventListener('online', onResume)
      window.removeEventListener('pixmap:canvases-updated', canvasesHandler)
    }
  }, [ready])

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = e => {
      // Ignore all keyboard shortcuts when typing in any input field
      if (e.target?.tagName === 'INPUT' ||
          e.target?.tagName === 'TEXTAREA' ||
          e.target?.isContentEditable) return

      switch (e.code) {
        case 'Escape': closeAllPanels(); break
        case 'KeyH':
          if (!histEnabled) break
          setHistoryMode(m => {
            const next = !m
            if (next) showToast('🕐 History mode ON — read only', 'info')
            else { canvasRef.current?.clearHistoryMode(); showToast('▶ Live mode restored', 'info') }
            return next
          })
          break
        case 'KeyT':
          setOverlaysEnabled(prev => {
            const next = !prev
            localStorage.setItem('pixmap:overlaysEnabled', String(next))
            canvasRef.current?.setOverlaysEnabled(next)
            return next
          })
          break
        case 'KeyG':
          setGridEnabled(prev => {
            const next = !prev
            localStorage.setItem('pixmap:gridEnabled', String(next))
            canvasRef.current?.setGridEnabled(next)
            return next
          })
          break
        case 'KeyX':
          setSmallPixelsEnabled(prev => {
            const next = !prev
            localStorage.setItem('pixmap:smallPixelsEnabled', String(next))
            canvasRef.current?.setSmallPixelsEnabled(next)
            showToast(next ? '🔔 Pixel notifications ON' : '🔕 Pixel notifications OFF', 'info')
            return next
          })
          break
        case 'KeyM': {
          const next = localStorage.getItem('pixmap:sound') === 'false'
          localStorage.setItem('pixmap:sound', String(next))
          window.dispatchEvent(new CustomEvent('pixmap:sound', { detail: next }))
          showToast(next ? '🔊 Sound ON' : '🔇 Sound OFF', 'info')
          break
        }
        case 'KeyB': {
          const isStaff = (currentUserRef.current?.role ?? 0) >= 100
          const cycle = isStaff ? BRUSH_CYCLE_STAFF : BRUSH_CYCLE_BASE
          setBrushSizeState(prev => {
            const next = cycle[(cycle.indexOf(prev) + 1) % cycle.length]
            localStorage.setItem('pixmap:brush', String(next))
            canvasRef.current?.setBrushSize(next)
            showToast(`🖌️ Brush size: ${next}×${next}`, 'info')
            return next
          })
          break
        }
        case 'KeyR': {
          const { x, y } = coordsRef.current
          const text = `${x}_${y}`
          navigator.clipboard.writeText(text).then(() => {
            showToast(`📋 Copied ${text}`, 'info')
          }).catch(() => {
            showToast(`Coords: ${text}`, 'info')
          })
          break
        }
        case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5':
        case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9': {
          const pressedKey = e.code.slice(-1) // "Digit3" → "3"
          const canvasesList = Object.values(configsRef.current || {})
          let target = canvasesList.find(c => String(c.hotkey || '').trim() === pressedKey)
          if (!target) {
            const idx = parseInt(pressedKey, 10) - 1
            if (canvasesList[idx]) target = canvasesList[idx]
          }
          if (target && target.id != null && target.id !== canvasIdRef.current) {
            handleSwitchCanvas(target.id, { resetToCenter: true })
            showToast(`🗺 Switched to ${target.name}`, 'info')
          }
          break
        }
        case 'ControlLeft':
        case 'ControlRight': {
          if (e.repeat) break
          canvasRef.current?.pickColorAtHover()
          break
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [histEnabled, closeAllPanels])

  // ── Sync mod status ──────────────────────────────────────────────────────
  useEffect(() => {
    const mod = (currentUser?.role ?? 0) >= 100
    canvasRef.current?.setIsMod(mod)
    if (cfgRef.current && canvasIdRef.current != null) {
      applyCanvasSelectedColor(canvasIdRef.current, cfgRef.current, mod)
    }
  }, [currentUser])

  // ── Persist per-canvas selected color ────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      saveSelectedColor(canvasIdRef.current, e.detail)
    }
    window.addEventListener('pixmap:select-color', handler)
    return () => window.removeEventListener('pixmap:select-color', handler)
  }, [])

  useEffect(() => {
    const handler = (e) => {
      const url = e.detail?.url
      if (url) setPendingExternalUrl(url)
    }
    window.addEventListener('pixmap:external-link', handler)
    return () => window.removeEventListener('pixmap:external-link', handler)
  }, [])

  // ── Sync mobile pencil tool ──────────────────────────────────────────────
  useEffect(() => {
    canvasRef.current?.setMobilePencilEnabled(mobilePencilEnabled)
  }, [mobilePencilEnabled])

  const handleCoordsChange = useCallback((cx, cy) => {
    coordsRef.current = { x: cx, y: cy }
  }, [])

  const handleCanvasReady = useCallback(() => {
    rendererReady.current = true
    setCanvasReady(true)
    tryAttach()
  }, [])

  const handleDownloadViewport = useCallback(() => {
    canvasRef.current?.downloadViewport()
  }, [])

  // ── Settings handlers ────────────────────────────────────────────────────
  const handleBrushSize = useCallback(sz => {
    setBrushSizeState(sz); localStorage.setItem('pixmap:brush', String(sz)); canvasRef.current?.setBrushSize(sz)
  }, [])

  const handlePencilMode = useCallback(val => {
    setPencilModeState(val); localStorage.setItem('pixmap:pencilMode', val); canvasRef.current?.setPencilMode(val)
  }, [])

  const handleAutoColor = useCallback(val => {
    setAutoColorState(val); localStorage.setItem('pixmap:autoColor', String(val))
  }, [])

  const handleOverlays = useCallback(next => {
    setOverlaysEnabled(next); localStorage.setItem('pixmap:overlaysEnabled', String(next)); canvasRef.current?.setOverlaysEnabled(next)
  }, [])

  const handleSmallPixels = useCallback(next => {
    setSmallPixelsEnabled(next); localStorage.setItem('pixmap:smallPixelsEnabled', String(next)); canvasRef.current?.setSmallPixelsEnabled(next)
  }, [])

  const handleGrid = useCallback(next => {
    setGridEnabled(next); localStorage.setItem('pixmap:gridEnabled', String(next)); canvasRef.current?.setGridEnabled(next)
  }, [])

  const handleSmoothPlacing = useCallback(next => {
    setSmoothPlacingState(next); localStorage.setItem('pixmap:smoothPlacing', String(next)); canvasRef.current?.setSmoothPlacing(next)
  }, [])

  const handleAllowInvites = useCallback(async next => {
    setAllowInvites(next)
    try {
      const formData = new URLSearchParams()
      formData.append('allow_faction_invites', String(next))
      await fetch('/api/me/privacy', { method: 'PATCH', body: formData })
    } catch {}
  }, [])

  const handleShowInSearch = useCallback(async next => {
    setShowInSearch(next)
    try {
      const formData = new URLSearchParams()
      formData.append('show_in_invite_search', String(next))
      await fetch('/api/me/privacy', { method: 'PATCH', body: formData })
    } catch {}
  }, [])

  // ── Canvas switch ────────────────────────────────────────────────────────
  function handleSwitchCanvas(newId, { resetToCenter = false } = {}) {
    updateActiveCanvas(newId, configs)
    socket.sendSetCanvas(newId)
    const minimapId = null
    canvasRef.current?.attach(configs, newId, minimapId, socket)
    applyCanvasSelectedColor(newId, configs, (currentUser?.role ?? 0) >= 100)
    // Reset cooldown UI when switching canvases — each canvas has its own cooldown
    const newCanvas = configs[newId]
    const maxCooldown = newCanvas?.stack || 120000
    setCooldownUI(0, maxCooldown)
    const cfg = configs[newId]
    if (cfg?.indent) {
      const center = computeCenter(cfg)
      if (resetToCenter) {
        canvasRef.current?.setViewport(center, center, 4)
        window.history.replaceState(null, '', `#${cfg.indent},0,0,50`)
      } else {
        const r = canvasRef.current?.renderer
        const x = r ? Math.round(r.viewX - center) : 0
        const y = r ? Math.round(r.viewY - center) : 0
        const zoom = r ? Math.round(Math.log(r.scale) / Math.log(40) * 100) : 50
        window.history.replaceState(null, '', `#${cfg.indent},${x},${y},${zoom}`)
      }
    }
  }

  // ── Hash routing & URL sync ──────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return

    const applyHash = () => {
      const hash = window.location.hash.substring(1)
      if (!hash) return
      const parsed = parseHash(hash)
      if (!parsed) return

      const cfgId = Object.keys(cfgRef.current).find(k => cfgRef.current[k].indent === parsed.indent)
      if (cfgId && Number(cfgId) !== canvasIdRef.current) {
        handleSwitchCanvas(Number(cfgId))
      }
      applyHashViewport(hash)
    }

    window.addEventListener('hashchange', applyHash)

    let lastHash = ''
    const timer = setInterval(() => {
      if (!initialHashApplied.current) return

      const r = canvasRef.current?.renderer
      const cfg = cfgRef.current[canvasIdRef.current]
      if (r && cfg && cfg.indent) {
        const center = centerRef.current
        const x = Math.round(r.viewX - center)
        const y = Math.round(r.viewY - center)
        const zoom = Math.round(Math.log(r.scale) / Math.log(40) * 100)
        const cur = `#${cfg.indent},${x},${y},${zoom}`
        if (cur !== lastHash) {
          lastHash = cur
          if (window.location.hash !== cur) window.history.replaceState(null, '', cur)
        }
      }
    }, 2000)

    return () => {
      window.removeEventListener('hashchange', applyHash)
      clearInterval(timer)
    }
  }, [ready])

  // ── Teleport / Navigate Event Listener ────────────────────────────────────
  useEffect(() => {
    const navigateToCoords = (x, y, zoom) => {
      const canvas = canvasRef.current
      if (!canvas) return
      if (zoom != null) {
        const cfg = configs[canvasIdRef.current]
        const center = computeCenter(cfg)
        const scale = Math.pow(40, zoom / 100)
        canvas.setViewport(x + center, y + center, scale)
      } else {
        canvas.navigateTo(x, y)
      }
    }

    const onNavigate = e => {
      if (!canvasRef.current || !e.detail) return
      const { x, y, canvasId: targetCanvasId, zoom } = e.detail
      if (targetCanvasId != null && targetCanvasId !== canvasIdRef.current) {
        handleSwitchCanvas(targetCanvasId)
        setTimeout(() => navigateToCoords(x, y, zoom), 80)
      } else {
        navigateToCoords(x, y, zoom)
      }
    }
    window.addEventListener('pixmap:navigate', onNavigate)
    return () => window.removeEventListener('pixmap:navigate', onNavigate)
  }, [configs])

  // ── Render ────────────────────────────────────────────────────────────────
  const isMod = (currentUser?.role ?? 0) >= 100
  const canvasSize = centerRef.current
  // Find the default canvas id for void teleport (first non-minimap, non-void canvas)
  const defaultCanvasId = 0

  return (
    <div className={`app-container${showPalette ? ' palette-visible' : ''}${historyMode ? ' history-active' : ''}`}>
      <ToastContainer />

      {historyMode && (
        <HistoryBar
          canvasId={canvasId}
          ts={historyTs}
          selectedDay={historyDay}
          onDayChange={setHistoryDay}
          onTs={ts => {
            const n = Number(ts)
            if (!n) return
            setHistoryTs(n)
            setHistoryDay(dayFromTs(n))
            canvasRef.current?.setHistoryMode(n)
          }}
          onClose={() => { setHistoryMode(false); canvasRef.current?.clearHistoryMode() }}
        />
      )}

      <Canvas
        ref={canvasRef}
        onReady={handleCanvasReady}
      />

      <HUD
        canvasName={canvasName}
        canvasId={canvasId}
        configs={configs}
        canvasSize={canvasSize}
        online={online}
        wsConnected={wsConnected}
        canvasRef={canvasRef}
        centerRef={centerRef}
        canvasReady={canvasReady}
        coordsError={coordsError}
        onCoordsChange={handleCoordsChange}
        currentUser={currentUser}
        pixelCount={pixelCount}
        dailyPixelCount={dailyPixelCount}
        showDailyPixels={showDailyPixels}
        onTogglePixelDisplay={() => setShowDailyPixels(v => !v)}
        activePanel={activePanel}
        onTogglePanel={togglePanel}
        brushSize={brushSize}
        onBrushSizeChange={handleBrushSize}
        onPencilModeChange={handlePencilMode}
        onSwitchCanvas={handleSwitchCanvas}
        showPalette={showPalette}
        onTogglePalette={() => setShowPalette(p => !p)}
        mobilePencilEnabled={mobilePencilEnabled}
        onMobilePencilToggle={() => setMobilePencilEnabled(p => !p)}
        pencilMode={pencilMode}
        voidState={voidState}
        historyMode={historyMode}
        defaultCanvasId={defaultCanvasId}
        onDownloadViewport={handleDownloadViewport}
        mentionNotification={mentionNotification}
        onMentionToastClick={() => {
          clearTimeout(mentionDismissTimer.current)
          setMentionNotification(null)
          togglePanel('chat')
        }}
        onMentionToastDismiss={() => {
          clearTimeout(mentionDismissTimer.current)
          setMentionNotification(null)
        }}
      />

      {!historyMode && colors.length > 0 && showPalette && (
        <Palette
          colors={colors}
          modColorCount={configs[canvasId]?.unset_pixels_below ?? 0}
          isMod={isMod}
          initialColor={getSelectedColorForCanvas(canvasId, configs, isMod)}
          onSelect={idx => canvasRef.current?.setSelectedColor(idx)}
        />
      )}

      {!historyMode && (
        <CooldownBar
          placeReturn={placeReturn}
          topLabel={cooldownLabel}
          topActive={cooldownActive}
        />
      )}

      {!historyMode && (isMobilePanels ? activePanel === 'help' : openPanels.help) && <HelpPanel onClose={() => closePanel('help')} />}
      {!historyMode && (isMobilePanels ? activePanel === 'user' : openPanels.user) && (
        <UserPanel
          user={currentUser}
          icons={icons}
          dailyPixelCount={dailyPixelCount}
          onClose={() => closePanel('user')}
        />
      )}
      {!historyMode && (isMobilePanels ? activePanel === 'chat' : openPanels.chat) && (
        <ChatPanel
          messages={messages}
          currentUser={currentUser}
          pixelCount={pixelCount}
          socket={socket}
          icons={icons}
          users={usersRef.current}
          activeChannel={activeChannel}
          onChangeChannel={ch => {
            setActiveChannel(ch)
            activeChannelRef.current = ch
            fetchChatChannel(ch).then(data => {
              if (data) {
                const { messages: rawMsgs, users } = data
                usersRef.current = users || {}
                setMessages(rawMsgs.map(m => normalizeMsg(m, users || {})))
              }
            }).catch(() => {})
          }}
          onClose={() => {
            closePanel('chat')
          }}
        />
      )}
      {!historyMode && (isMobilePanels ? activePanel === 'modtools' : openPanels.modtools) && isMod && <ModtoolsPanel currentUser={currentUser} canvasRef={canvasRef} canvasSize={canvasSize} canvasId={canvasId} configs={configs} onClose={() => closePanel('modtools')} />}
      {!historyMode && (isMobilePanels ? activePanel === 'settings' : openPanels.settings) && (
        <SettingsPanel
          brushSize={brushSize} onBrushSize={handleBrushSize}
          pencilMode={pencilMode} onPencilModeChange={handlePencilMode}
          gridEnabled={gridEnabled} onGridChange={handleGrid}
          smoothPlacing={smoothPlacing} onSmoothPlacingChange={handleSmoothPlacing}
          allowInvites={allowInvites} onAllowInvitesChange={handleAllowInvites}
          showInSearch={showInSearch} onShowInSearchChange={handleShowInSearch}
          smallPixelsEnabled={smallPixelsEnabled} onSmallPixelsChange={handleSmallPixels}
          histEnabled={histEnabled}
          historyMode={historyMode}
          currentUser={currentUser}
          onHistoryModeChange={next => {
            setHistoryMode(next)
            if (next) {
              showToast('🕐 History mode ON — read only', 'info')
            } else {
              canvasRef.current?.clearHistoryMode()
              showToast('▶ Live mode restored', 'info')
            }
          }}

          onClose={() => closePanel('settings')}
        />
      )}
      {!historyMode && (isMobilePanels ? activePanel === 'templates' : openPanels.templates) && (
        <TemplatePanel
          templates={templates}
          setTemplates={setTemplates}
          templatesOpacity={templatesOpacity}
          onTemplatesOpacityChange={setTemplatesOpacity}
          overlaysEnabled={overlaysEnabled}
          onOverlaysChange={handleOverlays}
          smallPixelsEnabled={smallPixelsEnabled}
          onSmallPixelsChange={handleSmallPixels}
          canvasRef={canvasRef}
          colors={colors}
          canvasSize={canvasSize}
          canvasId={canvasId}
          configs={configs}
          onClose={() => closePanel('templates')}
        />
      )}
      {!historyMode && (isMobilePanels ? activePanel === 'stats' : openPanels.stats) && <StatsPanel onClose={() => closePanel('stats')} />}
      {!historyMode && (isMobilePanels ? activePanel === 'factions' : openPanels.factions) && (
        <FactionsPanel
          currentUser={currentUser}
          canvasRef={canvasRef}
          configs={configs}
          canvasId={canvasId}
          onClose={() => closePanel('factions')}
        />
      )}

      <TurnstileModal
        open={showCaptcha && !historyMode}
        onVerified={() => { setShowCaptcha(false); playNotification(); showToast('✓ Verified! You can now place pixels.', 'info') }}
      />
      <BanModal
        open={showBanModal}
        banInfo={banInfo}
        onClose={() => setShowBanModal(false)}
      />
      <AnnouncementModal
        announcement={announcement}
        onClose={() => setAnnouncement(null)}
      />
      <ExternalLinkModal
        url={pendingExternalUrl}
        onClose={() => setPendingExternalUrl(null)}
      />
    </div>
  )
}