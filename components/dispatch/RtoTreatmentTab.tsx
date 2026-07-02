'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { RotateCcw, RefreshCw, CheckCircle, Wrench, Trash2, Package, ArrowRight, Tag } from 'lucide-react'

// A received return awaiting / undergoing treatment.
interface TreatmentRow {
  id: string
  order_id: string
  reason: string | null
  barcode: string | null
  warehouse_received: boolean
  warehouse_received_at: string | null
  treatment_state: string | null
  damage_type: string | null
  reserved_barcode: string | null
  created_at: string
}

// Disposition → route. Frame damage re-enters at RAW (needs recoating);
// cloth/foam/sellable re-enter at COATED (frame coating is intact).
const DISPOSITIONS: { key: string; label: string; route: 'raw' | 'coated' | 'out'; state: string; icon: React.ReactNode; color: string }[] = [
  { key: 'frame',    label: 'Frame damaged',   route: 'raw',    state: 'routed_raw',    icon: <Wrench size={13} />,   color: 'var(--critical)' },
  { key: 'cloth',    label: 'Cloth torn',      route: 'coated', state: 'routed_coated', icon: <Wrench size={13} />,   color: 'var(--today)' },
  { key: 'foam',     label: 'Foam pressed',    route: 'coated', state: 'routed_coated', icon: <Wrench size={13} />,   color: 'var(--today)' },
  { key: 'sellable', label: 'Sellable as-is',  route: 'coated', state: 'routed_coated', icon: <CheckCircle size={13} />, color: 'var(--dispatched)' },
  { key: 'scrap',    label: 'Scrap',           route: 'out',    state: 'scrapped',      icon: <Trash2 size={13} />,   color: 'var(--text3)' },
]

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }

// Journey steps shown as a small progress trail per return.
const JOURNEY: { state: string; label: string }[] = [
  { state: 'received',         label: 'Received' },
  { state: 'routed',           label: 'Routed' },
  { state: 'barcode_assigned', label: 'Barcode assigned' },
  { state: 're_packed',        label: 'Re-packed' },
  { state: 'back_in_stock',    label: 'Back in stock' },
]

function stateRank(s: string | null): number {
  if (!s) return 0
  if (s === 'received') return 0
  if (s === 'routed_raw' || s === 'routed_coated') return 1
  if (s === 'barcode_assigned') return 2
  if (s === 're_packed') return 3
  if (s === 'back_in_stock') return 4
  if (s === 'scrapped') return 99
  return 0
}

