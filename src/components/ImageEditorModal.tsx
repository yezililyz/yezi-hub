import { useRef, useState, useEffect, useCallback } from 'react'

interface Props {
  onInsert: (html: string) => void
  onClose: () => void
}

type Tool = 'draw' | 'text' | 'crop' | 'eraser'

const COLORS = ['#1c1814', '#e8943a', '#d96a4a', '#4f9d6b', '#4a7abf', '#f5c842', '#ffffff']

export default function ImageEditorModal({ onInsert, onClose }: Props) {
  const [hasImage, setHasImage] = useState(false)
  const [tool, setTool] = useState<Tool>('draw')
  const [color, setColor] = useState('#e8943a')
  const [lineWidth, setLineWidth] = useState(3)
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const undoStack = useRef<ImageData[]>([])
  const drawingRef = useRef(false)
  const cropStartRef = useRef<{ x: number; y: number } | null>(null)
  const isDraggingCrop = useRef(false)

  // Cmd+Z undo
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo() }
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  function ctx() { return canvasRef.current?.getContext('2d') ?? null }
  function octx() { return overlayRef.current?.getContext('2d') ?? null }

  function saveUndo() {
    const c = canvasRef.current; const cx = ctx()
    if (!c || !cx) return
    undoStack.current.push(cx.getImageData(0, 0, c.width, c.height))
    if (undoStack.current.length > 40) undoStack.current.shift()
  }

  function undo() {
    const c = canvasRef.current; const cx = ctx()
    if (!c || !cx || !undoStack.current.length) return
    cx.putImageData(undoStack.current.pop()!, 0, 0)
  }

  function syncOverlaySize() {
    const c = canvasRef.current; const o = overlayRef.current
    if (c && o) { o.width = c.width; o.height = c.height }
  }

  function loadImage(file: File) {
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => {
        const maxW = 760, maxH = 500
        let w = img.width, h = img.height
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW }
        if (h > maxH) { w = Math.round(w * maxH / h); h = maxH }
        const c = canvasRef.current!
        c.width = w; c.height = h
        syncOverlaySize()
        ctx()!.drawImage(img, 0, 0, w, h)
        undoStack.current = []
        setCropRect(null)
        setHasImage(true)
      }
      img.src = e.target?.result as string
    }
    reader.readAsDataURL(file)
  }

  // Convert mouse event to logical canvas coordinates (works for both canvas refs)
  function toCanvasPos(e: React.MouseEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (c.width / rect.width),
      y: (e.clientY - rect.top) * (c.height / rect.height),
    }
  }

  // ─── Draw / Eraser handlers ───────────────────────────────────────────────

  function onDrawDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!hasImage) return
    const pos = toCanvasPos(e)
    if (tool === 'text') { setTextInput({ ...pos, value: '' }); return }
    saveUndo()
    drawingRef.current = true
    const cx = ctx()!
    cx.beginPath(); cx.moveTo(pos.x, pos.y)
    if (tool === 'eraser') {
      cx.globalCompositeOperation = 'destination-out'
      cx.lineWidth = lineWidth * 4
    } else {
      cx.globalCompositeOperation = 'source-over'
      cx.strokeStyle = color
      cx.lineWidth = lineWidth
    }
    cx.lineCap = 'round'; cx.lineJoin = 'round'
  }

  function onDrawMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return
    const pos = toCanvasPos(e)
    const cx = ctx()!
    cx.lineTo(pos.x, pos.y); cx.stroke()
  }

  function onDrawUp() {
    if (!drawingRef.current) return
    drawingRef.current = false
    const cx = ctx()!
    cx.globalCompositeOperation = 'source-over'
  }

  // ─── Crop handlers ────────────────────────────────────────────────────────

  function onCropDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const pos = toCanvasPos(e)
    cropStartRef.current = pos
    isDraggingCrop.current = true
    setCropRect(null)
    const oc = octx(); const c = canvasRef.current
    if (oc && c) oc.clearRect(0, 0, c.width, c.height)
  }

  function onCropMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDraggingCrop.current || !cropStartRef.current) return
    const pos = toCanvasPos(e)
    const s = cropStartRef.current
    const rect = {
      x: Math.min(s.x, pos.x), y: Math.min(s.y, pos.y),
      w: Math.abs(pos.x - s.x), h: Math.abs(pos.y - s.y),
    }
    setCropRect(rect)
    const oc = octx(); const c = canvasRef.current
    if (!oc || !c) return
    oc.clearRect(0, 0, c.width, c.height)
    oc.fillStyle = 'rgba(0,0,0,0.48)'
    oc.fillRect(0, 0, c.width, c.height)
    oc.clearRect(rect.x, rect.y, rect.w, rect.h)
    oc.strokeStyle = '#e8943a'; oc.lineWidth = 2
    oc.setLineDash([5, 3]); oc.strokeRect(rect.x, rect.y, rect.w, rect.h)
    oc.setLineDash([])
    // Corner handles
    const hw = 6
    oc.fillStyle = '#e8943a'
    ;[[rect.x, rect.y],[rect.x+rect.w, rect.y],[rect.x, rect.y+rect.h],[rect.x+rect.w, rect.y+rect.h]].forEach(([cx2,cy2]) => {
      oc.fillRect(cx2 - hw/2, cy2 - hw/2, hw, hw)
    })
  }

  function onCropUp() { isDraggingCrop.current = false }

  function applyCrop() {
    if (!cropRect || cropRect.w < 4 || cropRect.h < 4) return
    const c = canvasRef.current!; const cx = ctx()!
    const data = cx.getImageData(Math.round(cropRect.x), Math.round(cropRect.y), Math.round(cropRect.w), Math.round(cropRect.h))
    c.width = Math.round(cropRect.w); c.height = Math.round(cropRect.h)
    syncOverlaySize()
    cx.putImageData(data, 0, 0)
    const oc = octx(); if (oc) oc.clearRect(0, 0, c.width, c.height)
    undoStack.current = []
    setCropRect(null); cropStartRef.current = null
  }

  // ─── Text commit ─────────────────────────────────────────────────────────

  function commitText() {
    if (!textInput) return
    if (textInput.value.trim()) {
      saveUndo()
      const cx = ctx()!
      cx.globalCompositeOperation = 'source-over'
      cx.fillStyle = color
      const fontSize = Math.round(lineWidth * 4 + 12)
      cx.font = `bold ${fontSize}px Inter, -apple-system, sans-serif`
      cx.fillText(textInput.value, textInput.x, textInput.y)
    }
    setTextInput(null)
  }

  // ─── Insert ──────────────────────────────────────────────────────────────

  function handleInsert() {
    const c = canvasRef.current; if (!c) return
    // Clear overlay before export
    const oc = octx(); if (oc) oc.clearRect(0, 0, c.width, c.height)
    const dataUrl = c.toDataURL('image/png')
    onInsert(`<figure style="margin:16px 0;"><img src="${dataUrl}" style="max-width:100%;border-radius:10px;border:2px solid #1c1814;display:block;" alt="" /></figure>`)
  }

  // ─── Tool switch helper ───────────────────────────────────────────────────

  function switchTool(t: Tool) {
    setTool(t)
    setCropRect(null)
    const oc = octx(); const c = canvasRef.current
    if (oc && c) oc.clearRect(0, 0, c.width, c.height)
    drawingRef.current = false
  }

  // Canvas display size (CSS)
  const canvasCss: React.CSSProperties = {
    display: 'block', maxWidth: '100%', maxHeight: 500,
    cursor: tool === 'draw' ? 'crosshair' : tool === 'eraser' ? 'cell' : tool === 'text' ? 'text' : 'crosshair',
  }

  const canvasW = canvasRef.current?.width ?? 1
  const canvasH = canvasRef.current?.height ?? 1

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--paper)', border: '2px solid var(--line)',
          borderRadius: 20, boxShadow: '6px 6px 0 var(--ink)',
          width: 840, maxWidth: '96vw', maxHeight: '94vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 20px', borderBottom: '2px solid var(--line)',
          background: 'var(--cream-deep)', borderRadius: '18px 18px 0 0',
        }}>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13 }}>🖼 Image editor</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--ink-soft)', lineHeight: 1 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!hasImage ? (
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) loadImage(f) }}
              style={{
                margin: 24, padding: '60px 40px', textAlign: 'center', cursor: 'pointer',
                border: '2px dashed var(--faint)', borderRadius: 16,
                background: 'var(--cream)', transition: 'border-color .15s, background .15s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--orange)'; (e.currentTarget as HTMLElement).style.background = 'var(--orange-soft)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--faint)'; (e.currentTarget as HTMLElement).style.background = 'var(--cream)' }}
            >
              <div style={{ fontSize: 40, marginBottom: 12 }}>🖼</div>
              <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>Drop an image here or click to upload</p>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>PNG, JPG, GIF, WebP — resized to fit</p>
            </div>
          ) : (
            <>
              {/* Toolbar */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px',
                background: 'var(--cream)', borderBottom: '1.5px solid var(--line)', flexWrap: 'wrap',
              }}>
                {/* Tools */}
                {([
                  { id: 'draw' as Tool,   icon: '✏',  label: 'Draw' },
                  { id: 'text' as Tool,   icon: 'T',   label: 'Text' },
                  { id: 'crop' as Tool,   icon: '✂',   label: 'Crop' },
                  { id: 'eraser' as Tool, icon: '⌫',   label: 'Eraser' },
                ]).map(t => (
                  <button key={t.id} title={t.label} onClick={() => switchTool(t.id)}
                    style={{
                      fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700,
                      padding: '4px 11px', border: '1.5px solid var(--line)', borderRadius: 7,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                      background: tool === t.id ? 'var(--ink)' : 'var(--paper)',
                      color: tool === t.id ? '#fff' : 'var(--ink)',
                    }}>
                    <span>{t.icon}</span>
                    <span style={{ fontSize: 11 }}>{t.label}</span>
                  </button>
                ))}

                <div style={{ width: 1, height: 22, background: 'rgba(28,24,20,.2)', margin: '0 4px' }} />

                {/* Color swatches */}
                {COLORS.map(c => (
                  <button key={c} onClick={() => setColor(c)} title={c}
                    style={{
                      width: 22, height: 22, borderRadius: '50%',
                      border: `2.5px solid ${color === c ? '#e8943a' : 'var(--line)'}`,
                      background: c, cursor: 'pointer',
                      boxShadow: color === c ? '0 0 0 2px #fff, 0 0 0 4px #e8943a' : 'none',
                      flexShrink: 0,
                    }}
                  />
                ))}

                <div style={{ width: 1, height: 22, background: 'rgba(28,24,20,.2)', margin: '0 4px' }} />

                {/* Line width */}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>Size</span>
                <input type="range" min={1} max={20} value={lineWidth}
                  onChange={e => setLineWidth(Number(e.target.value))}
                  style={{ width: 70, accentColor: 'var(--orange)' }}
                />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, minWidth: 18 }}>{lineWidth}</span>

                <div style={{ width: 1, height: 22, background: 'rgba(28,24,20,.2)', margin: '0 4px' }} />

                {/* Undo */}
                <button onClick={undo} title="Undo (⌘Z)"
                  style={{ fontFamily: 'var(--mono)', fontSize: 13, padding: '4px 10px', border: '1.5px solid var(--line)', borderRadius: 7, cursor: 'pointer', background: 'var(--paper)' }}>
                  ↩ Undo
                </button>

                {/* Apply crop */}
                {tool === 'crop' && cropRect && cropRect.w > 4 && cropRect.h > 4 && (
                  <button onClick={applyCrop}
                    style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, padding: '4px 12px', border: '1.5px solid var(--line)', borderRadius: 7, cursor: 'pointer', background: 'var(--orange)', color: '#fff' }}>
                    ✂ Apply crop
                  </button>
                )}

                {/* Replace image */}
                <button onClick={() => fileInputRef.current?.click()} title="Replace image"
                  style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11, padding: '4px 10px', border: '1.5px solid var(--line)', borderRadius: 7, cursor: 'pointer', background: 'var(--paper)', color: 'var(--muted)' }}>
                  📂 Replace
                </button>
              </div>

              {/* Canvas */}
              <div style={{ background: '#e8e0d5', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, minHeight: 200 }}>
                <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
                  <canvas
                    ref={canvasRef}
                    style={{ ...canvasCss, pointerEvents: tool === 'crop' ? 'none' : 'auto' }}
                    onMouseDown={onDrawDown}
                    onMouseMove={onDrawMove}
                    onMouseUp={onDrawUp}
                    onMouseLeave={onDrawUp}
                  />
                  {/* Crop overlay — always rendered, visible only when tool=crop */}
                  <canvas
                    ref={overlayRef}
                    style={{
                      position: 'absolute', top: 0, left: 0,
                      width: '100%', height: '100%',
                      pointerEvents: tool === 'crop' ? 'auto' : 'none',
                      cursor: 'crosshair',
                    }}
                    onMouseDown={onCropDown}
                    onMouseMove={onCropMove}
                    onMouseUp={onCropUp}
                    onMouseLeave={onCropUp}
                  />
                  {/* Text input overlay */}
                  {textInput && (
                    <input
                      autoFocus
                      value={textInput.value}
                      onChange={e => setTextInput(t => t && ({ ...t, value: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') commitText(); if (e.key === 'Escape') setTextInput(null) }}
                      onBlur={commitText}
                      placeholder="Type, then Enter…"
                      style={{
                        position: 'absolute',
                        left: `${(textInput.x / canvasW) * 100}%`,
                        top: `${(textInput.y / canvasH) * 100}%`,
                        transform: 'translateY(-100%)',
                        background: 'rgba(255,255,255,0.92)',
                        border: `2px solid ${color}`,
                        borderRadius: 6, padding: '3px 9px',
                        fontFamily: 'Inter, sans-serif',
                        fontSize: Math.round(lineWidth * 4 + 12) * (canvasRef.current ? (canvasRef.current.getBoundingClientRect().width / canvasW) : 1),
                        color, outline: 'none', zIndex: 10, minWidth: 140,
                        boxShadow: '2px 2px 8px rgba(0,0,0,0.18)',
                      }}
                    />
                  )}
                </div>
              </div>

              {tool === 'text' && !textInput && (
                <div style={{ textAlign: 'center', padding: '6px 0 2px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                  Click anywhere on the image to place a text annotation
                </div>
              )}
              {tool === 'crop' && !cropRect && (
                <div style={{ textAlign: 'center', padding: '6px 0 2px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                  Click and drag to select the crop area, then click Apply crop
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', gap: 10, padding: '14px 20px',
          borderTop: '1.5px solid var(--line)', justifyContent: 'flex-end',
          background: 'var(--cream)', borderRadius: '0 0 18px 18px',
        }}>
          {hasImage && (
            <button className="btn btn-primary" onClick={handleInsert}>
              Insert into page
            </button>
          )}
          {!hasImage && (
            <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
              Choose file
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
        </div>

        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) loadImage(f) }} />
      </div>
    </div>
  )
}
