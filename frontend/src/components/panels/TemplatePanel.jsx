import { useState, useRef, useEffect } from 'react'
import {
  saveTemplateImageToDB,
  deleteTemplateImageFromDB,
  processTemplateImage,
  buildTemplateAssets,
  makeTemplateThumbnail,
  exportEnabledTemplates,
  importTemplates,
  defaultTemplateWorldPosition,
  releaseTemplateBitmap,
  formatTemplateCoords,
  applyTemplateWorldPosition,
  applyTemplateCoordInput,
} from '../../lib/canvas/templates.js'
import PanelHeader from '../PanelHeader.jsx'
import CoordsComponent from '../CoordsComponent.jsx'

export default function TemplatePanel({
  templates, setTemplates,
  templatesOpacity, onTemplatesOpacityChange,
  overlaysEnabled, onOverlaysChange,
  smallPixelsEnabled, onSmallPixelsChange,
  canvasRef, canvasId, configs, onClose,
}) {
  const [picking, setPicking] = useState(null)
  const [importStatus, setImportStatus] = useState(null)
  const fileRef = useRef()
  const replaceRef = useRef()
  const replaceTargetRef = useRef(null)
  const importRef = useRef()

  useEffect(() => () => canvasRef.current?.stopTemplatePick(), [canvasRef])



  function updateTemplatePosition(id, wx, wy) {
    setTemplates(prev => prev.map(t => t.id === id ? applyTemplateWorldPosition(t, wx, wy) : t))
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) return

    try {
      const blob = await processTemplateImage(file)
      const id = crypto.randomUUID()

      await saveTemplateImageToDB(id, blob)

      const { bitmap, samplerCanvas, width, height } = await buildTemplateAssets(blob)
      const thumbnailUrl = makeTemplateThumbnail(bitmap)
      const { wx, wy } = defaultTemplateWorldPosition(configs, canvasId)

      setTemplates(prev => [...prev, {
        id,
        name: file.name,
        thumbnailUrl,
        wx,
        wy,
        visible: true,
        canvasId,
        bitmap,
        samplerCanvas,
        width,
        height,
      }])
    } catch (err) {
      console.error('Failed to process template:', err)
      alert('Failed to load template. Please try a smaller image.')
    }
  }
  function onFileChange(e) { handleFile(e.target.files[0]); e.target.value = '' }
  function onDrop(e) { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }

  async function replaceImage(id, file) {
    if (!file || !file.type.startsWith('image/')) return

    try {
      const blob = await processTemplateImage(file)
      await saveTemplateImageToDB(id, blob)

      const { bitmap, samplerCanvas, width, height } = await buildTemplateAssets(blob)
      const thumbnailUrl = makeTemplateThumbnail(bitmap)

      setTemplates(prev => prev.map(t => t.id === id ? {
        ...t,
        name: file.name,
        bitmap,
        samplerCanvas,
        width,
        height,
        thumbnailUrl,
      } : t))
    } catch (err) {
      console.error('Failed to replace template image:', err)
      alert('Failed to replace template image. Please try a smaller image.')
    }
  }

  function startReplace(id) {
    replaceTargetRef.current = id
    replaceRef.current?.click()
  }

  function onReplaceChange(e) {
    const file = e.target.files[0]
    const id = replaceTargetRef.current
    e.target.value = ''
    replaceTargetRef.current = null
    if (file && id) replaceImage(id, file)
  }

  async function handleExport() {
    try {
      const data = await exportEnabledTemplates(templates, configs)
      if (data.length === 0) {
        alert('No enabled templates to export.')
        return
      }
      const json = JSON.stringify(data)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'pixmap-templates.json'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export templates:', err)
      alert('Failed to export templates.')
    }
  }

  async function handleImport(file) {
    if (!file) return
    setImportStatus(null)
    try {
      const text = await file.text()
      const entries = JSON.parse(text)
      const imported = await importTemplates(entries, configs)
      if (imported.length === 0) {
        setImportStatus({ msg: 'No valid templates found in file.', type: 'warn' })
        return
      }
      setTemplates(prev => [...prev, ...imported])
      setImportStatus({ msg: `Imported ${imported.length} template${imported.length === 1 ? '' : 's'}.`, type: 'ok' })
    } catch (err) {
      console.error('Failed to import templates:', err)
      setImportStatus({ msg: 'Failed to import templates. Check the file format.', type: 'warn' })
    }
  }

  function onImportChange(e) {
    handleImport(e.target.files[0])
    e.target.value = ''
  }

  // ── Pick position on canvas ───────────────────────────────────────────────
  function pickPosition(id) {
    const t = templates.find(t => t.id === id)
    if (!t?.bitmap) return
    setPicking(id)
    const offscreen = new OffscreenCanvas(t.bitmap.width, t.bitmap.height)
    offscreen.getContext('2d').drawImage(t.bitmap, 0, 0)
    canvasRef.current?.startTemplatePick(offscreen, (wx, wy) => {
      setPicking(null)
      updateTemplatePosition(id, wx, wy)
    })
  }

  function setField(id, key, value) {
    setTemplates(prev => prev.map(t => {
      if (t.id !== id) return t
      if (key === 'canvasId') return { ...t, [key]: value, coordInputStr: undefined }
      return { ...t, [key]: value }
    }))
  }
  async function remove(id, name) {
    if (window.confirm(`Are you sure you want to delete the template "${name || 'this template'}"?`)) {
      try {
        await deleteTemplateImageFromDB(id)
      } catch (err) {
        console.error('Failed to delete from IndexedDB:', err)
      }
      setTemplates(prev => {
        const removed = prev.find(t => t.id === id)
        releaseTemplateBitmap(removed)
        return prev.filter(t => t.id !== id)
      })
    }
  }

  function handleTemplateCoordChange(id, val) {
    setTemplates(prev => prev.map(t => t.id === id ? applyTemplateCoordInput(t, val, configs) : t))
  }

  return (
    <div id="panel-templates" className="panel">
      <PanelHeader title="Template Overlays" panelId="panel-templates" onClose={onClose} />

      <div className="panel-body">
        {/* Template Settings Field */}
        <h3>Template Settings</h3>
        
        <div className="settings-row" style={{ margin: '6px 0' }}>
          <span>Show All Overlays</span>
          <button
            className={`toggle-btn ${overlaysEnabled ? 'on' : ''}`}
            onClick={() => onOverlaysChange(!overlaysEnabled)}
          >
            {overlaysEnabled ? 'On' : 'Off'}
          </button>
        </div>

        <div className="settings-row" style={{ margin: '6px 0' }}>
          <span>Small Pixels (Grid Dots)</span>
          <button
            className={`toggle-btn ${smallPixelsEnabled ? 'on' : ''}`}
            onClick={() => onSmallPixelsChange(!smallPixelsEnabled)}
          >
            {smallPixelsEnabled ? 'On' : 'Off'}
          </button>
        </div>

        <div className="settings-row" style={{ margin: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Template Opacity</span>
            <span className="tpl-lbl" style={{ fontSize: 11, color: 'rgba(255,255,255,.6)', textTransform: 'none' }}>{Math.round(templatesOpacity * 100)}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            className="tpl-slider"
            style={{ width: '100%', margin: '4px 0' }}
            value={templatesOpacity}
            onChange={e => onTemplatesOpacityChange(parseFloat(e.target.value))}
          />
        </div>

        {/* Add Template Section */}
        <h3 style={{ marginTop: 16 }}>Add Template</h3>
        <div className="tpl-dropzone" onDragOver={e => e.preventDefault()} onDrop={onDrop} onClick={() => fileRef.current?.click()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span>Drop image or click to upload</span>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFileChange} />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="mt-btn secondary" style={{ flex: 1, fontSize: 11 }} onClick={handleExport}>
            Export Enabled
          </button>
          <button className="mt-btn secondary" style={{ flex: 1, fontSize: 11 }} onClick={() => importRef.current?.click()}>
            Import
          </button>
          <input ref={importRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onImportChange} />
          <input ref={replaceRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onReplaceChange} />
        </div>
        {importStatus && (
          <div className={`mt-status ${importStatus.type === 'ok' ? 'ok' : 'warn'}`} style={{ marginTop: 8 }}>
            {importStatus.msg}
          </div>
        )}

        {/* Templates List */}
        <h3 style={{ marginTop: 16 }}>My Templates</h3>

        {templates.length === 0 && (
          <p style={{ color: 'rgba(255,255,255,.3)', fontSize: 11, textAlign: 'center', margin: '4px 0' }}>
            No templates yet. Upload a PNG/GIF/JPEG to get started.
          </p>
        )}

        {templates.map(t => (
          <div key={t.id} className={`tpl-card${t.visible ? '' : ' tpl-hidden'}`}>
            {/* Row 1: thumb + name + actions */}
            <div className="tpl-row1">
              {t.thumbnailUrl && (
                <button
                  type="button"
                  className="tpl-thumb-btn"
                  title="Replace image"
                  onClick={() => startReplace(t.id)}
                >
                  <img className="tpl-thumb" src={t.thumbnailUrl} alt={t.name} />
                </button>
              )}
              <div className="tpl-name" title={t.name}>{t.name}</div>
              <div className="tpl-actions">
                {/* Visibility */}
                <button className={`tpl-icon-btn${t.visible ? ' active' : ''}`} title={t.visible ? 'Hide' : 'Show'} onClick={() => setField(t.id, 'visible', !t.visible)}>
                  {t.visible
                    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  }
                </button>
                {/* Delete */}
                <button className="tpl-icon-btn danger" title="Remove" onClick={() => remove(t.id, t.name)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                </button>
              </div>
            </div>

            {/* Canvas selection (on top of coords) */}
            <div className="tpl-row2" style={{ marginTop: 4 }}>
              <label className="tpl-lbl" style={{ width: 60 }}>Canvas</label>
              <select
                className="mt-input tpl-select"
                style={{ flex: 1, padding: '4px 6px', fontSize: 11, background: '#222', color: '#fff', border: '1px solid #444', borderRadius: 4 }}
                value={t.canvasId !== undefined && t.canvasId !== null ? t.canvasId : ''}
                onChange={e => {
                  const val = e.target.value === '' ? null : Number(e.target.value)
                  setField(t.id, 'canvasId', val)
                }}
              >
                {configs && Object.entries(configs).map(([id, cfg]) => (
                  <option key={id} value={id}>{cfg.name}</option>
                ))}
              </select>
            </div>

            {/* Position + Pick */}
            <div className="tpl-row2" style={{ marginTop: 4 }}>
              <label className="tpl-lbl" style={{ width: 60 }}>Coords</label>
              <CoordsComponent
                className="mt-input tpl-coord"
                value={t.coordInputStr !== undefined ? t.coordInputStr : formatTemplateCoords(t, configs)}
                canvasIndent={configs?.[t.canvasId ?? canvasId]?.indent}
                style={{ flex: 1, minWidth: 0, padding: '4px 6px', fontSize: 11 }}
                placeholder="0_0"
                onChange={val => handleTemplateCoordChange(t.id, val)}
              />
              <button
                className={`mt-btn secondary tpl-pick-btn${picking === t.id ? ' picking' : ''}`}
                style={{ flexShrink: 0, margin: 0 }}
                onClick={() => picking === t.id ? (canvasRef.current?.stopTemplatePick(), setPicking(null)) : pickPosition(t.id)}
              >
                {picking === t.id ? '✕ Cancel' : '⌖ Pick'}
              </button>
            </div>
          </div>
        ))}

        {picking && (
          <div className="mt-status info">⌖ Click on the canvas to set position. Image follows your cursor.</div>
        )}
      </div>
    </div>
  )
}