export default function RtoTreatmentTab() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<TreatmentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [filter, setFilter] = useState<'pending' | 'in_repair' | 'done' | 'all'>('pending')

  const load = useCallback(async () => {
    setLoading(true)
    // Received returns that aren't scrapped or fully back in stock.
    const { data } = await supabase.from('returns')
      .select('id, order_id, reason, barcode, warehouse_received, warehouse_received_at, treatment_state, damage_type, reserved_barcode, created_at')
      .eq('warehouse_received', true)
      .order('warehouse_received_at', { ascending: false })
    setRows((data as TreatmentRow[]) || [])
    setLoading(false)
  }, [supabase])

  useEffect(() => { void load() }, [load])

  // Inspector picks a disposition → reserve a barcode (except scrap) + set route/state.
  const disposition = async (row: TreatmentRow, d: typeof DISPOSITIONS[number]) => {
    if (busyId) return
    setBusyId(row.id); setMsg(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (d.key === 'scrap') {
        await supabase.from('returns').update({
          treatment_state: 'scrapped', damage_type: 'scrap', updated_at: new Date().toISOString(),
        }).eq('id', row.id)
        setMsg(`Scrapped · order ${row.order_id}`)
      } else {
        // Reserve the next coating serial for this return's refurbished frame.
        const { data: barcode, error } = await supabase.rpc('reserve_piece_barcode', {
          p_return_id: row.id,
          p_order_id: row.order_id,
          p_damage: d.key,
          p_route: d.route,
          p_user: user?.id ?? null,
        })
        if (error) throw error
        await supabase.from('returns').update({
          treatment_state: d.state,
          damage_type: d.key,
          reserved_barcode: barcode as string,
          updated_at: new Date().toISOString(),
        }).eq('id', row.id)
        setMsg(`Reserved ${barcode} · ${d.label} → ${d.route} stock`)
      }
      await load()
    } catch (e) {
      setMsg('Error: ' + (e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  // Advance the journey: barcode assigned → re-packed → back in stock.
  const advance = async (row: TreatmentRow, toState: string) => {
    if (busyId) return
    setBusyId(row.id); setMsg(null)
    try {
      await supabase.from('returns').update({ treatment_state: toState, updated_at: new Date().toISOString() }).eq('id', row.id)
      // When the reserved barcode is physically assigned, mark the reservation assigned too.
      if (toState === 'barcode_assigned' && row.reserved_barcode) {
        await supabase.from('returns_reservations')
          .update({ status: 'assigned', assigned_barcode: row.reserved_barcode, updated_at: new Date().toISOString() })
          .eq('return_id', row.id).eq('status', 'reserved')
      }
      if (toState === 're_packed' && row.reserved_barcode) {
        await supabase.from('returns_reservations')
          .update({ status: 'repacked', updated_at: new Date().toISOString() })
          .eq('return_id', row.id)
      }
      await load()
    } catch (e) {
      setMsg('Error: ' + (e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const filtered = useMemo(() => {
    return rows.filter(r => {
      const rank = stateRank(r.treatment_state)
      if (filter === 'all') return true
      if (filter === 'pending') return !r.treatment_state || r.treatment_state === 'received'
      if (filter === 'in_repair') return rank >= 1 && rank < 4 && r.treatment_state !== 'scrapped'
      if (filter === 'done') return rank >= 4 || r.treatment_state === 'scrapped'
      return true
    })
  }, [rows, filter])

  const counts = useMemo(() => ({
    pending: rows.filter(r => !r.treatment_state || r.treatment_state === 'received').length,
    in_repair: rows.filter(r => { const k = stateRank(r.treatment_state); return k >= 1 && k < 4 && r.treatment_state !== 'scrapped' }).length,
    done: rows.filter(r => stateRank(r.treatment_state) >= 4 || r.treatment_state === 'scrapped').length,
  }), [rows])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <RotateCcw size={18} /> RTO Treatment
        </h1>
        <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{rows.length} received</span>
        <button onClick={load} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', cursor: 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <RefreshCw size={12} /> Refresh
        </button>
        {msg && <span style={{ fontSize: 12, color: 'var(--text2)' }}>{msg}</span>}
      </div>

      <div style={{ background: 'var(--today-bg)', border: '1px solid #fed7aa', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text2)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <Package size={14} style={{ marginTop: 1, flexShrink: 0, color: 'var(--today)' }} />
        <span>Every received return is opened and inspected. Marking a disposition reserves the next coating barcode for the refurbished frame — coating generation skips reserved numbers automatically. The reserved barcode is assigned to the frame after it re-enters (raw → recoat, or coated → repack).</span>
      </div>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {([
          { key: 'pending',   label: `Pending inspection (${counts.pending})` },
          { key: 'in_repair', label: `In repair (${counts.in_repair})` },
          { key: 'done',      label: `Done (${counts.done})` },
          { key: 'all',       label: 'All' },
        ] as const).map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            style={{ padding: '5px 12px', borderRadius: 6, border: `1px solid ${filter === f.key ? 'var(--accent)' : 'var(--border)'}`, background: filter === f.key ? 'var(--accent)' : 'var(--surface)', color: filter === f.key ? '#fff' : 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: 'var(--text3)' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: 'var(--text3)' }}>Nothing here.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(r => {
            const pending = !r.treatment_state || r.treatment_state === 'received'
            const scrapped = r.treatment_state === 'scrapped'
            const rank = stateRank(r.treatment_state)
            return (
              <div key={r.id} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)', fontWeight: 600 }}>{r.order_id}</span>
                  {r.barcode && <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>orig {r.barcode}</span>}
                  {r.reason && <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {r.reason}</span>}
                  {r.reserved_barcode && (
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'DM Mono', fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', border: '1px solid var(--accent)', padding: '2px 8px', borderRadius: 5 }}>
                      <Tag size={11} /> {r.reserved_barcode}
                    </span>
                  )}
                </div>

                {/* Journey trail */}
                {!pending && !scrapped && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                    {JOURNEY.map((j, i) => {
                      const active = i <= rank
                      return (
                        <span key={j.state} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 10, fontWeight: 600, color: active ? 'var(--dispatched)' : 'var(--text3)' }}>{j.label}</span>
                          {i < JOURNEY.length - 1 && <ArrowRight size={10} style={{ color: 'var(--text3)' }} />}
                        </span>
                      )
                    })}
                  </div>
                )}
                {scrapped && <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>Scrapped — lifecycle closed.</span>}

                {/* Actions */}
                {pending ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {DISPOSITIONS.map(d => (
                      <button key={d.key} disabled={busyId === r.id} onClick={() => disposition(r, d)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 6, border: `1px solid ${d.color}`, background: 'var(--surface)', color: d.color, fontSize: 12, fontWeight: 600, cursor: busyId ? 'default' : 'pointer' }}>
                        {d.icon} {d.label}
                      </button>
                    ))}
                  </div>
                ) : !scrapped && rank < 4 ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {rank < 2 && (
                      <button disabled={busyId === r.id} onClick={() => advance(r, 'barcode_assigned')}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--surface)', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                        <Tag size={12} /> Mark barcode assigned
                      </button>
                    )}
                    {rank === 2 && (
                      <button disabled={busyId === r.id} onClick={() => advance(r, 're_packed')}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--today)', background: 'var(--surface)', color: 'var(--today)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                        <Package size={12} /> Mark re-packed
                      </button>
                    )}
                    {rank === 3 && (
                      <button disabled={busyId === r.id} onClick={() => advance(r, 'back_in_stock')}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--dispatched)', background: 'var(--surface)', color: 'var(--dispatched)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                        <CheckCircle size={12} /> Mark back in stock
                      </button>
                    )}
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--dispatched)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <CheckCircle size={13} /> Back in stock
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
