'use client'
import { useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { CheckCircle, Wrench, Trash2, Camera, X, ScanLine, AlertTriangle, Package } from 'lucide-react'

interface Piece {
  id: string
  order_id: string
  reason: string | null
  barcode: string | null
  reverse_tracking_id: string | null
  warehouse_received: boolean
  treatment_state: string | null
  sku: string | null
  customer: string | null
}

const DISPOSITIONS: { key: string; label: string; route: 'raw' | 'coated' | 'out'; state: string; icon: React.ReactNode; color: string }[] = [
  { key: 'frame',    label: 'Frame damaged',  route: 'raw',    state: 'routed_raw',    icon: <Wrench size={13} />,     color: 'var(--critical)' },
  { key: 'cloth',    label: 'Cloth torn',     route: 'coated', state: 'routed_coated', icon: <Wrench size={13} />,     color: 'var(--today)' },
  { key: 'foam',     label: 'Foam pressed',   route: 'coated', state: 'routed_coated', icon: <Wrench size={13} />,     color: 'var(--today)' },
  { key: 'sellable', label: 'Sellable as-is', route: 'coated', state: 'routed_coated', icon: <CheckCircle size={13} />, color: 'var(--dispatched)' },
  { key: 'scrap',    label: 'Scrap',          route: 'out',    state: 'scrapped',      icon: <Trash2 size={13} />,     color: 'var(--text3)' },
]

const REQUIRED_PHOTOS = 2
const MAX_PHOTOS = 4

export default function RtoTreatmentTab() {
  const supabase = useMemo(() => createClient(), [])
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [piece, setPiece] = useState<Piece | null>(null)
  const [notAck, setNotAck] = useState<string | null>(null)   // message when found-but-not-received
  const [photos, setPhotos] = useState<(File | null)[]>([null, null, null, null])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const reset = () => { setPiece(null); setNotAck(null); setPhotos([null, null, null, null]) }

  // Resolve any of 4 identifiers → a received return.
  const search = async () => {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true); setMsg(null); setNotAck(null); setPiece(null)
    try {
      // 1) reverse AWB, 2) order_id, 3) barcode — all on returns
      let { data: rows } = await supabase.from('returns')
        .select('id, order_id, reason, barcode, reverse_tracking_id, warehouse_received, treatment_state')
        .or(`reverse_tracking_id.eq.${q},order_id.eq.${q},barcode.eq.${q}`)
        .limit(5)
      let ret = (rows || [])[0] as (Piece | undefined)

      // 4) forward AWB → dispatch_orders.tracking_number → order_id → return
      if (!ret) {
        const { data: ord } = await supabase.from('dispatch_orders')
          .select('order_id').eq('tracking_number', q).limit(1).maybeSingle()
        if (ord?.order_id) {
          const { data: r2 } = await supabase.from('returns')
            .select('id, order_id, reason, barcode, reverse_tracking_id, warehouse_received, treatment_state')
            .eq('order_id', ord.order_id).limit(1).maybeSingle()
          ret = (r2 as Piece | null) ?? undefined
        }
      }

      if (!ret) { setMsg({ ok: false, text: `No return found for "${q}"` }); return }

      // enrich with order details
      const { data: ord2 } = await supabase.from('dispatch_orders')
        .select('sku, customer_name').eq('order_id', ret.order_id).maybeSingle()
      const enriched: Piece = { ...ret, sku: ord2?.sku ?? null, customer: ord2?.customer_name ?? null }

      // acknowledged gate
      if (!ret.warehouse_received) {
        setNotAck(ret.order_id)
        return
      }
      setPiece(enriched)
    } catch (e) {
      setMsg({ ok: false, text: 'Error: ' + (e as Error).message })
    } finally {
      setSearching(false)
    }
  }

  const setPhoto = (i: number, f: File | null) => setPhotos(prev => prev.map((p, idx) => idx === i ? f : p))
  const photoCount = photos.filter(Boolean).length
  const haveRequired = photos[0] && photos[1]

  const commit = async (d: typeof DISPOSITIONS[number]) => {
    if (!piece || busy) return
    if (!haveRequired) { setMsg({ ok: false, text: `Attach the ${REQUIRED_PHOTOS} required photos first` }); return }
    setBusy(true); setMsg(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()

      // upload photos first — if any fails, abort before changing state
      for (let i = 0; i < MAX_PHOTOS; i++) {
        const f = photos[i]; if (!f) continue
        const path = `${piece.order_id}/${piece.id}/${i + 1}-${Date.now()}.jpg`
        const { error: upErr } = await supabase.storage.from('rto-inspection').upload(path, f, { upsert: true })
        if (upErr) throw upErr
        await supabase.from('rto_inspection_photos').insert({ return_id: piece.id, path, slot: i + 1, uploaded_by: user?.email ?? null })
      }

      // existing disposition logic (unchanged)
      if (d.key === 'scrap') {
        await supabase.from('returns').update({
          treatment_state: 'scrapped', damage_type: 'scrap', inspected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', piece.id)
        setMsg({ ok: true, text: `Scrapped · order ${piece.order_id}` })
      } else {
        const { data: barcode, error } = await supabase.rpc('reserve_piece_barcode', {
          p_return_id: piece.id, p_order_id: piece.order_id, p_damage: d.key, p_route: d.route, p_user: user?.id ?? null,
        })
        if (error) throw error
        await supabase.from('returns').update({
          treatment_state: d.state, damage_type: d.key, reserved_barcode: barcode as string,
          inspected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq('id', piece.id)
        setMsg({ ok: true, text: `Reserved ${barcode} · ${d.label} → ${d.route} stock` })
      }
      reset(); setQuery('')
    } catch (e) {
      setMsg({ ok: false, text: 'Error: ' + (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const photoSlot = (i: number) => {
    const f = photos[i]; const required = i < REQUIRED_PHOTOS
    const bd = f ? 'var(--dispatched)' : required ? 'var(--critical)' : 'var(--border)'
    const fg = f ? 'var(--dispatched)' : required ? 'var(--critical)' : 'var(--text3)'
    return (
      <label key={i} style={{ position: 'relative' as const, aspectRatio: '4/3', border: `1.5px dashed ${bd}`, borderRadius: 8, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', gap: 3, cursor: 'pointer', background: f ? 'var(--dispatched-bg)' : 'var(--surface)', color: fg, overflow: 'hidden' as const }}>
        {f ? (<>
          <CheckCircle size={20} /><span style={{ fontSize: 10.5, fontWeight: 600 }}>Photo {i + 1} ✓</span>
          <button onClick={e => { e.preventDefault(); setPhoto(i, null) }} style={{ position: 'absolute' as const, top: 4, right: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text2)' }}><X size={11} /></button>
        </>) : (<>
          <Camera size={20} /><span style={{ fontSize: 10.5, fontWeight: 600 }}>{required ? 'Required' : 'Optional'}</span>
        </>)}
        <input type="file" accept="image/*" capture="environment" onChange={e => setPhoto(i, e.target.files?.[0] || null)} style={{ display: 'none' }} />
      </label>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14, maxWidth: 560 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}><Package size={17} /> RTO Treatment — inspect</h1>

      {/* scan / search */}
      <div>
        <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', marginBottom: 6 }}>Open a piece to inspect</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search() }} autoFocus
            placeholder="Scan / type: forward AWB, reverse AWB, barcode, order ID"
            style={{ flex: 1, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font-mono)', outline: 'none' }} />
          <button onClick={() => void search()} disabled={searching || !query.trim()} style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--text2)', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600 }}><ScanLine size={15} /> {searching ? '…' : 'Open'}</button>
        </div>
      </div>

      {msg && <div style={{ fontSize: 12.5, fontWeight: 600, color: msg.ok ? 'var(--dispatched)' : 'var(--critical)', background: msg.ok ? 'var(--dispatched-bg)' : 'var(--critical-bg)', border: `1px solid ${msg.ok ? 'var(--dispatched)' : '#fecaca'}`, borderRadius: 8, padding: '8px 12px' }}>{msg.text}</div>}

      {/* not acknowledged */}
      {notAck && (
        <div style={{ background: 'var(--surface)', border: '1px solid #fecaca', borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <AlertTriangle size={18} style={{ color: 'var(--critical)' }} />
          <div><div style={{ fontSize: 12.5, fontWeight: 600 }}>Not acknowledged</div><div style={{ fontSize: 11.5, color: 'var(--text2)' }}>Order {notAck} isn’t received at RTO intake yet — receive it there first.</div></div>
        </div>
      )}

      {/* inspection card */}
      {piece && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600 }}>{piece.order_id}</span>
            <span style={{ fontSize: 11, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '2px 9px', borderRadius: 20, whiteSpace: 'nowrap' as const }}><CheckCircle size={11} style={{ verticalAlign: -1 }} /> RTO acknowledged</span>
          </div>
          <table style={{ width: '100%', fontSize: 12.5 }}>
            <tbody>
              <tr><td style={{ color: 'var(--text2)', padding: '2px 0', width: 90 }}>SKU</td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{piece.sku || '—'}</td></tr>
              <tr><td style={{ color: 'var(--text2)', padding: '2px 0' }}>Customer</td><td>{piece.customer || '—'}</td></tr>
              <tr><td style={{ color: 'var(--text2)', padding: '2px 0' }}>Reverse AWB</td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{piece.reverse_tracking_id || '—'}</td></tr>
              <tr><td style={{ color: 'var(--text2)', padding: '2px 0' }}>Barcode</td><td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{piece.barcode || '—'}</td></tr>
            </tbody>
          </table>

          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', margin: '14px 0 8px' }}>Photos · {REQUIRED_PHOTOS} required, {MAX_PHOTOS - REQUIRED_PHOTOS} optional <span style={{ color: haveRequired ? 'var(--dispatched)' : 'var(--critical)' }}>({photoCount}/{MAX_PHOTOS})</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>{[0, 1, 2, 3].map(photoSlot)}</div>

          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', margin: '14px 0 8px' }}>Disposition</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
            {DISPOSITIONS.map(d => (
              <button key={d.key} onClick={() => void commit(d)} disabled={busy || !haveRequired}
                style={{ padding: '9px 10px', borderRadius: 7, border: `1px solid ${haveRequired ? d.color : 'var(--border)'}`, background: 'var(--surface)', color: haveRequired ? d.color : 'var(--text3)', cursor: (busy || !haveRequired) ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-start', gridColumn: d.key === 'scrap' ? '1 / -1' : 'auto' }}>
                {d.icon} {d.label}
              </button>
            ))}
          </div>
          {!haveRequired && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 5 }}><AlertTriangle size={13} /> Attach the {REQUIRED_PHOTOS} required photos before choosing a disposition.</div>}
          {busy && <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>Saving…</div>}
        </div>
      )}
    </div>
  )
}
