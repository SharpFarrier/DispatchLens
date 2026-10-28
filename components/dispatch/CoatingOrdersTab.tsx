'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import DrumDatePicker from './DrumDatePicker'
import FramePicker, { type FrameItem } from './FramePicker'
import LineItemList, { getItemErrors } from './LineItemList'
import { ClipboardList, Check, X } from 'lucide-react'

// Coating Orders — a trolley is ordered (date + trolley no + what to coat), then the
// Coating tab generates barcodes against it. Balance = ordered − coated per line,
// matched by shape·size·mattress·colour. Multiple orders may share a date + trolley.

interface OrderItem { id: string; category: string | null; shape: string | null; size: string | null; mattress: string | null; colour: string | null; qty_ordered: number }
interface Order { id: string; order_date: string; trolley_no: string; status: string; notes: string | null; created_at: string; coating_order_items: OrderItem[] }

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }
const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }
const inputField = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' as const }

const IST = 'Asia/Kolkata'
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const fmtDate = (s: string) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const norm = (s: string | null) => (s || '').trim().toUpperCase()
const keyOf = (shape: string | null, size: string | null, mattress: string | null, colour: string | null) => [norm(shape), norm(size), norm(mattress), norm(colour)].join('|')
const label = (shape: string | null, size: string | null, mattress: string | null, colour: string | null) =>
  [shape, size, mattress].filter(Boolean).join(' · ') + (colour ? ` · ${colour}` : '')

