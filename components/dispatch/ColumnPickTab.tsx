'use client'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'
import { Camera, Undo2, ChevronLeft, ChevronRight, CircleCheck } from 'lucide-react'
import BarcodeScanner from './BarcodeScanner'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }
const COL_PREFIX = /^COL-/i
const isColumnScan = (raw: string) => COL_PREFIX.test(raw.trim())
type Courier = 'Delhivery' | 'Bluedart'
type ResultType = 'success' | 'warn' | 'error'

interface PickedItem { barcode: string; unitId: string; sku: string | null; column_code: string | null }

// Demand keyed by (courier, sku). A piece is pickable on the SELECTED courier when that
// courier still needs its SKU. If another courier needs it -> "belongs to <other>, set aside".
// Needed by neither -> "not needed today". No bypass.
export default function ColumnPickTab({ userEmail }: { userEmail?: string }) {
  const supabase = createClient()
  const [demand, setDemand] = useState<Record<Courier, Record<string, number>>>({ Delhivery: {}, Bluedart: {} })
  const [pickedToday, setPickedToday] = useState<Record<string, number>>({})   // by sku, across couriers (a picked piece isn't courier-specific)
  const [pickedByCourier, setPickedByCourier] = useState<Record<Courier, Record<string, number>>>({ Delhivery: {}, Bluedart: {} })
  const [names, setNames] = useState<Record<string, string>>({})
  const [courier, setCourier] = useState<Courier | null>(null)
  const [picked, setPicked] = useState<PickedItem[]>([])
  const [cameraOn, setCameraOn] = useState(false)
  const [lastResult, setLastResult] = useState<{ type: ResultType; msg: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const processingRef = useRef(false)

  const todayISO = () => new Date().toISOString().slice(0, 10)

  const loadPicklist = useCallback(async () => {
    setLoading(true)
    const today = todayISO()
    const orders = await fetchAllRows<{ sku: string | null; barcode_sku: string | null; courier: string | null; plan_decision: string | null; scheduled_date: string | null; is_cancelled: boolean | null; is_dispatched: boolean | null }>((from, to) =>
      supabase.from('dispatch_orders').select('sku, barcode_sku, courier, plan_decision, scheduled_date, is_cancelled, is_dispatched')
        .eq('plan_decision', 'scheduled').eq('scheduled_date', today).range(from, to))
    const dem: Record<Courier, Record<string, number>> = { Delhivery: {}, Bluedart: {} }
    for (const o of orders) {
      if (o.is_cancelled || o.is_dispatched) continue
      const k = (o.barcode_sku || o.sku || '').trim(); if (!k) continue
      const c = (o.courier === 'Bluedart') ? 'Bluedart' : (o.courier === 'Delhivery') ? 'Delhivery' : null
      if (!c) continue
      dem[c][k] = (dem[c][k] || 0) + 1
    }
    // "Already picked" = pieces CURRENTLY in 'picked' status (ANY day). A piece that was
    // dispatched flips to 'dispatched', so status='picked' == picked-and-not-yet-dispatched.
    // Counting these (not just today's) means a piece picked yesterday but not dispatched still
    // satisfies today's demand -> no double-pick. (Fix 1.)
    const pk = await fetchAllRows<{ sku: string | null; picked_courier: string | null }>((from, to) =>
      supabase.from('packed_units').select('sku, picked_courier').eq('status', 'picked').range(from, to))
    // Attribute each picked piece to the courier it was ACTUALLY picked for (stored at pick time
    // — the picker physically placed it in that courier's section). No re-guessing. Pieces picked
    // before picked_courier existed (null) are treated as backlog and demand-filled once.
    const pbc: Record<Courier, Record<string, number>> = { Delhivery: {}, Bluedart: {} }
    const nullByS: Record<string, number> = {}
    for (const r of pk) {
      const k = (r.sku || '').trim(); if (!k) continue
      if (r.picked_courier === 'Delhivery' || r.picked_courier === 'Bluedart') {
        pbc[r.picked_courier][k] = (pbc[r.picked_courier][k] || 0) + 1
      } else {
        nullByS[k] = (nullByS[k] || 0) + 1   // legacy null-courier picks
      }
    }
    // Legacy backlog: fill remaining demand (Delhivery first) — one-time until they dispatch/clear.
    for (const k of Object.keys(nullByS)) {
      let remaining = nullByS[k]
      for (const c of ['Delhivery', 'Bluedart'] as Courier[]) {
        const need = Math.max(0, (dem[c][k] || 0) - (pbc[c][k] || 0))
        const take = Math.min(remaining, need)
        if (take > 0) { pbc[c][k] = (pbc[c][k] || 0) + take; remaining -= take }
        if (remaining <= 0) break
      }
    }
    // product names
    const maps = await fetchAllRows<{ master_sku: string; product_name: string | null }>((from, to) =>
      supabase.from('dispatch_sku_map').select('master_sku, product_name').range(from, to))
    const nm: Record<string, string> = {}
    for (const m of maps) if (m.product_name) nm[m.master_sku] = m.product_name

    const pkc: Record<string, number> = {}
    for (const r of pk) { const kk = (r.sku || '').trim(); if (kk) pkc[kk] = (pkc[kk] || 0) + 1 }
    setDemand(dem); setPickedToday(pkc); setPickedByCourier(pbc); setNames(nm); setLoading(false)
  }, [supabase])
  useEffect(() => { void loadPicklist() }, [loadPicklist])

  useEffect(() => {
    if (!cameraOn && courier) {
      const t = setInterval(() => { if (document.activeElement !== inputRef.current) inputRef.current?.focus() }, 800)
      return () => clearInterval(t)
    }
  }, [cameraOn, courier])

  function flash(type: ResultType, msg: string) {
    setLastResult({ type, msg })
    if (type === 'success') beepSuccess(); else if (type === 'warn') beepWarn(); else beepError()
  }

  const remainingFor = (c: Courier, sku: string) => (demand[c][sku] || 0) - (pickedByCourier[c][sku] || 0)
  const pendingCount = (c: Courier) => Object.keys(demand[c]).reduce((s, k) => s + Math.max(0, remainingFor(c, k)), 0)

  const commitPick = useCallback(async (c: Courier, unitId: string, barcode: string, sku: string | null, column_code: string | null) => {
    const now = new Date().toISOString()
    const { error } = await supabase.from('packed_units').update({ status: 'picked', picked_at: now, column_code: null, picked_courier: c }).eq('id', unitId).eq('status', 'stocked')
    if (error) { flash('error', 'Pick failed: ' + error.message); return }
    await supabase.from('stock_movements').insert({ barcode, column_code, direction: 'pick', sku, bypassed: false, by_email: userEmail || null })
    const k = (sku || '').trim()
    if (k) { setPickedByCourier(p => ({ ...p, [c]: { ...p[c], [k]: (p[c][k] || 0) + 1 } })); setPickedToday(p => ({ ...p, [k]: (p[k] || 0) + 1 })) }
    setPicked(prev => [{ barcode, unitId, sku, column_code }, ...prev])
    flash('success', `Picked ${barcode}${column_code ? ` · from ${column_code}` : ''}`)
  }, [supabase, userEmail])

  const processScan = useCallback(async (raw: string) => {
    const value = (raw || '').trim()
    if (!value || processingRef.current || !courier) return
    if (isColumnScan(value)) { flash('warn', 'Column scan noted — scan the pieces to pick'); return }
    processingRef.current = true
    try {
      const { data: unit, error } = await supabase.from('packed_units').select('id, status, sku, column_code').eq('barcode', value).maybeSingle()
      if (error) throw error
      if (!unit) { flash('error', `${value} not found — scan again`); return }
      if (unit.status === 'picked') { flash('warn', `${value} already picked`); return }
      if (unit.status === 'dispatched') { flash('error', `${value} already dispatched`); return }
      if (unit.status !== 'stocked') { flash('error', `${value} is ${unit.status} — only stocked pieces can be picked`); return }

      const sku = (unit.sku || '').trim()
      const other: Courier = courier === 'Delhivery' ? 'Bluedart' : 'Delhivery'
      if (remainingFor(courier, sku) > 0) {
        await commitPick(courier, unit.id, value, unit.sku, unit.column_code)
      } else if (remainingFor(other, sku) > 0) {
        // Belongs to the other courier — tell the picker to set it aside there.
        flash('warn', `This is for ${other} — keep it in the ${other} section, then scan again`)
      } else {
        flash('error', `${sku || 'This piece'} isn't needed today — scan again`)
      }
    } catch (e) {
      flash('error', 'Error: ' + (e as Error).message)
    } finally {
      processingRef.current = false
    }
  }, [courier, demand, pickedByCourier, supabase, commitPick])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); const v = e.currentTarget.value; e.currentTarget.value = ''; void processScan(v) }
  }

  async function undoPick(item: PickedItem) {
    const { error } = await supabase.from('packed_units').update({ status: 'stocked', picked_at: null, column_code: item.column_code, picked_courier: null }).eq('id', item.unitId).eq('status', 'picked')
    if (error) { flash('error', 'Undo failed: ' + error.message); return }
    const k = (item.sku || '').trim()
    if (k && courier) { setPickedByCourier(p => ({ ...p, [courier]: { ...p[courier], [k]: Math.max(0, (p[courier][k] || 0) - 1) } })); setPickedToday(p => ({ ...p, [k]: Math.max(0, (p[k] || 0) - 1) })) }
    setPicked(prev => prev.filter(s => s.unitId !== item.unitId))
    flash('warn', `Undone: ${item.barcode} back to stocked`)
  }

  const banner = lastResult?.type === 'success' ? { color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', border: '#bbf7d0' }
    : lastResult?.type === 'warn' ? { color: 'var(--today)', bg: 'var(--today-bg)', border: '#fed7aa' }
    : lastResult?.type === 'error' ? { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca' }
    : { color: 'var(--text3)', bg: 'var(--bg2)', border: 'var(--border)' }

  // ── Courier selection screen ──
  if (!courier) {
    const chip = (c: Courier, code: string, cbg: string, cfg: string) => (
      <button key={c} onClick={() => { setCourier(c); setLastResult(null) }} disabled={loading}
        style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16, borderRadius: 12, textAlign: 'left' as const, background: 'var(--surface)', border: '1px solid var(--border)', cursor: 'pointer', width: '100%' }}>
        <div style={{ width: 46, height: 46, borderRadius: 10, background: cbg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: cfg, fontSize: 15 }}>{code}</div>
        <div style={{ flex: 1 }}><div style={{ fontSize: 17, fontWeight: 600 }}>{c}</div><div style={{ fontSize: 13, color: 'var(--text3)' }}>{loading ? 'loading…' : `${pendingCount(c)} piece${pendingCount(c) === 1 ? '' : 's'} pending`}</div></div>
        <ChevronRight size={22} style={{ color: 'var(--text3)' }} />
      </button>
    )
    return (
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12, maxWidth: 420 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Choose the courier you&apos;re picking</div>
        {chip('Delhivery', 'DL', 'var(--accent-bg)', 'var(--accent)')}
        {chip('Bluedart', 'BD', 'var(--today-bg)', 'var(--today)')}
      </div>
    )
  }

  // ── Selected courier's picklist ──
  const skusFor = Object.keys(demand[courier])
  const rows = skusFor.map(sku => ({ sku, need: demand[courier][sku] || 0, got: pickedByCourier[courier][sku] || 0 }))
    .filter(r => r.need > 0)
  const pendingRows = rows.filter(r => r.got < r.need).sort((a, b) => (b.need - b.got) - (a.need - a.got))
  const doneRows = rows.filter(r => r.got >= r.need)
  const leftTotal = pendingRows.reduce((s, r) => s + (r.need - r.got), 0)
  const code = courier === 'Bluedart' ? 'BD' : 'DL'
  const codeBg = courier === 'Bluedart' ? 'var(--today-bg)' : 'var(--accent-bg)'
  const codeFg = courier === 'Bluedart' ? 'var(--today)' : 'var(--accent)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12, maxWidth: 460 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={() => { setCourier(null); setPicked([]); setLastResult(null) }} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '6px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}><ChevronLeft size={15} /> Courier</button>
        <span style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ fontSize: 11, fontWeight: 700, color: codeFg, background: codeBg, padding: '2px 7px', borderRadius: 5 }}>{code}</span> {courier} picklist</span>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{leftTotal} left</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', border: '1px solid var(--accent)', borderRadius: 10, padding: '12px 14px' }}>
        <input ref={inputRef} autoFocus onKeyDown={handleKeyDown} disabled={cameraOn} placeholder="Scan piece barcode"
          style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 17, fontFamily: 'var(--font-mono)', fontWeight: 700, outline: 'none', flex: 1, letterSpacing: '0.04em' }} />
      </div>

      <div style={{ borderRadius: 10, border: `1px solid ${banner.border}`, background: banner.bg, color: banner.color, padding: '13px 14px', textAlign: 'center' as const, fontWeight: 700, fontSize: 14 }}>
        {lastResult?.msg || `Scanning for ${courier}`}
      </div>

      <div>
        {!cameraOn ? (
          <button onClick={() => setCameraOn(true)} style={{ width: '100%', padding: 12, borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><Camera size={15} /> Use Camera Instead</button>
        ) : (
          <BarcodeScanner onScan={processScan} onClose={() => setCameraOn(false)} />
        )}
      </div>

      {loading ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading picklist…</div>
      ) : (
        <>
          {pendingRows.length === 0 && doneRows.length === 0 ? (
            <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Nothing to pick for {courier} today.</div>
          ) : (
            <>
              {pendingRows.length > 0 && <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 700 }}>Pending ({pendingRows.length})</div>}
              {pendingRows.map(r => (
                <div key={r.sku} style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 15 }}>{r.sku}</div>
                    {names[r.sku] && <div style={{ fontSize: 13, color: 'var(--text3)' }}>{names[r.sku]}</div>}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600 }}><span style={{ color: 'var(--dispatched)' }}>{r.got}</span><span style={{ color: 'var(--text3)' }}>/{r.need}</span></div>
                </div>
              ))}
              {doneRows.length > 0 && <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 700, marginTop: 6 }}>Done ({doneRows.length})</div>}
              {doneRows.map(r => (
                <div key={r.sku} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', opacity: 0.55 }}>
                  <div style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 14 }}>{r.sku}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--dispatched)' }}><CircleCheck size={16} /><span style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>{r.got}/{r.need}</span></div>
                </div>
              ))}
            </>
          )}

          {picked.length > 0 && (
            <div style={{ ...card, overflow: 'hidden' as const, marginTop: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>Picked this session ({picked.length})</div>
              {picked.slice(0, 8).map(s => (
                <div key={s.unitId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text2)' }}>{s.barcode}</span>
                  <button onClick={() => undoPick(s)} style={{ fontSize: 11, fontWeight: 700, color: 'var(--critical)', border: '1px solid #fecaca', borderRadius: 6, padding: '3px 8px', background: 'var(--surface)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Undo2 size={11} /> Undo</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
