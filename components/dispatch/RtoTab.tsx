'use client'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { logOrderEvent } from '@/lib/orderEvents'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'
import { Camera, Undo2, AlertTriangle, CheckCircle, XCircle, Package, Search, X } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

interface ScannedItem { barcode: string; prevStatus: string; unitId: string; returnId?: string; rejected?: boolean; orderId?: string }
type ResultType = 'success' | 'warn' | 'error'

const REJECT_REASONS = ['Wrong item', 'Damaged beyond return', 'Not our order', 'Other'] as const

// A resolved-but-not-yet-committed RTO match. All three match paths produce one of these.
interface Pending {
  barcode: string
  path: 'reverse' | 'forward' | 'barcode' | 'unmatched'
  orderId: string | null
  sku: string | null
  customer: string | null
  returnId: string | null        // existing return, if any
  returnReason: string | null
  packedBarcode: string | null   // packed_units barcode to flip to rto, if known
  // For the forward/barcode auto-create paths (no existing return yet):
  autoCreate: null | { order_id: string; scanned_barcode: string | null; tracking_number: string | null }
  // For the pure packed-unit path (path 3 barcode with a real unit):
  unit: null | { id: string; status: string }
}

export default function RtoTab() {
  const supabase = createClient()
  const [scanned, setScanned] = useState<ScannedItem[]>([])
  const [cameraOn, setCameraOn] = useState(false)
  const [lastResult, setLastResult] = useState<{ type: ResultType; msg: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState<string>(REJECT_REASONS[0])
  const [committing, setCommitting] = useState(false)
  const [skuMaps, setSkuMaps] = useState<{ id: string; master_sku: string; product_name: string | null; amazon_sku: string | null; flipkart_sku: string | null; website_sku: string | null }[]>([])
  const [rxMode, setRxMode] = useState<'product' | null>(null)
  const [skuQuery, setSkuQuery] = useState('')
  const [selSku, setSelSku] = useState<string | null>(null)
  useEffect(() => { supabase.from('dispatch_sku_map').select('id, master_sku, product_name, amazon_sku, flipkart_sku, website_sku').then((res: { data: typeof skuMaps | null }) => setSkuMaps(res.data || [])) }, [supabase])
  const skuHits = useMemo(() => {
    const q = skuQuery.trim().toLowerCase()
    if (!q) return []
    return skuMaps.filter(m =>
      m.master_sku?.toLowerCase().includes(q) || m.product_name?.toLowerCase().includes(q) ||
      m.amazon_sku?.toLowerCase().includes(q) || m.flipkart_sku?.toLowerCase().includes(q) || m.website_sku?.toLowerCase().includes(q)
    ).slice(0, 20)
  }, [skuQuery, skuMaps])
  const inputRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null)
  const processingRef = useRef(false)

  useEffect(() => {
    if (!cameraOn && !pending) {
      const t = setInterval(() => {
        if (document.activeElement !== inputRef.current) inputRef.current?.focus()
      }, 800)
      return () => clearInterval(t)
    }
  }, [cameraOn, pending])

  function flash(type: ResultType, msg: string) {
    setLastResult({ type, msg })
    if (type === 'success') beepSuccess()
    else if (type === 'warn') beepWarn()
    else beepError()
  }

  // ── PHASE 1: read-only lookup. Resolves the match across all 3 paths and stages
  //    a Pending for confirmation. Writes NOTHING to the DB. ──
  const lookupScan = useCallback(async (raw: string) => {
    const barcode = (raw || '').trim()
    if (!barcode) return
    if (processingRef.current || pending) return
    processingRef.current = true
    try {
      // Path 1: reverse tracking ID → unreceived return.
      const { data: revReturns } = await supabase.from('returns')
        .select('id, order_id, barcode, warehouse_received, reason, created_at')
        .eq('reverse_tracking_id', barcode).eq('warehouse_received', false)
        .order('created_at', { ascending: false })
      if (revReturns && revReturns.length) {
        const ret = revReturns[0]
        // Fetch order details for the preview.
        const { data: ord } = await supabase.from('dispatch_orders')
          .select('order_id, sku, customer_name').eq('order_id', ret.order_id).maybeSingle()
        setPending({ barcode, path: 'reverse', orderId: ret.order_id, sku: ord?.sku ?? null, customer: ord?.customer_name ?? null,
          returnId: ret.id, returnReason: ret.reason ?? null, packedBarcode: ret.barcode ?? null, autoCreate: null, unit: null })
        flash('success', `Matched return · order ${ret.order_id} — confirm below`)
        return
      }

      // Path 2: forward AWB → order → unreceived return (or auto-create).
      const { data: fwdOrders } = await supabase.from('dispatch_orders')
        .select('order_id, sku, customer_name, scanned_barcode, tracking_number').eq('tracking_number', barcode).limit(5)
      if (fwdOrders && fwdOrders.length) {
        const orderIds = fwdOrders.map(o => o.order_id)
        const { data: fwdReturns } = await supabase.from('returns')
          .select('id, order_id, barcode, warehouse_received, reason, created_at')
          .in('order_id', orderIds).eq('warehouse_received', false)
          .order('created_at', { ascending: false })
        if (fwdReturns && fwdReturns.length) {
          const ret = fwdReturns[0]
          const ord = fwdOrders.find(o => o.order_id === ret.order_id) || fwdOrders[0]
          setPending({ barcode, path: 'forward', orderId: ret.order_id, sku: ord?.sku ?? null, customer: ord?.customer_name ?? null,
            returnId: ret.id, returnReason: ret.reason ?? null, packedBarcode: ret.barcode ?? null, autoCreate: null, unit: null })
          flash('success', `Matched return · order ${ret.order_id} (forward AWB) — confirm below`)
          return
        }
        // No return yet → stage an auto-create.
        const ord = fwdOrders[0]
        setPending({ barcode, path: 'forward', orderId: ord.order_id, sku: ord.sku ?? null, customer: ord.customer_name ?? null,
          returnId: null, returnReason: null, packedBarcode: ord.scanned_barcode ?? null,
          autoCreate: { order_id: ord.order_id, scanned_barcode: ord.scanned_barcode ?? null, tracking_number: ord.tracking_number ?? null }, unit: null })
        flash('success', `Order ${ord.order_id} (forward AWB, no return yet) — confirm below`)
        return
      }

      // Path 3: packed_units barcode.
      const { data: unit, error } = await supabase.from('packed_units').select('*').eq('barcode', barcode).maybeSingle()
      if (error) throw error
      if (!unit) {
        setPending({ barcode, path: 'unmatched', orderId: null, sku: null, customer: null, returnId: null, returnReason: null, packedBarcode: null, autoCreate: null, unit: null })
        flash('warn', `${barcode} not found — receive as a new return below`)
        return
      }
      if (unit.status === 'rto') { flash('warn', `${barcode} already marked RTO`); return }
      // Resolve order for preview + a possible existing return / auto-create.
      const { data: bOrders } = await supabase.from('dispatch_orders')
        .select('order_id, sku, customer_name, tracking_number').eq('scanned_barcode', barcode).limit(1)
      const bo = bOrders && bOrders.length ? bOrders[0] : null
      const { data: existRet } = await supabase.from('returns')
        .select('id, order_id, reason').eq('barcode', barcode).eq('warehouse_received', false).maybeSingle()
      setPending({ barcode, path: 'barcode', orderId: bo?.order_id ?? existRet?.order_id ?? null, sku: bo?.sku ?? null, customer: bo?.customer_name ?? null,
        returnId: existRet?.id ?? null, returnReason: existRet?.reason ?? null, packedBarcode: barcode,
        autoCreate: (!existRet && bo) ? { order_id: bo.order_id, scanned_barcode: barcode, tracking_number: bo.tracking_number ?? null } : null,
        unit: { id: unit.id, status: unit.status } })
      flash('success', `Barcode ${barcode}${bo ? ` · order ${bo.order_id}` : ''} — confirm below`)
    } catch (e) {
      flash('error', 'Error: ' + (e as Error).message)
    } finally {
      processingRef.current = false
    }
  }, [supabase, pending])

  // ── PHASE 2a: commit RECEIVE. Runs the writes staged in `pending`. ──
  async function confirmReceive() {
    if (!pending || committing) return
    setCommitting(true)
    try {
      const now = new Date().toISOString()
      let returnId = pending.returnId ?? undefined
      let prevStatus = 'return'
      let unitId = pending.returnId ? `ret:${pending.returnId}` : `scan:${pending.barcode}`

      // Existing return → mark received.
      if (pending.returnId) {
        await supabase.from('returns')
          .update({ warehouse_received: true, warehouse_received_at: now, updated_at: now })
          .eq('id', pending.returnId)
      } else if (pending.autoCreate) {
        // Auto-create a received return (reason pending) so it hits the Returns tab.
        // This order was NOT manually added as a return, so there is NO known reverse
        // (RTO) tracking id. Do NOT write the forward AWB / scanned barcode into
        // reverse_tracking_id — the forward tracking number is not the reverse one.
        // Leave reverse_tracking_id null; it can be filled later if a real reverse
        // AWB is captured (e.g. Bluedart <NewWaybillNo>) or entered manually.
        const { data: created } = await supabase.from('returns').upsert({
          order_id: pending.autoCreate.order_id,
          source: 'rto_auto',
          reason: 'Pending review',
          barcode: pending.autoCreate.scanned_barcode,
          reverse_tracking_id: null,
          warehouse_received: true,
          warehouse_received_at: now,
          updated_at: now,
        }, { onConflict: 'order_id' }).select('id').maybeSingle()
        returnId = created?.id ?? undefined
        unitId = returnId ? `ret:${returnId}` : unitId
      }

      // Flip the packed unit to rto (path 3 real unit, or a known packed barcode).
      const flipBarcode = pending.unit ? null : pending.packedBarcode
      if (pending.unit && pending.unit.status !== 'rto') {
        await supabase.from('packed_units').update({ status: 'rto', rto_at: now }).eq('id', pending.unit.id)
        prevStatus = pending.unit.status; unitId = pending.unit.id
      } else if (flipBarcode) {
        const { data: u } = await supabase.from('packed_units').select('id, status').eq('barcode', flipBarcode).maybeSingle()
        if (u && u.status !== 'rto') {
          await supabase.from('packed_units').update({ status: 'rto', rto_at: now }).eq('id', u.id)
          prevStatus = u.status; unitId = u.id
        }
      }

      setScanned(prev => [{ barcode: pending.barcode, prevStatus, unitId, returnId, orderId: pending.orderId ?? undefined }, ...prev])
      if (pending.orderId) void logOrderEvent(pending.orderId, 'return', 'RTO piece received at intake', `barcode ${pending.barcode}`)
      flash('success', `Received: ${pending.barcode}${pending.orderId ? ` · order ${pending.orderId}` : ''}`)
      setPending(null)
    } catch (e) {
      flash('error', 'Receive error: ' + (e as Error).message)
    } finally {
      setCommitting(false)
    }
  }

  // Receive an UNMATCHED scan as a new unmapped return (order linked later via forward AWB).
  async function confirmUnmatchedReceive() {
    if (!pending || !selSku || committing) return
    setCommitting(true)
    try {
      const now = new Date().toISOString()
      const { data: dup } = await supabase.from('returns').select('id, order_id').eq('reverse_tracking_id', pending.barcode).limit(1).maybeSingle()
      if (dup) {
        const d = dup as { id: string; order_id: string | null }
        flash('error', d.order_id ? `Already received — on order ${d.order_id}` : 'Already received — awaiting mapping')
        setCommitting(false); return
      }
      const { data: auth } = await supabase.auth.getUser()
      const { data: created } = await supabase.from('returns').insert({
        order_id: null, source: 'manual', return_type: 'customer', reason: 'Pending review',
        received_sku: selSku, reverse_tracking_id: pending.barcode,
        warehouse_received: true, warehouse_received_at: now,
        created_by: auth?.user?.id ?? null, created_by_email: auth?.user?.email ?? null, updated_at: now,
      }).select('id').maybeSingle()
      setScanned(prev => [{ barcode: pending.barcode, prevStatus: 'return', unitId: `ret:${created?.id || pending.barcode}`, returnId: created?.id ?? undefined }, ...prev])
      flash('success', `Received: ${selSku} · reverse ${pending.barcode} — awaiting order mapping`)
      setPending(null); setRxMode(null); setSelSku(null); setSkuQuery('')
    } catch (e) {
      flash('error', 'Receive error: ' + (e as Error).message)
    } finally { setCommitting(false) }
  }

  // ── PHASE 2b: commit REJECT. Marks the return rejected + reason (shows in Returns tab). ──
  async function confirmReject() {
    if (!pending || committing) return
    setCommitting(true)
    try {
      const now = new Date().toISOString()
      const reason = rejectReason
      let returnId = pending.returnId ?? undefined

      if (pending.returnId) {
        await supabase.from('returns')
          .update({ is_rejected: true, rejected_reason: reason, rejected_at: now, updated_at: now })
          .eq('id', pending.returnId)
      } else if (pending.autoCreate) {
        // No return yet → create one that is rejected (not received), so it surfaces for review.
        // As with the receive path: no manually-added return means no known reverse (RTO)
        // tracking id — never write the forward AWB / scanned barcode into reverse_tracking_id.
        const { data: created } = await supabase.from('returns').upsert({
          order_id: pending.autoCreate.order_id,
          source: 'rto_auto',
          reason: 'Pending review',
          barcode: pending.autoCreate.scanned_barcode,
          reverse_tracking_id: null,
          warehouse_received: false,
          is_rejected: true,
          rejected_reason: reason,
          rejected_at: now,
          updated_at: now,
        }, { onConflict: 'order_id' }).select('id').maybeSingle()
        returnId = created?.id ?? undefined
      } else {
        flash('warn', 'Nothing to reject — no return record for this scan.')
        setCommitting(false); return
      }

      setScanned(prev => [{ barcode: pending.barcode, prevStatus: 'return', unitId: `rej:${returnId || pending.barcode}`, returnId, rejected: true, orderId: pending.orderId ?? undefined }, ...prev])
      if (pending.orderId) void logOrderEvent(pending.orderId, 'return', `RTO piece rejected · ${reason}`, `barcode ${pending.barcode}`)
      flash('warn', `Rejected: ${pending.barcode}${pending.orderId ? ` · order ${pending.orderId}` : ''} — ${reason}`)
      setPending(null); setRejecting(false); setRejectReason(REJECT_REASONS[0])
    } catch (e) {
      flash('error', 'Reject error: ' + (e as Error).message)
    } finally {
      setCommitting(false)
    }
  }

  function cancelPending() {
    setPending(null); setRejecting(false); setRejectReason(REJECT_REASONS[0]); setRxMode(null); setSelSku(null); setSkuQuery('')
    flash('warn', 'Cancelled — scan again')
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const val = e.currentTarget.value
      e.currentTarget.value = ''
      lookupScan(val)
    }
  }

  async function undoScan(item: ScannedItem) {
    try {
      const now = new Date().toISOString()
      if (item.rejected) {
        if (item.returnId) {
          await supabase.from('returns')
            .update({ is_rejected: false, rejected_reason: null, rejected_at: null, updated_at: now })
            .eq('id', item.returnId)
        }
        setScanned(prev => prev.filter(s => s.unitId !== item.unitId))
        flash('warn', `Rejection undone: ${item.barcode}`)
        return
      }
      if (item.unitId && !item.unitId.startsWith('ret:') && !item.unitId.startsWith('scan:') && !item.unitId.startsWith('rej:')) {
        const { error } = await supabase.from('packed_units').update({
          status: item.prevStatus, rto_at: null,
        }).eq('id', item.unitId).eq('status', 'rto')
        if (error) throw error
      }
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
          (decoded: string) => { lookupScan(decoded) }, () => {})
      }, 100)
    } catch (e) {
      flash('error', 'Camera unavailable: ' + (e as Error).message)
      setCameraOn(false)
    }
  }, [lookupScan])

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
        <span style={{ fontFamily: 'DM Mono' }}>{scanned.length} done this session</span>
      </div>

      <div style={{ background: 'var(--today-bg)', border: '1px solid #fed7aa', borderRadius: 8, padding: '12px 16px', fontSize: 12, color: 'var(--today)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>Scan a returned unit to see its order, then <b>confirm receipt</b> or <b>reject</b> it. Received units are held for inspection in the RTO treatment tab.</span>
      </div>

      {/* Confirm card — appears after a successful scan match, before any DB write. */}
      {pending && pending.path !== 'unmatched' && (
        <div style={{ ...card, border: '2px solid var(--accent)', padding: 0, overflow: 'hidden' }}>
          <div style={{ background: 'var(--accent-bg)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent)', fontWeight: 700, fontSize: 13 }}>
            <Package size={15} /> Confirm this return
          </div>
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 13 }}>
              <span style={{ color: 'var(--text3)', fontFamily: 'DM Mono', fontSize: 11 }}>Order ID</span>
              <span style={{ fontWeight: 700, color: 'var(--text)' }}>{pending.orderId || '—'}</span>
              <span style={{ color: 'var(--text3)', fontFamily: 'DM Mono', fontSize: 11 }}>SKU</span>
              <span style={{ fontFamily: 'DM Mono', color: 'var(--text)' }}>{pending.sku || '—'}</span>
              <span style={{ color: 'var(--text3)', fontFamily: 'DM Mono', fontSize: 11 }}>Customer</span>
              <span style={{ color: 'var(--text)' }}>{pending.customer || '—'}</span>
              <span style={{ color: 'var(--text3)', fontFamily: 'DM Mono', fontSize: 11 }}>Scanned</span>
              <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{pending.barcode}</span>
            </div>

            {!rejecting ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={confirmReceive} disabled={committing}
                  style={{ flex: 1, padding: '10px', borderRadius: 7, border: 'none', background: committing ? 'var(--bg2)' : 'var(--dispatched)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: committing ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <CheckCircle size={15} /> {committing ? 'Saving…' : 'Mark received'}
                </button>
                <button onClick={() => setRejecting(true)} disabled={committing}
                  style={{ flex: 1, padding: '10px', borderRadius: 7, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <XCircle size={15} /> Reject RTO
                </button>
                <button onClick={cancelPending} disabled={committing}
                  style={{ padding: '10px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8, marginTop: 4, padding: 12, background: 'var(--critical-bg)', border: '1px solid #fecaca', borderRadius: 7 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--critical)' }}>Reject reason</span>
                <select value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                  style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, cursor: 'pointer' }}>
                  {REJECT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={confirmReject} disabled={committing}
                    style={{ flex: 1, padding: '9px', borderRadius: 6, border: 'none', background: 'var(--critical)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: committing ? 'wait' : 'pointer' }}>
                    {committing ? 'Saving…' : 'Confirm reject'}
                  </button>
                  <button onClick={() => setRejecting(false)} disabled={committing}
                    style={{ padding: '9px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer' }}>
                    Back
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {pending && pending.path === 'unmatched' && (
        <div style={{ ...card, border: '2px solid var(--today)', padding: 0, overflow: 'hidden' }}>
          <div style={{ background: 'var(--today-bg)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--today)', fontWeight: 700, fontSize: 13 }}>
            <AlertTriangle size={15} /> Not found — receive as a new return
          </div>
          <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
            <div style={{ fontSize: 13, color: 'var(--text2)' }}>
              <span style={{ fontFamily: 'DM Mono', color: 'var(--text)' }}>{pending.barcode}</span> isn&apos;t a known return, order, or barcode. Receive it anyway, then record what came back.
            </div>
            {rxMode === null ? (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                <button onClick={() => setRxMode('product')} disabled={committing}
                  style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Package size={18} /> Mark received
                </button>
                <button onClick={cancelPending} disabled={committing}
                  style={{ width: '100%', padding: '12px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>What did you receive?</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: '11px 12px' }}>
                  <Search size={18} style={{ color: 'var(--text3)', flexShrink: 0 }} />
                  <input autoFocus value={skuQuery} onChange={e => setSkuQuery(e.target.value)} placeholder="Search SKU or product name"
                    style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 16, outline: 'none', width: '100%', fontFamily: 'DM Sans' }} />
                  {skuQuery && <button onClick={() => { setSkuQuery(''); setSelSku(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0, display: 'flex' }}><X size={18} /></button>}
                </div>
                {skuQuery.trim().length >= 1 && (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 10, maxHeight: 340, overflowY: 'auto' as const }}>
                    {skuHits.length === 0 ? (
                      <div style={{ padding: 14, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No products match</div>
                    ) : skuHits.map(m => {
                      const sel = selSku === m.master_sku
                      return (
                        <button key={m.id} onClick={() => setSelSku(m.master_sku)}
                          style={{ width: '100%', textAlign: 'left' as const, padding: '11px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: sel ? 'var(--accent-bg)' : 'var(--surface)', borderTop: 'none', borderLeft: 'none', borderRight: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontFamily: 'DM Mono', fontSize: 14, color: sel ? 'var(--accent)' : 'var(--text)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.master_sku}</div>
                            {m.product_name && <div style={{ fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{m.product_name}</div>}
                          </div>
                          {sel && <CheckCircle size={20} style={{ flexShrink: 0, color: 'var(--accent)' }} />}
                        </button>
                      )
                    })}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8, marginTop: 2 }}>
                  <button onClick={confirmUnmatchedReceive} disabled={committing || !selSku}
                    style={{ width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: (committing || !selSku) ? 'var(--bg2)' : 'var(--dispatched)', color: (committing || !selSku) ? 'var(--text3)' : '#fff', fontSize: 16, fontWeight: 700, cursor: (committing || !selSku) ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    <CheckCircle size={18} /> {committing ? 'Saving…' : selSku ? `Confirm · ${selSku}` : 'Select a product'}
                  </button>
                  <button onClick={cancelPending} disabled={committing}
                    style={{ width: '100%', padding: '12px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Scan Returned Barcode / Tracking ID</div>
        <input ref={inputRef} autoFocus onKeyDown={handleKeyDown} disabled={cameraOn || !!pending}
          placeholder={pending ? 'Confirm the return above first' : 'Scan with gun, or use camera below'}
          style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--accent)', background: (cameraOn || pending) ? 'var(--bg2)' : 'var(--bg)', color: 'var(--text)', fontSize: 17, fontFamily: 'DM Mono', fontWeight: 700, textAlign: 'center' as const, letterSpacing: '0.05em', outline: 'none' }} />
      </div>

      <div style={{ borderRadius: 8, border: `1px solid ${banner.border}`, background: banner.bg, color: banner.color, padding: '14px 16px', textAlign: 'center' as const, fontWeight: 700, fontSize: 14 }}>
        {lastResult?.msg || 'Ready to scan'}
      </div>

      <div>
        {!cameraOn ? (
          <button onClick={startCamera} disabled={!!pending} style={{ width: '100%', padding: '12px', borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, cursor: pending ? 'not-allowed' : 'pointer', opacity: pending ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
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
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Handled this session ({scanned.length})</div>
        {!scanned.length ? (
          <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Nothing handled yet</div>
        ) : (
          <div style={{ ...card, overflow: 'auto', maxHeight: 288 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <tbody>
                {scanned.map((s, i) => (
                  <tr key={s.unitId} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{s.barcode}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'DM Mono', padding: '2px 7px', borderRadius: 4, color: s.rejected ? 'var(--critical)' : 'var(--dispatched)', background: s.rejected ? 'var(--critical-bg)' : 'var(--dispatched-bg)' }}>{s.rejected ? 'REJECTED' : 'RECEIVED'}</span>
                    </td>
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
