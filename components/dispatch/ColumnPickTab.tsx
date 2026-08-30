'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'
import { Camera, Undo2, ListChecks } from 'lucide-react'
import BarcodeScanner from './BarcodeScanner'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }
const COL_PREFIX = /^COL-/i
const isColumnScan = (raw: string) => COL_PREFIX.test(raw.trim())

interface PickedItem { barcode: string; unitId: string; sku: string | null; column_code: string | null; bypassed: boolean }
type ResultType = 'success' | 'warn' | 'error'

// A piece is pickable when its SKU has unmet demand on today's picklist:
//   demand[sku]  = scheduled-for-today, undispatched orders for that SKU
//   pickedToday[sku] = pieces already picked today for that SKU
// remaining = demand - pickedToday. remaining <= 0  → not on picklist (reject + bypass).
export default function ColumnPickTab({ userEmail }: { userEmail?: string }) {
  const supabase = createClient()
  const [demand, setDemand] = useState<Record<string, number>>({})
  const [pickedToday, setPickedToday] = useState<Record<string, number>>({})
  const [picked, setPicked] = useState<PickedItem[]>([])
  const [cameraOn, setCameraOn] = useState(false)
  const [lastResult, setLastResult] = useState<{ type: ResultType; msg: string } | null>(null)
  const [bypassPrompt, setBypassPrompt] = useState<{ barcode: string; unitId: string; sku: string | null; column_code: string | null; reason: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const processingRef = useRef(false)

  const todayISO = () => new Date().toISOString().slice(0, 10)

  const loadPicklist = useCallback(async () => {
    setLoading(true)
    const today = todayISO()
    // Demand: scheduled-for-today, not cancelled, not dispatched — keyed by barcode_sku (fallback sku).
    const orders = await fetchAllRows<{ sku: string | null; barcode_sku: string | null; plan_decision: string | null; scheduled_date: string | null; is_cancelled: boolean | null; is_dispatched: boolean | null }>((from, to) =>
      supabase.from('dispatch_orders').select('sku, barcode_sku, plan_decision, scheduled_date, is_cancelled, is_dispatched')
        .eq('plan_decision', 'scheduled').eq('scheduled_date', today).range(from, to))
    const dem: Record<string, number> = {}
    for (const o of orders) {
      if (o.is_cancelled || o.is_dispatched) continue
      const k = (o.barcode_sku || o.sku || '').trim(); if (!k) continue
      dem[k] = (dem[k] || 0) + 1
    }
    // Picked today: packed_units flipped to 'picked' with picked_at today.
    const pk = await fetchAllRows<{ sku: string | null }>((from, to) =>
      supabase.from('packed_units').select('sku').eq('status', 'picked').gte('picked_at', today + 'T00:00:00').range(from, to))
    const pkc: Record<string, number> = {}
    for (const r of pk) { const k = (r.sku || '').trim(); if (k) pkc[k] = (pkc[k] || 0) + 1 }
    setDemand(dem); setPickedToday(pkc); setLoading(false)
  }, [supabase])

  useEffect(() => { void loadPicklist() }, [loadPicklist])

  useEffect(() => {
    if (!cameraOn) {
      const t = setInterval(() => { if (document.activeElement !== inputRef.current) inputRef.current?.focus() }, 800)
      return () => clearInterval(t)
    }
  }, [cameraOn])

  function flash(type: ResultType, msg: string) {
    setLastResult({ type, msg })
    if (type === 'success') beepSuccess(); else if (type === 'warn') beepWarn(); else beepError()
  }

  const commitPick = useCallback(async (unitId: string, barcode: string, sku: string | null, column_code: string | null, bypassed: boolean) => {
    const now = new Date().toISOString()
    const { error } = await supabase.from('packed_units').update({ status: 'picked', picked_at: now, column_code: null })
      .eq('id', unitId).eq('status', 'stocked')
    if (error) { flash('error', 'Pick failed: ' + error.message); return }
    await supabase.from('stock_movements').insert({ barcode, column_code, direction: 'pick', sku, bypassed, by_email: userEmail || null })
    const k = (sku || '').trim()
    if (k) setPickedToday(p => ({ ...p, [k]: (p[k] || 0) + 1 }))
    setPicked(prev => [{ barcode, unitId, sku, column_code, bypassed }, ...prev])
    flash(bypassed ? 'warn' : 'success', `${bypassed ? 'Picked (bypass)' : 'Picked'}: ${barcode}${column_code ? ` · from ${column_code}` : ''}`)
  }, [supabase, userEmail])

  const processScan = useCallback(async (raw: string) => {
    const value = (raw || '').trim()
    if (!value || processingRef.current) return
    if (isColumnScan(value)) { flash('warn', 'Column scan noted — scan the pieces to pick'); return }
    processingRef.current = true
    try {
      const { data: unit, error } = await supabase.from('packed_units').select('id, status, sku, column_code').eq('barcode', value).maybeSingle()
      if (error) throw error
      if (!unit) { flash('error', `${value} not found`); return }
      if (unit.status === 'picked') { flash('warn', `${value} already picked`); return }
      if (unit.status === 'dispatched') { flash('error', `${value} already dispatched`); return }
      if (unit.status !== 'stocked') { flash('error', `${value} is ${unit.status} — only stocked pieces can be picked`); return }

      const sku = (unit.sku || '').trim()
      const remaining = (demand[sku] || 0) - (pickedToday[sku] || 0)
      if (remaining <= 0) {
        // Not on today's picklist (or already fully picked) — reject with a bypass option.
        beepError()
        setBypassPrompt({ barcode: value, unitId: unit.id, sku: unit.sku, column_code: unit.column_code, reason: (demand[sku] || 0) === 0 ? `${sku || 'This SKU'} isn't on today's picklist.` : `Already picked enough ${sku} for today (${pickedToday[sku] || 0}/${demand[sku] || 0}).` })
        return
      }
      await commitPick(unit.id, value, unit.sku, unit.column_code, false)
    } catch (e) {
      flash('error', 'Error: ' + (e as Error).message)
    } finally {
      processingRef.current = false
    }
  }, [demand, pickedToday, supabase, commitPick])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); const v = e.currentTarget.value; e.currentTarget.value = ''; void processScan(v) }
  }

  async function undoPick(item: PickedItem) {
    // Return the piece to stocked in its original column.
    const { error } = await supabase.from('packed_units').update({ status: 'stocked', picked_at: null, column_code: item.column_code })
      .eq('id', item.unitId).eq('status', 'picked')
    if (error) { flash('error', 'Undo failed: ' + error.message); return }
    const k = (item.sku || '').trim(); if (k) setPickedToday(p => ({ ...p, [k]: Math.max(0, (p[k] || 0) - 1) }))
    setPicked(prev => prev.filter(s => s.unitId !== item.unitId))
    flash('warn', `Undone: ${item.barcode} back to stocked`)
  }

  const demandEntries = Object.entries(demand).map(([sku, d]) => ({ sku, demand: d, picked: pickedToday[sku] || 0 })).filter(e => e.demand > 0).sort((a, b) => (b.demand - b.picked) - (a.demand - a.picked))
  const totalRemaining = demandEntries.reduce((s, e) => s + Math.max(0, e.demand - e.picked), 0)

  const banner = lastResult?.type === 'success' ? { color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', border: '#bbf7d0' }
    : lastResult?.type === 'warn' ? { color: 'var(--today)', bg: 'var(--today-bg)', border: '#fed7aa' }
    : lastResult?.type === 'error' ? { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' }
    : { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14, maxWidth: 440 }}>
      <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}><ListChecks size={15} /> Pick for dispatch</span>
        <button onClick={() => void loadPicklist()} style={{ fontSize: 11, fontWeight: 700, background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', borderRadius: 6, padding: '4px 9px', cursor: 'pointer' }}>Refresh</button>
      </div>

      <div style={{ ...card, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, color: 'var(--text2)' }}>Today&apos;s picklist</span>
        <span style={{ fontSize: 13, fontFamily: 'DM Mono', fontWeight: 700, color: totalRemaining > 0 ? 'var(--accent)' : 'var(--dispatched)' }}>{loading ? '…' : `${totalRemaining} left to pick`}</span>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Scan piece barcode</div>
        <input ref={inputRef} autoFocus onKeyDown={handleKeyDown} disabled={cameraOn} placeholder="Scan the piece being picked"
          style={{ width: '100%', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--accent)', background: cameraOn ? 'var(--bg2)' : 'var(--bg)', color: 'var(--text)', fontSize: 17, fontFamily: 'DM Mono', fontWeight: 700, textAlign: 'center' as const, letterSpacing: '0.05em', outline: 'none' }} />
      </div>

      <div style={{ borderRadius: 8, border: `1px solid ${banner.border}`, background: banner.bg, color: banner.color, padding: '14px 16px', textAlign: 'center' as const, fontWeight: 700, fontSize: 14 }}>
        {lastResult?.msg || 'Ready to pick'}
      </div>

      <div>
        {!cameraOn ? (
          <button onClick={() => setCameraOn(true)} style={{ width: '100%', padding: '12px', borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Camera size={15} /> Use Camera Instead
          </button>
        ) : (
          <BarcodeScanner onScan={processScan} onClose={() => setCameraOn(false)} />
        )}
      </div>

      {/* Remaining demand by SKU */}
      {demandEntries.length > 0 && (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>To pick by SKU</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
            <tbody>
              {demandEntries.map(e => {
                const rem = Math.max(0, e.demand - e.picked)
                return (
                  <tr key={e.sku} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 12px', fontFamily: 'DM Mono' }}>{e.sku}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: rem === 0 ? 'var(--dispatched)' : 'var(--text2)' }}>{e.picked}/{e.demand}{rem === 0 ? ' ✓' : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Picked this session ({picked.length})</div>
        {!picked.length ? (
          <div style={{ ...card, padding: 20, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Nothing picked yet</div>
        ) : (
          <div style={{ ...card, overflow: 'auto', maxHeight: 260 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <tbody>
                {picked.map((s, i) => (
                  <tr key={s.unitId} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{s.barcode}{s.bypassed && <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--today)', border: '1px solid #fed7aa', borderRadius: 4, padding: '0 4px' }}>bypass</span>}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' as const }}>
                      <button onClick={() => undoPick(s)} style={{ fontSize: 11, fontWeight: 700, color: 'var(--critical)', border: '1px solid #fecaca', borderRadius: 6, padding: '3px 8px', background: 'var(--surface)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
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

      {/* Bypass prompt */}
      {bypassPrompt && (
        <div style={{ position: 'fixed' as const, inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setBypassPrompt(null)}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(360px,94vw)', background: 'var(--surface)', borderRadius: 14, padding: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: 'var(--critical)' }}>Not on today&apos;s picklist</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}>{bypassPrompt.reason}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16, fontFamily: 'DM Mono' }}>{bypassPrompt.barcode}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setBypassPrompt(null)} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => { const b = bypassPrompt; setBypassPrompt(null); void commitPick(b.unitId, b.barcode, b.sku, b.column_code, true) }} style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--today)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Pick anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