export default function CoatingOrdersTab({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), [])
  // Order form
  const [date, setDate] = useState(istToday())
  const [trolleyNo, setTrolleyNo] = useState('')
  const [lineItems, setLineItems] = useState<FrameItem[]>([])
  const [invalidIndices, setInvalidIndices] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  // Board
  const [orders, setOrders] = useState<Order[]>([])
  const [coated, setCoated] = useState<Record<string, Record<string, number>>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const flash = (msg: string, type: 'success' | 'error' = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500) }

  const load = useCallback(async () => {
    setLoading(true)
    const { data: ords } = await supabase.from('coating_orders')
      .select('*, coating_order_items(*)').neq('status', 'closed')
      .order('order_date', { ascending: false }).order('created_at', { ascending: false })
    const list = ((ords as Order[]) || [])
    const orderIds = list.map(o => o.id)
    const coatedMap: Record<string, Record<string, number>> = {}
    if (orderIds.length) {
      const { data: trs } = await supabase.from('coating_trolleys').select('id, coating_order_id').in('coating_order_id', orderIds).neq('status', 'deleted')
      const trolleyOrder = new Map<string, string>()
      for (const t of ((trs as { id: string; coating_order_id: string }[]) || [])) trolleyOrder.set(t.id, t.coating_order_id)
      const trolleyIds = [...trolleyOrder.keys()]
      const items: { trolley_id: string; shape: string | null; size: string | null; mattress: string | null; colour: string | null; pieces: number }[] = []
      for (let i = 0; i < trolleyIds.length; i += 200) {
        const { data } = await supabase.from('coating_items').select('trolley_id, shape, size, mattress, colour, pieces').in('trolley_id', trolleyIds.slice(i, i + 200))
        if (data) items.push(...(data as typeof items))
      }
      for (const it of items) {
        const oid = trolleyOrder.get(it.trolley_id); if (!oid) continue
        const k = keyOf(it.shape, it.size, it.mattress, it.colour)
        ;(coatedMap[oid] ??= {})[k] = (coatedMap[oid][k] || 0) + (Number(it.pieces) || 0)
      }
    }
    setOrders(list); setCoated(coatedMap); setLoading(false)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  const saveOrder = async () => {
    if (!trolleyNo.trim()) { flash('Enter a trolley number', 'error'); return }
    if (!lineItems.length) { flash('Add at least one frame', 'error'); return }
    const invalid = lineItems.map((it, i) => getItemErrors(it, { requireColour: true }).length > 0 ? i : -1).filter(i => i >= 0)
    if (invalid.length) { setInvalidIndices(invalid); flash('Some frames are missing required fields', 'error'); return }
    setInvalidIndices([]); setSaving(true)
    try {
      const { data: ord, error } = await supabase.from('coating_orders')
        .insert({ order_date: date, trolley_no: trolleyNo.trim(), created_by: userId }).select().single()
      if (error) throw error
      const { error: iErr } = await supabase.from('coating_order_items').insert(
        lineItems.map(l => ({ order_id: ord.id, category: l.category, shape: l.shape, size: l.size || null, mattress: l.mattress || null, colour: l.colour, qty_ordered: Number(l.pieces) || 0 }))
      )
      if (iErr) throw iErr
      const total = lineItems.reduce((s, l) => s + (Number(l.pieces) || 0), 0)
      flash(`Order saved — Trolley ${trolleyNo.trim()} · ${total} pcs`)
      setTrolleyNo(''); setLineItems([])
      void load()
    } catch (e) { flash('Save failed: ' + (e as Error).message, 'error') }
    setSaving(false)
  }

  const closeOrder = async (id: string) => {
    setBusy(id)
    const { error } = await supabase.from('coating_orders').update({ status: 'closed' }).eq('id', id)
    if (error) { flash('Close failed: ' + error.message, 'error'); setBusy(null); return }
    setOrders(prev => prev.filter(o => o.id !== id))
    flash('Order closed')
    setBusy(null)
  }

  // Per-order balance rows (ordered lines + any extra coated-but-not-ordered items).
  const boardFor = (o: Order) => {
    const coatedByKey = coated[o.id] || {}
    const used = new Set<string>()
    const rows = (o.coating_order_items || []).map(it => {
      const k = keyOf(it.shape, it.size, it.mattress, it.colour); used.add(k)
      const c = coatedByKey[k] || 0
      return { label: label(it.shape, it.size, it.mattress, it.colour), ordered: it.qty_ordered, coated: c, remaining: it.qty_ordered - c, extra: false }
    })
    for (const [k, c] of Object.entries(coatedByKey)) {
      if (used.has(k) || !c) continue
      const [sh, sz, ma, co] = k.split('|')
      rows.push({ label: label(sh, sz, ma, co) + ' · not ordered', ordered: 0, coated: c, remaining: -c, extra: true })
    }
    const pending = rows.reduce((s, r) => s + Math.max(0, r.ordered - r.coated), 0)
    const over = rows.reduce((s, r) => s + Math.max(0, r.coated - r.ordered), 0)
    const totalOrdered = rows.reduce((s, r) => s + r.ordered, 0)
    const towardOrder = rows.reduce((s, r) => s + Math.min(r.ordered, r.coated), 0)
    const pct = totalOrdered ? Math.min(100, Math.round((towardOrder / totalOrdered) * 100)) : (over ? 100 : 0)
    const status = pending > 0 ? 'pending' : over > 0 ? 'over' : 'done'
    return { rows, pending, over, totalOrdered, pct, status }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 18 }}>
      {toast && (
        <div style={{ position: 'fixed' as const, bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, padding: '10px 20px', borderRadius: 20, fontSize: 13, fontWeight: 700, boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          background: toast.type === 'error' ? 'var(--critical-bg)' : 'var(--dispatched-bg)', color: toast.type === 'error' ? 'var(--critical)' : 'var(--dispatched)', border: '1px solid var(--border)' }}>{toast.msg}</div>
      )}

      <div>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>Coating Orders</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: '4px 0 0' }}>Order trolleys to be coated, then generate barcodes against them on the Coating tab. Balance = ordered − coated per line (matched by shape · size · mattress · colour).</p>
      </div>

      {/* New order */}
      <div style={{ ...card }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}><ClipboardList size={15} /> New coating order</div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' as const, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Date</span><DrumDatePicker value={date} onChange={setDate} placeholder="Date" /></div>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Trolley number</span><input value={trolleyNo} onChange={e => setTrolleyNo(e.target.value)} placeholder="e.g. T-7" style={{ ...inputField, width: 140 }} /></div>
          </div>
          <div>
            <div style={sectionTitle}>Frames to coat</div>
            <LineItemList items={lineItems} onRemove={i => { setLineItems(p => p.filter((_, idx) => idx !== i)); setInvalidIndices([]) }} invalidIndices={invalidIndices} />
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: 12, border: '1px solid var(--border)', padding: 14 }}>
            <div style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13, marginBottom: 12 }}>+ Add frame</div>
            <FramePicker mode="coating" showColour onAdd={item => setLineItems(p => [...p, item])} />
          </div>
          <button onClick={saveOrder} disabled={saving || !lineItems.length || !trolleyNo.trim()}
            style={{ alignSelf: 'flex-start', padding: '10px 18px', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 14, borderRadius: 10, border: 'none', cursor: 'pointer', opacity: (saving || !lineItems.length || !trolleyNo.trim()) ? 0.4 : 1 }}>
            {saving ? 'Saving…' : `Save order${lineItems.length ? ` · ${lineItems.reduce((s, l) => s + (Number(l.pieces) || 0), 0)} pcs` : ''}`}
          </button>
        </div>
      </div>

      {/* Balance board */}
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.05em', color: 'var(--text3)' }}>Open trolley orders</div>
      {loading ? (
        <div style={{ ...card, padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading…</div>
      ) : !orders.length ? (
        <div style={{ ...card, padding: 40, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No open coating orders. Create one above.</div>
      ) : orders.map(o => {
        const b = boardFor(o)
        const chip = b.status === 'pending'
          ? { text: `${b.pending} of ${b.totalOrdered} pending`, c: 'var(--today)', bg: 'var(--today-bg)' }
          : b.status === 'over' ? { text: 'Over-coated', c: 'var(--critical)', bg: 'var(--critical-bg)' }
          : { text: 'Fulfilled', c: 'var(--dispatched)', bg: 'var(--dispatched-bg)' }
        return (
          <div key={o.id} style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' as const }}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>Trolley {o.trolley_no}</span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{fmtDate(o.order_date)}</span>
              <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase' as const, letterSpacing: '.05em', padding: '3px 9px', borderRadius: 20, color: chip.c, background: chip.bg }}>{chip.text}</span>
              <div style={{ flex: 1, minWidth: 100, height: 7, borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${b.pct}%`, background: 'var(--accent)' }} /></div>
              <button onClick={() => closeOrder(o.id)} disabled={busy === o.id} title="Close this order (hide from the board)"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}><Check size={12} /> Close</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12.5 }}>
              <thead><tr>
                <th style={{ padding: '8px 16px', textAlign: 'left' as const, fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '.04em', color: 'var(--text3)', background: 'var(--bg2)' }}>Item</th>
                <th style={{ padding: '8px 16px', textAlign: 'right' as const, fontSize: 10, textTransform: 'uppercase' as const, color: 'var(--text3)', background: 'var(--bg2)' }}>Ordered</th>
                <th style={{ padding: '8px 16px', textAlign: 'right' as const, fontSize: 10, textTransform: 'uppercase' as const, color: 'var(--text3)', background: 'var(--bg2)' }}>Coated</th>
                <th style={{ padding: '8px 16px', textAlign: 'right' as const, fontSize: 10, textTransform: 'uppercase' as const, color: 'var(--text3)', background: 'var(--bg2)' }}>Remaining</th>
              </tr></thead>
              <tbody>
                {b.rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)', background: r.extra ? 'var(--critical-bg)' : undefined }}>
                    <td style={{ padding: '8px 16px' }}>{r.label}</td>
                    <td style={{ padding: '8px 16px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: r.extra ? 'var(--text3)' : 'var(--text)' }}>{r.extra ? '—' : r.ordered}</td>
                    <td style={{ padding: '8px 16px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>{r.coated}</td>
                    <td style={{ padding: '8px 16px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, fontWeight: 800,
                      color: r.remaining > 0 ? 'var(--today)' : r.remaining < 0 ? 'var(--critical)' : 'var(--dispatched)' }}>
                      {r.remaining > 0 ? r.remaining : r.remaining < 0 ? (r.extra ? `+${-r.remaining} extra` : `−${-r.remaining}`) : '0 ✓'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}
