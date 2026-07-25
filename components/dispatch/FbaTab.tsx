'use client'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'
import { Camera, Undo2, Plus, Package } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }

type ResultType = 'success' | 'warn' | 'error'
interface ScannedItem { barcode: string; sku: string; unitId: string }
interface FbaShipment { id: string; name: string; fc: string | null; status: string; created_at: string }

export default function FbaTab() {
  const supabase = createClient()
  const [shipments, setShipments] = useState<FbaShipment[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [scanned, setScanned] = useState<ScannedItem[]>([])
  const [cameraOn, setCameraOn] = useState(false)
  const [lastResult, setLastResult] = useState<{ type: ResultType; msg: string } | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newFc, setNewFc] = useState('')
  const [loading, setLoading] = useState(true)

  const inputRef = useRef<HTMLInputElement>(null)
  const processingRef = useRef(false)
  const cameraRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null)

  const active = shipments.find(s => s.id === activeId) || null

  const flash = (type: ResultType, msg: string) => {
    setLastResult({ type, msg })
    if (type === 'success') beepSuccess()
    else if (type === 'warn') beepWarn()
    else beepError()
  }

  // Load open shipments + this session's already-scanned pieces for the active one.
  const loadShipments = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('fba_shipments').select('*').eq('status', 'open').order('created_at', { ascending: false })
    setShipments((data as FbaShipment[]) || [])
    setLoading(false)
  }, [supabase])
  useEffect(() => { void loadShipments() }, [loadShipments])

  // When active shipment changes, load the pieces already scanned into it.
  useEffect(() => {
    if (!activeId) { setScanned([]); return }
    ;(async () => {
      const { data } = await supabase.from('packed_units')
        .select('id, barcode, sku').eq('fba_shipment_id', activeId).eq('status', 'fba')
        .order('fba_scanned_at', { ascending: false })
      setScanned(((data as { id: string; barcode: string; sku: string }[]) || []).map(u => ({ barcode: u.barcode, sku: u.sku, unitId: u.id })))
    })()
  }, [activeId, supabase])

  const createShipment = async () => {
    const name = newName.trim()
    if (!name) { flash('error', 'Enter a shipment name / Amazon shipment ID'); return }
    const { data: auth } = await supabase.auth.getUser()
    const { data, error } = await supabase.from('fba_shipments').insert({
      name, fc: newFc.trim() || null, created_by_email: auth?.user?.email ?? null,
    }).select().single()
    if (error) { flash('error', 'Error: ' + error.message); return }
    const row = data as FbaShipment
    setShipments(prev => [row, ...prev])
    setActiveId(row.id)
    setShowNew(false); setNewName(''); setNewFc('')
    flash('success', `Shipment "${row.name}" created`)
  }

  const processScan = useCallback(async (raw: string) => {
    const barcode = (raw || '').trim()
    if (!barcode) return
    if (!activeId) { flash('error', 'Select or create an FBA shipment first'); return }
    if (processingRef.current) return
    processingRef.current = true
    try {
      const { data: unit, error } = await supabase.from('packed_units').select('*').eq('barcode', barcode).maybeSingle()
      if (error) throw error
      if (!unit) { flash('error', `${barcode} not found`); return }
      if (unit.status === 'fba') { flash('warn', `${barcode} already moved to FBA`); return }
      if (unit.status !== 'stocked') { flash('error', `${barcode} is ${unit.status} — only stocked pieces can go to FBA`); return }

      const now = new Date().toISOString()
      // Guard the flip on status='stocked' so two guns can't double-move the same piece.
      const { data: flipped, error: upErr } = await supabase.from('packed_units').update({
        status: 'fba', fba_shipment_id: activeId, fba_scanned_at: now,
      }).eq('id', unit.id).eq('status', 'stocked').select('id')
      if (upErr) throw upErr
      if (!flipped || !flipped.length) { flash('warn', `${barcode} was just moved by someone else`); return }

      setScanned(prev => [{ barcode, sku: unit.sku, unitId: unit.id }, ...prev])
      flash('success', `To FBA: ${barcode} (${unit.sku})`)
    } catch (e) {
      flash('error', 'Error: ' + (e as Error).message)
    } finally {
      processingRef.current = false
    }
  }, [supabase, activeId])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const val = e.currentTarget.value
      e.currentTarget.value = ''
      processScan(val)
    }
  }

  // Reversal: put a piece back to stock (clears the FBA link).
  const undoScan = async (item: ScannedItem) => {
    try {
      const { error } = await supabase.from('packed_units').update({
        status: 'stocked', fba_shipment_id: null, fba_scanned_at: null,
      }).eq('id', item.unitId).eq('status', 'fba')
      if (error) throw error
      setScanned(prev => prev.filter(s => s.unitId !== item.unitId))
      flash('warn', `Returned to stock: ${item.barcode}`)
    } catch (e) {
      flash('error', 'Undo error: ' + (e as Error).message)
    }
  }

  // Per-SKU tally for reconciling against the manifest.
  const perSku = useMemo(() => {
    const m: Record<string, number> = {}
    for (const s of scanned) m[s.sku] = (m[s.sku] || 0) + 1
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]))
  }, [scanned])

  const startCamera = useCallback(async () => {
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      setCameraOn(true)
      setTimeout(async () => {
        const cam = new Html5Qrcode('fba-camera')
        cameraRef.current = cam as unknown as { stop: () => Promise<void>; clear: () => void }
        await cam.start({ facingMode: 'environment' }, { fps: 10, qrbox: 250 },
          (decoded: string) => { processScan(decoded) }, () => {})
      }, 100)
    } catch { flash('error', 'Camera unavailable'); setCameraOn(false) }
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
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Package size={16} /> FBA Stock Transfer</span>
        <span style={{ fontFamily: 'DM Mono' }}>{scanned.length} in this shipment</span>
      </div>

      {/* Shipment selector */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>FBA Shipment</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={activeId} onChange={e => setActiveId(e.target.value)} disabled={loading}
            style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, outline: 'none' }}>
            <option value="">{loading ? 'Loading…' : '— select a shipment —'}</option>
            {shipments.map(s => <option key={s.id} value={s.id}>{s.name}{s.fc ? ` · ${s.fc}` : ''}</option>)}
          </select>
          <button onClick={() => setShowNew(v => !v)} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--surface)', color: 'var(--accent)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' as const }}>
            <Plus size={14} /> New
          </button>
        </div>
        {showNew && (
          <div style={{ ...card, padding: 14, marginTop: 8, display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Amazon shipment ID / name"
              style={{ padding: '9px 11px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, outline: 'none' }} />
            <input value={newFc} onChange={e => setNewFc(e.target.value)} placeholder="Destination FC (optional, e.g. Bangalore AMXL)"
              style={{ padding: '9px 11px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, outline: 'none' }} />
            <button onClick={createShipment} style={{ padding: '9px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Create shipment</button>
          </div>
        )}
      </div>

      {/* Scan box */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Scan Piece Barcode</div>
        <input ref={inputRef} autoFocus onKeyDown={handleKeyDown} disabled={cameraOn || !activeId}
          placeholder={activeId ? 'Scan with gun, or use camera below' : 'Select a shipment first'}
          style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--accent)', background: (cameraOn || !activeId) ? 'var(--bg2)' : 'var(--bg)', color: 'var(--text)', fontSize: 17, fontFamily: 'DM Mono', fontWeight: 700, textAlign: 'center' as const, letterSpacing: '0.05em', outline: 'none', boxSizing: 'border-box' as const }} />
      </div>

      <div style={{ borderRadius: 8, border: `1px solid ${banner.border}`, background: banner.bg, color: banner.color, padding: '14px 16px', textAlign: 'center' as const, fontWeight: 700, fontSize: 14 }}>
        {lastResult?.msg || (activeId ? 'Ready to scan' : 'Select or create a shipment')}
      </div>

      <div>
        {!cameraOn ? (
          <button onClick={startCamera} disabled={!activeId} style={{ width: '100%', padding: '12px', borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, cursor: activeId ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: activeId ? 1 : 0.5 }}>
            <Camera size={15} /> Use Camera Instead
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
            <div id="fba-camera" style={{ width: '100%', borderRadius: 8, overflow: 'hidden', background: '#000', minHeight: 200 }} />
            <button onClick={stopCamera} style={{ width: '100%', padding: '10px', borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Stop Camera</button>
          </div>
        )}
      </div>

      {/* Per-SKU tally */}
      {perSku.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Per-SKU tally (reconcile vs manifest)</div>
          <div style={{ ...card, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <tbody>
                {perSku.map(([sku, n], i) => (
                  <tr key={sku} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                    <td style={{ padding: '7px 12px', fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text)' }}>{sku}</td>
                    <td style={{ padding: '7px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--accent)' }}>{n}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg2)' }}>
                  <td style={{ padding: '7px 12px', fontWeight: 700, color: 'var(--text)' }}>Total</td>
                  <td style={{ padding: '7px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 800, color: 'var(--text)' }}>{scanned.length}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Scanned list with undo */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Moved to FBA ({scanned.length})</div>
        {!scanned.length ? (
          <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Nothing scanned yet</div>
        ) : (
          <div style={{ ...card, overflow: 'auto', maxHeight: 320 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <tbody>
                {scanned.map((s, i) => (
                  <tr key={s.unitId} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{s.barcode}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{s.sku}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' as const }}>
                      <button onClick={() => undoScan(s)} style={{ fontSize: 11, fontWeight: 700, color: 'var(--critical)', border: '1px solid #fecaca', borderRadius: 6, padding: '3px 8px', background: 'var(--surface)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Undo2 size={11} /> To stock
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
