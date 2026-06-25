'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'
import { Camera, Undo2 } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

interface ScannedItem { barcode: string; descr: string; unitId: string }
type ResultType = 'success' | 'warn' | 'error'

export default function ScanToStockTab() {
  const supabase = createClient()
  const [scanned, setScanned] = useState<ScannedItem[]>([])
  const [cameraOn, setCameraOn] = useState(false)
  const [lastResult, setLastResult] = useState<{ type: ResultType; msg: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null)
  const processingRef = useRef(false)

  useEffect(() => {
    if (!cameraOn) {
      const t = setInterval(() => {
        if (document.activeElement !== inputRef.current) inputRef.current?.focus()
      }, 800)
      return () => clearInterval(t)
    }
  }, [cameraOn])

  function flash(type: ResultType, msg: string) {
    setLastResult({ type, msg })
    if (type === 'success') beepSuccess()
    else if (type === 'warn') beepWarn()
    else beepError()
  }

  const processScan = useCallback(async (raw: string) => {
    const barcode = (raw || '').trim()
    if (!barcode) return
    if (processingRef.current) return
    processingRef.current = true
    try {
      const { data: unit, error } = await supabase.from('packed_units').select('*').eq('barcode', barcode).maybeSingle()
      if (error) throw error
      if (!unit) { flash('error', `${barcode} not found`); return }
      if (unit.status === 'stocked') { flash('warn', `${barcode} already in stock`); return }
      if (unit.status !== 'packed') { flash('error', `${barcode} is ${unit.status} — cannot stock`); return }

      const { error: upErr } = await supabase.from('packed_units').update({
        status: 'stocked', stocked_at: new Date().toISOString(),
      }).eq('id', unit.id).eq('status', 'packed')
      if (upErr) throw upErr

      setScanned(prev => [{ barcode, descr: unit.sku, unitId: unit.id }, ...prev])
      flash('success', `Stocked: ${barcode}`)
    } catch (e) {
      flash('error', 'Error: ' + (e as Error).message)
    } finally {
      processingRef.current = false
    }
  }, [supabase])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const val = e.currentTarget.value
      e.currentTarget.value = ''
      processScan(val)
    }
  }

  async function undoScan(item: ScannedItem) {
    try {
      const { error } = await supabase.from('packed_units').update({
        status: 'packed', stocked_at: null,
      }).eq('id', item.unitId).eq('status', 'stocked')
      if (error) throw error
      setScanned(prev => prev.filter(s => s.unitId !== item.unitId))
      flash('warn', `Undone: ${item.barcode} back to packed`)
    } catch (e) {
      flash('error', 'Undo error: ' + (e as Error).message)
    }
  }

  const startCamera = useCallback(async () => {
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      setCameraOn(true)
      setTimeout(async () => {
        const el = document.getElementById('stock-camera')
        if (!el) return
        const cam = new Html5Qrcode('stock-camera')
        cameraRef.current = cam as unknown as { stop: () => Promise<void>; clear: () => void }
        await cam.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 250, height: 150 } },
          (decoded: string) => { processScan(decoded) }, () => {})
      }, 100)
    } catch (e) {
      flash('error', 'Camera unavailable: ' + (e as Error).message)
      setCameraOn(false)
    }
  }, [processScan])

  const stopCamera = useCallback(async () => {
    try { if (cameraRef.current) { await cameraRef.current.stop(); cameraRef.current.clear(); cameraRef.current = null } } catch { /* ignore */ }
    setCameraOn(false)
  }, [])

  useEffect(() => () => { stopCamera() }, [stopCamera])

  const banner = lastResult?.type === 'success' ? { color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', border: '#bbf7d0' }
    : lastResult?.type === 'warn' ? { color: 'var(--today)', bg: 'var(--today-bg)', border: '#fed7aa' }
    : lastResult?.type === 'error' ? { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' }
    : { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 18, maxWidth: 560 }}>
      <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: 8, padding: '12px 16px', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Scan to Stock</span>
        <span style={{ fontFamily: 'DM Mono' }}>{scanned.length} stocked this session</span>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Scan Packed Barcode</div>
        <input ref={inputRef} autoFocus onKeyDown={handleKeyDown} disabled={cameraOn}
          placeholder="Scan with gun, or use camera below"
          style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--accent)', background: cameraOn ? 'var(--bg2)' : 'var(--bg)', color: 'var(--text)', fontSize: 17, fontFamily: 'DM Mono', fontWeight: 700, textAlign: 'center' as const, letterSpacing: '0.05em', outline: 'none' }} />
      </div>

      <div style={{ borderRadius: 8, border: `1px solid ${banner.border}`, background: banner.bg, color: banner.color, padding: '14px 16px', textAlign: 'center' as const, fontWeight: 700, fontSize: 14 }}>
        {lastResult?.msg || 'Ready to scan'}
      </div>

      <div>
        {!cameraOn ? (
          <button onClick={startCamera} style={{ width: '100%', padding: '12px', borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Camera size={15} /> Use Camera Instead
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
            <div id="stock-camera" style={{ width: '100%', borderRadius: 8, overflow: 'hidden', background: '#000', minHeight: 200 }} />
            <button onClick={stopCamera} style={{ width: '100%', padding: '10px', borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Stop Camera</button>
          </div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Stocked this session ({scanned.length})</div>
        {!scanned.length ? (
          <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Nothing stocked yet</div>
        ) : (
          <div style={{ ...card, overflow: 'auto', maxHeight: 288 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <tbody>
                {scanned.map((s, i) => (
                  <tr key={s.unitId} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{s.barcode}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' as const }}>
                      <button onClick={() => undoScan(s)} style={{ fontSize: 11, fontWeight: 700, color: 'var(--critical)', border: '1px solid #fecaca', borderRadius: 6, padding: '3px 8px', background: 'var(--surface)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Undo2 size={11} /> Undo
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
