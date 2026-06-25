'use client'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { format } from 'date-fns'
import { ColourDot } from './warehouse-ui'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'

interface ScannedRow { barcode: string; shape: string | null; size: string | null; colour: string | null; mattress: string | null }

const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }
const inputField = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' as const }

export default function PickScanTerminal({ userId, onToast, onSessionClosed }: {
  userId: string; onToast?: (msg: string, type?: string) => void; onSessionClosed?: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [scanned, setScanned] = useState<ScannedRow[]>([])
  const [busy, setBusy] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [lastResult, setLastResult] = useState<{ type: string; msg: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scannedRef = useRef(new Set<string>())
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

  function flash(type: string, msg: string) {
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
      if (scannedRef.current.has(barcode)) { flash('warn', `${barcode} already scanned in this session`); return }

      const { data: piece, error } = await supabase.from('pieces').select('*').eq('barcode', barcode).maybeSingle()
      if (error) throw error
      if (!piece) { flash('error', `${barcode} not found`); return }
      if (piece.status === 'picked') { flash('error', `${barcode} already picked`); return }
      if (piece.status === 'packed') { flash('error', `${barcode} already packed`); return }
      if (piece.status !== 'coated') { flash('error', `${barcode} not in coated state (${piece.status})`); return }

      let sid = sessionId
      if (!sid) {
        const { data: session, error: sErr } = await supabase.from('pick_sessions')
          .insert({ label: label || null, status: 'open', created_by: userId }).select().single()
        if (sErr) throw sErr
        sid = session.id
        setSessionId(sid)
      }

      const { error: upErr } = await supabase.from('pieces').update({
        status: 'picked', pick_session_id: sid, picked_at: new Date().toISOString(),
      }).eq('id', piece.id).eq('status', 'coated')
      if (upErr) throw upErr

      const { error: piErr } = await supabase.from('pick_items').insert({
        session_id: sid, category: piece.category, shape: piece.shape, size: piece.size,
        mattress: piece.mattress, colour: piece.colour, pieces: 1, product_id: piece.product_id, piece_id: piece.id,
      })
      if (piErr) throw piErr

      scannedRef.current.add(barcode)
      setScanned(prev => [{ barcode, shape: piece.shape, size: piece.size, colour: piece.colour, mattress: piece.mattress }, ...prev])
      flash('success', `${barcode} · ${piece.shape}${piece.size ? ' ' + piece.size : ''}`)
    } catch (e) {
      flash('error', 'Error: ' + (e as Error).message)
    } finally {
      processingRef.current = false
    }
  }, [sessionId, label, userId, supabase])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const val = e.currentTarget.value
      e.currentTarget.value = ''
      void processScan(val)
    }
  }

  async function startCamera() {
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      setCameraOn(true)
      setTimeout(async () => {
        const el = document.getElementById('pick-camera')
        if (!el) return
        const cam = new Html5Qrcode('pick-camera')
        cameraRef.current = cam as unknown as { stop: () => Promise<void>; clear: () => void }
        await cam.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 150 } },
          (decoded: string) => { void processScan(decoded) },
          () => {}
        )
      }, 100)
    } catch (e) {
      onToast?.('Camera unavailable: ' + (e as Error).message, 'error')
      setCameraOn(false)
    }
  }
  const stopCamera = useCallback(async () => {
    try {
      if (cameraRef.current) { await cameraRef.current.stop(); cameraRef.current.clear(); cameraRef.current = null }
    } catch { /* ignore */ }
    setCameraOn(false)
  }, [])
  useEffect(() => () => { void stopCamera() }, [stopCamera])

  async function confirmSession() {
    if (!sessionId) { onToast?.('Nothing scanned yet', 'error'); return }
    setBusy(true)
    try {
      const { error } = await supabase.from('pick_sessions').update({
        status: 'complete', completed_at: new Date().toISOString(), label: label || null,
      }).eq('id', sessionId)
      if (error) throw error
      onToast?.(`Session confirmed · ${scanned.length} frame(s)`)
      await stopCamera()
      setSessionId(null); setScanned([]); setLabel(''); setLastResult(null)
      scannedRef.current = new Set()
      onSessionClosed?.()
      inputRef.current?.focus()
    } catch (e) {
      onToast?.('Confirm error: ' + (e as Error).message, 'error')
    }
    setBusy(false)
  }

  const bannerStyle = (() => {
    const t = lastResult?.type
    if (t === 'success') return { background: 'var(--dispatched-bg)', color: 'var(--dispatched)', borderColor: 'var(--border)' }
    if (t === 'warn') return { background: 'var(--today-bg)', color: 'var(--today)', borderColor: 'var(--border)' }
    if (t === 'error') return { background: 'var(--critical-bg)', color: 'var(--critical)', borderColor: 'var(--border)' }
    return { background: 'var(--bg2)', color: 'var(--text3)', borderColor: 'var(--border)' }
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: 10, padding: '12px 16px', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{format(new Date(), 'EEE, dd MMM yyyy')}</span>
        <span>{sessionId ? `Session open · ${scanned.length}` : 'No active session'}</span>
      </div>

      <div>
        <div style={sectionTitle}>Pick / Order Label <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>(optional)</span></div>
        <input style={inputField} placeholder="Order ref, or leave blank" value={label} onChange={e => setLabel(e.target.value)} />
      </div>

      <div>
        <div style={sectionTitle}>Scan Barcode</div>
        <input ref={inputRef} autoFocus
          style={{ ...inputField, textAlign: 'center', fontSize: 18, fontWeight: 700, letterSpacing: 1 }}
          placeholder="Scan with gun, or use camera below" onKeyDown={handleKeyDown} disabled={cameraOn} />
      </div>

      <div style={{ borderRadius: 10, border: '1px solid', padding: '16px', textAlign: 'center', fontWeight: 700, fontSize: 13, ...bannerStyle }}>
        {lastResult?.msg || 'Ready to scan'}
      </div>

      <div>
        {!cameraOn ? (
          <button onClick={startCamera}
            style={{ width: '100%', padding: 12, borderRadius: 10, border: '2px solid var(--border)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, background: 'var(--surface)', cursor: 'pointer' }}>
            📷 Use Camera Instead
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div id="pick-camera" style={{ width: '100%', borderRadius: 10, overflow: 'hidden', background: '#000', minHeight: 200 }} />
            <button onClick={stopCamera}
              style={{ width: '100%', padding: 8, borderRadius: 10, border: '2px solid var(--border)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, background: 'var(--surface)', cursor: 'pointer' }}>
              Stop Camera
            </button>
          </div>
        )}
      </div>

      <div>
        <div style={sectionTitle}>Scanned this session ({scanned.length})</div>
        {!scanned.length ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text3)', fontSize: 13 }}>Nothing scanned yet</div>
        ) : (
          <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'auto', maxHeight: 288 }}>
            <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
              <tbody>
                {scanned.map(s => (
                  <tr key={s.barcode} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text3)' }}>{s.barcode}</td>
                    <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text)' }}>{s.shape}{s.size ? ` · ${s.size}` : ''}</td>
                    <td style={{ padding: '8px 12px', color: 'var(--text2)' }}><ColourDot colour={s.colour || ''} />{s.colour}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <button onClick={confirmSession} disabled={busy || !sessionId}
        style={{ width: '100%', padding: 14, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 15, borderRadius: 10, border: 'none', cursor: 'pointer', opacity: (busy || !sessionId) ? 0.4 : 1 }}>
        {busy ? 'Confirming...' : `Confirm Session${scanned.length ? ` (${scanned.length})` : ''}`}
      </button>
    </div>
  )
}
