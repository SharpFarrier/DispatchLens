'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'
import { Camera, Undo2, AlertTriangle } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

interface ScannedItem { barcode: string; prevStatus: string; unitId: string; returnId?: string }
type ResultType = 'success' | 'warn' | 'error'

export default function RtoTab() {
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
      const now = new Date().toISOString()

      // ── 1) Try REVERSE TRACKING ID first (the reliable identifier; barcode may be
      //        missing/damaged). Match an unreceived return whose reverse_tracking_id
      //        equals the scan. If several match (rare re-ship), take the newest.
      const { data: revReturns } = await supabase.from('returns')
        .select('id, order_id, barcode, warehouse_received, created_at')
        .eq('reverse_tracking_id', barcode).eq('warehouse_received', false)
        .order('created_at', { ascending: false })
      if (revReturns && revReturns.length) {
        const ret = revReturns[0]
        await supabase.from('returns')
          .update({ warehouse_received: true, warehouse_received_at: now, updated_at: now })
          .eq('id', ret.id)
        // If the return carries a packed barcode, also flip that unit to rto (keeps stock correct).
        let prevStatus = 'return'
        let unitId = `ret:${ret.id}`
        if (ret.barcode) {
          const { data: u } = await supabase.from('packed_units').select('id, status').eq('barcode', ret.barcode).maybeSingle()
          if (u && u.status !== 'rto') {
            await supabase.from('packed_units').update({ status: 'rto', rto_at: now }).eq('id', u.id)
            prevStatus = u.status; unitId = u.id
          }
        }
        setScanned(prev => [{ barcode, prevStatus, unitId, returnId: ret.id }, ...prev])
        flash('success', `Return received: ${barcode} · order ${ret.order_id}`)
        return
      }

      // ── 2) FORWARD AWB fallback: the scan may be the original dispatch AWB of an
      //        RTO'd order whose return has no reverse_tracking_id set. Find the order
      //        by tracking_number, then an unreceived return for that order.
      const { data: fwdOrders } = await supabase.from('dispatch_orders')
        .select('order_id, scanned_barcode, tracking_number').eq('tracking_number', barcode).limit(5)
      if (fwdOrders && fwdOrders.length) {
        const orderIds = fwdOrders.map(o => o.order_id)
        const { data: fwdReturns } = await supabase.from('returns')
          .select('id, order_id, barcode, warehouse_received, created_at')
          .in('order_id', orderIds).eq('warehouse_received', false)
          .order('created_at', { ascending: false })
        if (fwdReturns && fwdReturns.length) {
          // Existing return → mark it received.
          const ret = fwdReturns[0]
          await supabase.from('returns')
            .update({ warehouse_received: true, warehouse_received_at: now, updated_at: now })
            .eq('id', ret.id)
          let prevStatus = 'return'
          let unitId = `ret:${ret.id}`
          if (ret.barcode) {
            const { data: u } = await supabase.from('packed_units').select('id, status').eq('barcode', ret.barcode).maybeSingle()
            if (u && u.status !== 'rto') {
              await supabase.from('packed_units').update({ status: 'rto', rto_at: now }).eq('id', u.id)
              prevStatus = u.status; unitId = u.id
            }
          }
          setScanned(prev => [{ barcode, prevStatus, unitId, returnId: ret.id }, ...prev])
          flash('success', `Return received: ${barcode} · order ${ret.order_id} (matched forward AWB)`)
          return
        }
        // No return exists for this order yet → AUTO-CREATE one, received, reason pending,
        // so it surfaces in the Returns tab for the manager to set reason + refund.
        const ord = fwdOrders[0]
        const { data: created } = await supabase.from('returns').upsert({
          order_id: ord.order_id,
          source: 'rto_auto',
          reason: 'Pending review',
          barcode: ord.scanned_barcode || null,
          reverse_tracking_id: ord.tracking_number || barcode,
          warehouse_received: true,
          warehouse_received_at: now,
          updated_at: now,
        }, { onConflict: 'order_id' }).select('id').maybeSingle()
        // If the packed barcode is known, flip that unit to rto for stock accuracy.
        let prevStatus = 'return'
        let unitId = created?.id ? `ret:${created.id}` : `ret:${ord.order_id}`
        if (ord.scanned_barcode) {
          const { data: u } = await supabase.from('packed_units').select('id, status').eq('barcode', ord.scanned_barcode).maybeSingle()
          if (u && u.status !== 'rto') {
            await supabase.from('packed_units').update({ status: 'rto', rto_at: now }).eq('id', u.id)
            prevStatus = u.status; unitId = u.id
          }
        }
        setScanned(prev => [{ barcode, prevStatus, unitId, returnId: created?.id }, ...prev])
        flash('success', `Return received & logged: order ${ord.order_id} — set reason in Returns tab`)
        return
      }

      // ── 3) Fall back to BARCODE lookup in packed_units (original behaviour). ──
      const { data: unit, error } = await supabase.from('packed_units').select('*').eq('barcode', barcode).maybeSingle()
      if (error) throw error
      if (!unit) { flash('error', `${barcode} not found (no return, forward AWB, or barcode match)`); return }
      if (unit.status === 'rto') { flash('warn', `${barcode} already marked RTO`); return }

      const { error: upErr } = await supabase.from('packed_units').update({
        status: 'rto', rto_at: now,
      }).eq('id', unit.id)
      if (upErr) throw upErr

      // Bridge to the commercial Returns tracker by barcode.
      const { data: matchedReturns } = await supabase.from('returns')
        .update({ warehouse_received: true, warehouse_received_at: now, updated_at: now })
        .eq('barcode', barcode).eq('warehouse_received', false).select('id')
      let linkedReturnId: string | undefined = matchedReturns?.[0]?.id
      let noteExtra = linkedReturnId ? ' · return received' : ''

      // If no return existed for this barcode, try to resolve its order via the packed
      // barcode and AUTO-CREATE a return (received, reason pending) so it hits Returns tab.
      if (!linkedReturnId) {
        const { data: bOrders } = await supabase.from('dispatch_orders')
          .select('order_id, tracking_number').eq('scanned_barcode', barcode).limit(1)
        if (bOrders && bOrders.length) {
          const bo = bOrders[0]
          const { data: created } = await supabase.from('returns').upsert({
            order_id: bo.order_id,
            source: 'rto_auto',
            reason: 'Pending review',
            barcode,
            reverse_tracking_id: bo.tracking_number || null,
            warehouse_received: true,
            warehouse_received_at: now,
            updated_at: now,
          }, { onConflict: 'order_id' }).select('id').maybeSingle()
          linkedReturnId = created?.id
          noteExtra = ` · return logged (order ${bo.order_id}) — set reason in Returns tab`
        }
      }

      setScanned(prev => [{ barcode, prevStatus: unit.status, unitId: unit.id, returnId: linkedReturnId }, ...prev])
      flash('success', `RTO marked: ${barcode}${unit.status !== 'dispatched' ? ` (was ${unit.status})` : ''}${noteExtra}`)
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
      const now = new Date().toISOString()
      // Reverse the packed_unit RTO only if a real unit was flipped (unitId not synthetic).
      if (item.unitId && !item.unitId.startsWith('ret:')) {
        const { error } = await supabase.from('packed_units').update({
          status: item.prevStatus, rto_at: null,
        }).eq('id', item.unitId).eq('status', 'rto')
        if (error) throw error
      }
      // Reverse the Returns bridge — by return id when we have it, else by barcode.
      if (item.returnId) {
        await supabase.from('returns')
          .update({ warehouse_received: false, warehouse_received_at: null, updated_at: now })
          .eq('id', item.returnId)
      } else {
        await supabase.from('returns')
          .update({ warehouse_received: false, warehouse_received_at: null, updated_at: now })
          .eq('barcode', item.barcode).eq('warehouse_received', true)
      }
      setScanned(prev => prev.filter(s => s.unitId !== item.unitId))
      flash('warn', `Undone: ${item.barcode} back to ${item.prevStatus}`)
    } catch (e) {
      flash('error', 'Undo error: ' + (e as Error).message)
    }
  }

  const startCamera = useCallback(async () => {
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      setCameraOn(true)
      setTimeout(async () => {
        const el = document.getElementById('rto-camera')
        if (!el) return
        const cam = new Html5Qrcode('rto-camera')
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
        <span>RTO Intake</span>
        <span style={{ fontFamily: 'DM Mono' }}>{scanned.length} marked this session</span>
      </div>

      <div style={{ background: 'var(--today-bg)', border: '1px solid #fed7aa', borderRadius: 8, padding: '12px 16px', fontSize: 12, color: 'var(--today)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Returned units are marked <b>RTO</b> and held for inspection. They can&apos;t go back to stock here — inspection happens in the RTO treatment tab.</span>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Scan Returned Barcode</div>
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
            <div id="rto-camera" style={{ width: '100%', borderRadius: 8, overflow: 'hidden', background: '#000', minHeight: 200 }} />
            <button onClick={stopCamera} style={{ width: '100%', padding: '10px', borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Stop Camera</button>
          </div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Marked RTO this session ({scanned.length})</div>
        {!scanned.length ? (
          <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Nothing marked yet</div>
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
