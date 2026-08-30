'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'
import { Camera, Undo2, MapPin, X } from 'lucide-react'
import BarcodeScanner from './BarcodeScanner'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

// A scanned row barcode carries a COL- prefix so the scanner can tell a column
// from a piece. The stored column_code is the un-prefixed value (e.g. BAY1-R1-C3).
const COL_PREFIX = /^COL-/i
const isColumnScan = (raw: string) => COL_PREFIX.test(raw.trim())
const toColumnCode = (raw: string) => raw.trim().replace(COL_PREFIX, '')

// After every N pieces, nudge the user to confirm they're still on the right column.
const REMIND_EVERY = 10

interface ScannedItem { barcode: string; unitId: string }
interface ActiveColumn { id: string; column_code: string; bay: number; row: number; sku: string | null; max_qty: number | null; enforce_max: boolean }
type ResultType = 'success' | 'warn' | 'error'

export default function ColumnStockInTab({ userEmail }: { userEmail?: string }) {
  const supabase = createClient()
  const [col, setCol] = useState<ActiveColumn | null>(null)
  const [scanned, setScanned] = useState<ScannedItem[]>([])   // this column, this session
  const [countInColumn, setCountInColumn] = useState(0)       // live total pieces in the column
  const [cameraOn, setCameraOn] = useState(false)
  const [lastResult, setLastResult] = useState<{ type: ResultType; msg: string } | null>(null)
  const [pendingColumn, setPendingColumn] = useState<ActiveColumn | null>(null) // "close previous?" confirm
  const [remindAck, setRemindAck] = useState(false)           // every-N reminder showing
  const sinceRemindRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const processingRef = useRef(false)

  useEffect(() => {
    if (!cameraOn) {
      const t = setInterval(() => { if (document.activeElement !== inputRef.current) inputRef.current?.focus() }, 800)
      return () => clearInterval(t)
    }
  }, [cameraOn])

  function flash(type: ResultType, msg: string) {
    setLastResult({ type, msg })
    if (type === 'success') beepSuccess()
    else if (type === 'warn') beepWarn()
    else beepError()
  }

  // Load a column by its code + the live count of stocked pieces currently in it.
  const openColumn = useCallback(async (columnCode: string): Promise<ActiveColumn | null> => {
    const { data: c, error } = await supabase.from('stock_columns').select('*').eq('column_code', columnCode).maybeSingle()
    if (error) { flash('error', 'Error loading column'); return null }
    if (!c) { flash('error', `Column ${columnCode} not found. Create it in Columns first.`); return null }
    if (!c.active) { flash('error', `Column ${columnCode} is inactive.`); return null }
    return { id: c.id, column_code: c.column_code, bay: c.bay, row: c.row, sku: c.sku, max_qty: c.max_qty, enforce_max: c.enforce_max }
  }, [supabase])

  const refreshCount = useCallback(async (columnCode: string) => {
    const { count } = await supabase.from('packed_units').select('id', { count: 'exact', head: true }).eq('column_code', columnCode).eq('status', 'stocked')
    setCountInColumn(count ?? 0)
  }, [supabase])

  async function setActiveColumn(columnCode: string) {
    const c = await openColumn(columnCode)
    if (!c) return
    // If a column is already open with pieces added this session, confirm the switch.
    if (col && col.column_code !== c.column_code) { setPendingColumn(c); return }
    setCol(c); setScanned([]); sinceRemindRef.current = 0; setRemindAck(false)
    await refreshCount(c.column_code)
    flash('success', `Column ${c.column_code} open${c.sku ? ` · ${c.sku}` : ' · empty, next piece sets SKU'}`)
  }

  function confirmSwitch() {
    const c = pendingColumn; if (!c) return
    setCol(c); setScanned([]); sinceRemindRef.current = 0; setRemindAck(false); setPendingColumn(null)
    void refreshCount(c.column_code)
    flash('success', `Column ${c.column_code} open${c.sku ? ` · ${c.sku}` : ' · empty'}`)
  }

  const processScan = useCallback(async (raw: string) => {
    const value = (raw || '').trim()
    if (!value) return
    if (processingRef.current) return
    processingRef.current = true
    try {
      // A column barcode switches the active column (or confirms it).
      if (isColumnScan(value)) { await setActiveColumn(toColumnCode(value)); return }

      // A piece scan requires an open column.
      if (!col) { flash('error', 'Scan a column barcode first'); return }

      const barcode = value
      const { data: unit, error } = await supabase.from('packed_units').select('*').eq('barcode', barcode).maybeSingle()
      if (error) throw error
      if (!unit) { flash('error', `${barcode} not found`); return }
      if (unit.status === 'stocked') {
        flash('warn', unit.column_code === col.column_code ? `${barcode} already in this column` : `${barcode} already stocked in ${unit.column_code || 'another column'}`)
        return
      }
      if (unit.status !== 'packed') { flash('error', `${barcode} is ${unit.status} — cannot stock`); return }

      // SKU-lock: the column holds one SKU. If it already has one, the piece must match.
      const pieceSku = (unit.sku || '').trim()
      if (col.sku && pieceSku && pieceSku !== col.sku) {
        flash('error', `Wrong SKU — column ${col.column_code} holds ${col.sku}, this is ${pieceSku}`)
        return
      }

      // Max check: soft warn (or hard block if enforce_max).
      if (col.max_qty != null && countInColumn >= col.max_qty) {
        if (col.enforce_max) { flash('error', `Column ${col.column_code} full (${col.max_qty}). Wrong column?`); return }
        flash('warn', `Over max (${col.max_qty}) — are you in the right column?`)
        // soft: fall through and still add
      }

      const now = new Date().toISOString()
      const { error: upErr } = await supabase.from('packed_units').update({
        status: 'stocked', stocked_at: now, column_code: col.column_code,
      }).eq('id', unit.id).eq('status', 'packed')
      if (upErr) throw upErr

      // First piece into an empty column locks its SKU.
      if (!col.sku && pieceSku) {
        await supabase.from('stock_columns').update({ sku: pieceSku }).eq('id', col.id)
        setCol(prev => prev ? { ...prev, sku: pieceSku } : prev)
      }

      await supabase.from('stock_movements').insert({ barcode, column_code: col.column_code, direction: 'in', sku: pieceSku || col.sku || null, bypassed: false, by_email: userEmail || null })

      setScanned(prev => [{ barcode, unitId: unit.id }, ...prev])
      setCountInColumn(n => n + 1)
      flash('success', `Added ${barcode} to ${col.column_code}`)

      // Every-N reminder.
      sinceRemindRef.current += 1
      if (sinceRemindRef.current >= REMIND_EVERY) { sinceRemindRef.current = 0; setRemindAck(true) }
    } catch (e) {
      flash('error', 'Error: ' + (e as Error).message)
    } finally {
      processingRef.current = false
    }
  }, [col, countInColumn, supabase, userEmail])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); const v = e.currentTarget.value; e.currentTarget.value = ''; void processScan(v) }
  }

  async function undoScan(item: ScannedItem) {
    try {
      const { error } = await supabase.from('packed_units').update({ status: 'packed', stocked_at: null, column_code: null }).eq('id', item.unitId).eq('status', 'stocked')
      if (error) throw error
      setScanned(prev => prev.filter(s => s.unitId !== item.unitId))
      setCountInColumn(n => Math.max(0, n - 1))
      flash('warn', `Undone: ${item.barcode} back to packed`)
    } catch (e) {
      flash('error', 'Undo error: ' + (e as Error).message)
    }
  }

  const banner = lastResult?.type === 'success' ? { color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', border: '#bbf7d0' }
    : lastResult?.type === 'warn' ? { color: 'var(--today)', bg: 'var(--today-bg)', border: '#fed7aa' }
    : lastResult?.type === 'error' ? { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' }
    : { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14, maxWidth: 440 }}>
      {/* Active column banner */}
      {col ? (
        <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: 10, padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, opacity: 0.85, display: 'flex', alignItems: 'center', gap: 5 }}><MapPin size={13} /> Adding to</span>
            <button onClick={() => { setCol(null); setScanned([]); flash('warn', 'Column closed') }} style={{ fontSize: 11, fontWeight: 700, background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>Close</button>
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'DM Mono', margin: '2px 0' }}>{col.column_code}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
            <span>{col.sku ? <>Locked to <b style={{ fontFamily: 'DM Mono' }}>{col.sku}</b></> : 'Empty — next piece sets SKU'}</span>
            <span style={{ fontFamily: 'DM Mono' }}>{countInColumn}{col.max_qty != null && <span style={{ opacity: 0.7 }}> / {col.max_qty}</span>}</span>
          </div>
        </div>
      ) : (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', textAlign: 'center' as const, color: 'var(--text3)', fontSize: 14, fontWeight: 600 }}>
          Scan a column barcode to begin
        </div>
      )}

      {/* Scan input */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>{col ? 'Scan piece barcode' : 'Scan column, then pieces'}</div>
        <input ref={inputRef} autoFocus onKeyDown={handleKeyDown} disabled={cameraOn}
          placeholder="Scan column or piece"
          style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--accent)', background: cameraOn ? 'var(--bg2)' : 'var(--bg)', color: 'var(--text)', fontSize: 17, fontFamily: 'DM Mono', fontWeight: 700, textAlign: 'center' as const, letterSpacing: '0.05em', outline: 'none' }} />
      </div>

      {/* Result banner */}
      <div style={{ borderRadius: 8, border: `1px solid ${banner.border}`, background: banner.bg, color: banner.color, padding: '14px 16px', textAlign: 'center' as const, fontWeight: 700, fontSize: 14 }}>
        {lastResult?.msg || 'Ready'}
      </div>

      {/* Camera toggle */}
      <div>
        {!cameraOn ? (
          <button onClick={() => setCameraOn(true)} style={{ width: '100%', padding: '12px', borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Camera size={15} /> Use Camera Instead
          </button>
        ) : (
          <BarcodeScanner onScan={processScan} onClose={() => setCameraOn(false)} />
        )}
      </div>

      {/* This-session list */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Added this session ({scanned.length})</div>
        {!scanned.length ? (
          <div style={{ ...card, padding: 20, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Nothing added yet</div>
        ) : (
          <div style={{ ...card, overflow: 'auto', maxHeight: 260 }}>
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

      {/* Close-previous confirm */}
      {pendingColumn && (
        <div style={{ position: 'fixed' as const, inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setPendingColumn(null)}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(360px,94vw)', background: 'var(--surface)', borderRadius: 14, padding: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Switch column?</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 16 }}>Close <b style={{ fontFamily: 'DM Mono' }}>{col?.column_code}</b> and open <b style={{ fontFamily: 'DM Mono' }}>{pendingColumn.column_code}</b>{pendingColumn.sku ? ` (${pendingColumn.sku})` : ''}?</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setPendingColumn(null)} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmSwitch} style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Open {pendingColumn.column_code}</button>
            </div>
          </div>
        </div>
      )}

      {/* Every-N reminder */}
      {remindAck && col && (
        <div style={{ position: 'fixed' as const, inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ width: 'min(340px,94vw)', background: 'var(--surface)', borderRadius: 14, padding: 18, textAlign: 'center' as const }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Still on {col.column_code}?</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 16 }}>You&apos;ve added {REMIND_EVERY} pieces. Confirm you&apos;re still at this column, or scan the correct column barcode.</div>
            <button onClick={() => setRemindAck(false)} style={{ width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Yes, still {col.column_code}</button>
          </div>
        </div>
      )}
    </div>
  )
}
