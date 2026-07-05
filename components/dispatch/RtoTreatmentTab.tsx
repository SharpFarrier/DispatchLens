'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { RotateCcw, RefreshCw, CheckCircle, Wrench, Trash2, Package } from 'lucide-react'

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
  created_at: string
}

// Disposition → where the physical frame re-enters the normal pipeline.
// Frame damage re-enters at RAW (needs fabrication + recoating — picks up a new
// coating barcode there, like any frame). Cloth/foam re-enter at TOUCH-UP (frame
// coating is intact). Sellable re-joins directly. No barcode is reserved here —
// a refurbished frame gets its barcode at coating, exactly like a normal frame.
const DISPOSITIONS: { key: string; label: string; route: 'raw' | 'touchup' | 'out'; state: string; icon: React.ReactNode; color: string; hint: string }[] = [
  { key: 'frame',    label: 'Frame damage',    route: 'raw',     state: 'routed_raw',     icon: <Wrench size={13} />,     color: 'var(--critical)',   hint: '→ fabrication → recoat' },
  { key: 'cloth',    label: 'Cloth damage',    route: 'touchup', state: 'routed_touchup', icon: <Wrench size={13} />,     color: 'var(--today)',      hint: '→ touch-up' },
  { key: 'foam',     label: 'Foam damage',     route: 'touchup', state: 'routed_touchup', icon: <Wrench size={13} />,     color: 'var(--today)',      hint: '→ touch-up' },
  { key: 'sellable', label: 'Sellable as-is',  route: 'touchup', state: 'routed_touchup', icon: <CheckCircle size={13} />, color: 'var(--dispatched)', hint: '→ back to stock' },
  { key: 'scrap',    label: 'Scrap',           route: 'out',     state: 'scrapped',       icon: <Trash2 size={13} />,     color: 'var(--text3)',      hint: 'lifecycle closed' },
]

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }

function isRouted(s: string | null): boolean {
  return s === 'routed_raw' || s === 'routed_touchup'
}

export default function RtoTreatmentTab() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<TreatmentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [filter, setFilter] = useState<'pending' | 'routed' | 'scrapped' | 'all'>('pending')

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('returns')
      .select('id, order_id, reason, barcode, warehouse_received, warehouse_received_at, treatment_state, damage_type, created_at')
      .eq('warehouse_received', true)
      .order('warehouse_received_at', { ascending: false })
    setRows((data as TreatmentRow[]) || [])
    setLoading(false)
  }, [supabase])

  useEffect(() => { void load() }, [load])

  // Inspector records the damage type and routes the physical item. No barcode is
  // reserved — the refurbished frame gets a barcode naturally at coating.
  const disposition = async (row: TreatmentRow, d: typeof DISPOSITIONS[number]) => {
    if (busyId) return
    setBusyId(row.id); setMsg(null)
    try {
      await supabase.from('returns').update({
        treatment_state: d.state,
        damage_type: d.key,
        updated_at: new Date().toISOString(),
      }).eq('id', row.id)
      setMsg(d.key === 'scrap' ? `Scrapped · order ${row.order_id}` : `${d.label} · routed ${d.route === 'raw' ? 'to raw (recoat)' : 'to touch-up'}`)
      await load()
    } catch (e) {
      setMsg('Error: ' + (e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (filter === 'all') return true
      if (filter === 'pending') return !r.treatment_state || r.treatment_state === 'received'
      if (filter === 'routed') return isRouted(r.treatment_state)
      if (filter === 'scrapped') return r.treatment_state === 'scrapped'
      return true
    })
  }, [rows, filter])

  const counts = useMemo(() => ({
    pending: rows.filter(r => !r.treatment_state || r.treatment_state === 'received').length,
    routed: rows.filter(r => isRouted(r.treatment_state)).length,
    scrapped: rows.filter(r => r.treatment_state === 'scrapped').length,
  }), [rows])

  const dispoMeta = (key: string | null) => DISPOSITIONS.find(d => d.key === key)

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
        <span>Open and inspect each received return, then mark the damage type. Frame damage routes to raw stock (fabrication → recoat), where it picks up a new barcode at coating like any frame. Cloth/foam route to touch-up. From there the frame is back in the normal pipeline.</span>
      </div>

      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {([
          { key: 'pending',  label: `Pending inspection (${counts.pending})` },
          { key: 'routed',   label: `Routed (${counts.routed})` },
          { key: 'scrapped', label: `Scrapped (${counts.scrapped})` },
          { key: 'all',      label: 'All' },
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
            const routed = isRouted(r.treatment_state)
            const meta = dispoMeta(r.damage_type)
            return (
              <div key={r.id} style={{ ...card, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)', fontWeight: 600 }}>{r.order_id}</span>
                  {r.barcode && <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>orig {r.barcode}</span>}
                  {r.reason && <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {r.reason}</span>}
                  {routed && meta && (
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: meta.color, background: 'var(--bg2)', border: `1px solid ${meta.color}`, padding: '2px 8px', borderRadius: 5 }}>
                      {meta.icon} {meta.label} {meta.hint}
                    </span>
                  )}
                </div>

                {scrapped && <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>Scrapped — lifecycle closed.</span>}

                {/* Actions: only pending returns need a disposition. Once routed, the
                    frame is back in the normal pipeline — nothing more to do here. */}
                {pending ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {DISPOSITIONS.map(d => (
                      <button key={d.key} disabled={busyId === r.id} onClick={() => disposition(r, d)}
                        title={d.hint}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 6, border: `1px solid ${d.color}`, background: 'var(--surface)', color: d.color, fontSize: 12, fontWeight: 600, cursor: busyId ? 'default' : 'pointer' }}>
                        {d.icon} {d.label}
                      </button>
                    ))}
                  </div>
                ) : routed ? (
                  <span style={{ fontSize: 12, color: 'var(--text2)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <CheckCircle size={13} style={{ color: 'var(--dispatched)' }} /> Routed {meta?.route === 'raw' ? 'to raw stock (will recoat)' : 'to touch-up'} — back in the normal pipeline.
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
