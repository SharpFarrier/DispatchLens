'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { fetchTracking } from '@/lib/tracking'
import { DBOrder } from '@/types'
import { RotateCcw, Search, X, CheckCircle, Clock, AlertTriangle, Package, IndianRupee, RefreshCw } from 'lucide-react'

export const RETURN_REASONS = [
  'In-transit Damage',
  'Manufacturing Defect',
  'Customer not Satisfied with Quality',
  'A-Z Claim Received',
  'Customer Refused Delivery',
  'Delay in Delivery',
  'Other',
] as const

export interface ReturnRow {
  id: string
  order_id: string
  source: 'manual' | 'rto_auto' | 'rto'
  return_type: 'customer' | 'rto' | null
  reason: string | null
  refund_status: 'pending' | 'refunded'
  refund_amount: number | null
  refund_type: 'full' | 'partial' | null
  refunded_at: string | null
  invoice_amount: number | null
  is_cancelled: boolean
  cancelled_at: string | null
  barcode: string | null
  reverse_tracking_id: string | null
  reverse_courier: string | null
  reverse_tracking_status: string | null
  reverse_tracking_label: string | null
  reverse_tracking_last_update: string | null
  reverse_tracking_synced_at: string | null
  warehouse_received: boolean
  warehouse_received_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
  created_by_email: string | null
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

interface Props {
  // Whether this user may see/edit the rupee refund amount (owner / can_users).
  canSeeAmount: boolean
  // Opens the order history overlay (where "Mark as Return" lives) — reuses the parent panel.
  onOpenOrder: (order: DBOrder) => void
  // Bump this number to force a reload (parent increments after a return is created in the overlay).
  reloadSignal: number
}

export default function ReturnsTab({ canSeeAmount, onOpenOrder, reloadSignal }: Props) {
  const supabase = createClient()
  const [returns, setReturns] = useState<ReturnRow[]>([])
  const [rtoOrders, setRtoOrders] = useState<DBOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [searchHits, setSearchHits] = useState<DBOrder[]>([])
  const [searching, setSearching] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [revSyncing, setRevSyncing] = useState(false)
  const [revSyncMsg, setRevSyncMsg] = useState<string | null>(null)
  const [amountDraft, setAmountDraft] = useState<Record<string, string>>({})
  // Draft reverse-tracking entry per row (customer returns, added after pickup is generated).
  const [revDraft, setRevDraft] = useState<Record<string, { id: string; courier: string }>>({})

  // ── Load returns + courier-RTO orders not yet tracked ──
  const load = useCallback(async () => {
    setLoading(true)
    const { data: ret } = await supabase.from('returns').select('*').order('created_at', { ascending: false }).order('id', { ascending: false })
    const rows = (ret || []) as ReturnRow[]
    setReturns(rows)
    // Auto-RTO candidates: dispatched orders the courier flagged rto, not already in returns.
    const tracked = new Set(rows.map(r => r.order_id))
    const rto = await fetchAllRows<DBOrder>((from, to) =>
      supabase.from('dispatch_orders').select('*')
        .eq('is_dispatched', true).eq('is_cancelled', false)
        .eq('tracking_status', 'rto')
        .order('dispatched_at', { ascending: false }).order('id', { ascending: false }).range(from, to))
    setRtoOrders(rto.filter(o => !tracked.has(o.order_id)))
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load, reloadSignal])

  // Sync the reverse leg (return travelling back) for returns that have a reverse tracking id + courier.
  const syncReverse = useCallback(async () => {
    if (revSyncing) return
    const targets = returns.filter(r =>
      r.reverse_tracking_id && r.reverse_courier &&
      r.reverse_tracking_status !== 'delivered' && r.reverse_tracking_status !== 'rto')
    if (!targets.length) { setRevSyncMsg('No reverse shipments to sync.'); return }
    setRevSyncing(true); setRevSyncMsg(null)
    try {
      const results = await fetchTracking(
        targets.map(r => ({ id: r.id, awb: r.reverse_tracking_id as string, courier: r.reverse_courier as string })))
      const now = new Date().toISOString()
      const norm = (v: string | null | undefined) => (v || '').trim().replace(/\.0+$/, '')
      let updated = 0
      await Promise.all(targets.map(async r => {
        const key = Object.keys(results).find(k => norm(k) === norm(r.reverse_tracking_id))
        const t = key ? results[key] : undefined
        if (!t) return
        updated++
        await supabase.from('returns').update({
          reverse_tracking_status: t.status,
          reverse_tracking_label: t.label,
          reverse_tracking_last_update: t.lastUpdate,
          reverse_tracking_synced_at: now,
          updated_at: now,
        }).eq('id', r.id)
      }))
      setReturns(prev => prev.map(r => {
        const key = Object.keys(results).find(k => norm(k) === norm(r.reverse_tracking_id))
        const t = key ? results[key] : undefined
        return t ? { ...r, reverse_tracking_status: t.status, reverse_tracking_label: t.label, reverse_tracking_last_update: t.lastUpdate, reverse_tracking_synced_at: now } : r
      }))
      setRevSyncMsg(`Synced ${updated} reverse shipment${updated === 1 ? '' : 's'}.`)
    } catch (e) {
      setRevSyncMsg('Reverse sync failed: ' + (e as Error).message)
    } finally {
      setRevSyncing(false)
    }
  }, [returns, revSyncing, supabase])

  // ── Search dispatched orders for manual add ──
  useEffect(() => {
    if (search.trim().length < 2) { setSearchHits([]); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      const q = search.trim()
      const { data } = await supabase.from('dispatch_orders').select('*')
        .eq('is_dispatched', true).eq('is_cancelled', false)
        .or(`order_id.ilike.%${q}%,customer_name.ilike.%${q}%,tracking_number.ilike.%${q}%,sku.ilike.%${q}%`)
        .order('dispatched_at', { ascending: false }).limit(10)
      if (!cancelled) { setSearchHits((data || []) as DBOrder[]); setSearching(false) }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search, supabase])

  // ── Create a return row from a courier-RTO order (one click) ──
  const addFromRto = async (o: DBOrder) => {
    setSavingId(o.id)
    const { data: { user } } = await supabase.auth.getUser()
    const { data } = await supabase.from('returns').upsert({
      order_id: o.order_id,
      source: 'rto_auto',
      reason: 'Customer Refused Delivery',
      barcode: o.scanned_barcode || null,
      created_by: user?.id ?? null,
      created_by_email: user?.email ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'order_id' }).select().maybeSingle()
    if (data) {
      setReturns(prev => [data as ReturnRow, ...prev.filter(r => r.order_id !== o.order_id)])
      setRtoOrders(prev => prev.filter(x => x.id !== o.id))
    }
    setSavingId(null)
  }

  // ── Update refund status / amount / reason ──
  const patchReturn = async (id: string, patch: Partial<ReturnRow>) => {
    setSavingId(id)
    const { data } = await supabase.from('returns')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).select().maybeSingle()
    if (data) setReturns(prev => prev.map(r => r.id === id ? (data as ReturnRow) : r))
    setSavingId(null)
  }

  const saveAmount = (id: string) => {
    const raw = amountDraft[id]
    const val = raw === '' || raw === undefined ? null : Number(raw)
    if (val !== null && (isNaN(val) || val < 0)) return
    patchReturn(id, { refund_amount: val })
    setAmountDraft(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  const pendingCount = useMemo(() => returns.filter(r => r.refund_status === 'pending').length, [returns])
  const refundedCount = returns.length - pendingCount
  const totalPending = useMemo(
    () => returns.filter(r => r.refund_status === 'pending').reduce((s, r) => s + (r.refund_amount || 0), 0),
    [returns])

  const reasonColor = (reason: string | null) => {
    switch (reason) {
      case 'Manufacturing Defect': return 'var(--critical)'
      case 'In-transit Damage': return 'var(--today)'
      case 'A-Z Claim Received': return 'var(--critical)'
      default: return 'var(--text2)'
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Returns</h1>
        <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{returns.length} tracked</span>
        <button onClick={load} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', cursor: 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <RefreshCw size={12} /> Refresh
        </button>
        <button onClick={syncReverse} disabled={revSyncing} style={{ background: revSyncing ? 'var(--bg2)' : 'var(--accent)', border: 'none', borderRadius: 6, color: revSyncing ? 'var(--text3)' : '#fff', cursor: revSyncing ? 'default' : 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
          <RotateCcw size={12} /> {revSyncing ? 'Syncing…' : 'Sync Reverse'}
        </button>
        {revSyncMsg && <span style={{ fontSize: 11, color: 'var(--text3)' }}>{revSyncMsg}</span>}
        {/* Summary chips */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
          {[
            { label: 'Pending refund', value: pendingCount, color: 'var(--today)', bg: 'var(--today-bg)', border: '#fed7aa' },
            { label: 'Refunded', value: refundedCount, color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', border: '#bbf7d0' },
            ...(canSeeAmount ? [{ label: 'Pending ₹', value: `₹${totalPending.toLocaleString('en-IN')}`, color: 'var(--text)', bg: 'var(--bg2)', border: 'var(--border)' }] : []),
          ].map(c => (
            <div key={c.label} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '5px 12px', background: c.bg, border: `1px solid ${c.border}`, borderRadius: 20 }}>
              <span style={{ fontFamily: 'DM Mono', fontSize: 14, fontWeight: 700, color: c.color }}>{c.value}</span>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{c.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Manual add: search dispatched orders ── */}
      <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
        <div style={{ fontSize: 12, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text2)', letterSpacing: '0.04em' }}>ADD A RETURN</div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>Search a dispatched order, then open it and choose “Mark as Return” in the history panel.</div>
        <div style={{ position: 'relative' as const, maxWidth: 480 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 12px' }}>
            <Search size={14} style={{ color: 'var(--text3)', flexShrink: 0 }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search order ID, customer, AWB, SKU…"
              style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, outline: 'none', width: '100%', fontFamily: 'DM Sans' }} />
            {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0 }}><X size={13} /></button>}
          </div>
          {search.trim().length >= 2 && (
            <div style={{ position: 'absolute' as const, top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 50, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', overflow: 'hidden', maxHeight: 320, overflowY: 'auto' }}>
              {searching ? (
                <div style={{ padding: 16, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Searching…</div>
              ) : searchHits.length === 0 ? (
                <div style={{ padding: 16, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No dispatched orders found</div>
              ) : searchHits.map(o => {
                const already = returns.some(r => r.order_id === o.order_id)
                return (
                  <button key={o.id} onClick={() => { onOpenOrder(o); setSearch('') }}
                    style={{ width: '100%', padding: '10px 14px', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left' as const, display: 'flex', alignItems: 'center', gap: 10 }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg2)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{o.customer_name}</div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                        <span style={{ fontSize: 11, fontFamily: 'DM Mono', color: 'var(--text3)' }}>{o.order_id.length > 20 ? o.order_id.slice(0, 20) + '…' : o.order_id}</span>
                        <span style={{ fontSize: 11, fontFamily: 'DM Mono', color: 'var(--text3)' }}>{o.sku}</span>
                      </div>
                    </div>
                    {already && <span style={{ fontSize: 10, fontFamily: 'DM Mono', color: 'var(--today)', background: 'var(--today-bg)', border: '1px solid #fed7aa', padding: '2px 7px', borderRadius: 4, flexShrink: 0 }}>in returns</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Auto: courier-flagged RTO awaiting intake ── */}
      {rtoOrders.length > 0 && (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', background: 'var(--today-bg)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={14} style={{ color: 'var(--today)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--today)' }}>Courier-flagged RTO ({rtoOrders.length})</span>
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>not yet in returns — add to track refund</span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
            <tbody>
              {rtoOrders.map((o, i) => (
                <tr key={o.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                  <td style={{ padding: '9px 18px', fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{o.customer_name}</td>
                  <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{o.order_id.length > 20 ? o.order_id.slice(0, 20) + '…' : o.order_id}</td>
                  <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{o.sku}</td>
                  <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{o.tracking_number || '—'}</td>
                  <td style={{ padding: '9px 18px', textAlign: 'right' as const }}>
                    <button onClick={() => addFromRto(o)} disabled={savingId === o.id}
                      style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      {savingId === o.id ? 'Adding…' : 'Add to returns'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Returns list ── */}
      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' as const }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13, minWidth: 820 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border2)', background: 'var(--bg2)' }}>
                {['Order', 'SKU', 'Reason', 'Type', 'Reverse', 'Warehouse', 'Refund', ...(canSeeAmount ? ['Amount'] : []), 'Added', ''].map((h, hi) => (
                  <th key={hi} style={{ padding: '9px 12px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={canSeeAmount ? 10 : 9} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading…</td></tr>
              ) : returns.length === 0 ? (
                <tr><td colSpan={canSeeAmount ? 10 : 9} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>No returns tracked yet. Add one above.</td></tr>
              ) : returns.map((r, i) => (
                <tr key={r.id} style={{ borderBottom: i < returns.length - 1 ? '1px solid var(--border)' : 'none', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                  <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{r.order_id.length > 18 ? r.order_id.slice(0, 18) + '…' : r.order_id}</td>
                  <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{r.barcode || '—'}</td>
                  <td style={{ padding: '9px 12px' }}>
                    {(() => {
                      const needsReason = r.warehouse_received && (!r.reason || r.reason === 'Pending review')
                      // Show the stored value; if it's the placeholder / unset, sit on the blank option.
                      const selectVal = (!r.reason || r.reason === 'Pending review') ? '' : r.reason
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {needsReason && (
                            <span title="Received — reason not set yet" style={{ fontSize: 9, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--critical)', background: 'var(--critical-bg)', border: '1px solid #fecaca', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' as const }}>NEEDS REASON</span>
                          )}
                          <select value={selectVal} onChange={e => patchReturn(r.id, { reason: e.target.value })}
                            style={{ fontSize: 11, fontFamily: 'DM Sans', color: reasonColor(selectVal || null), background: 'var(--surface)', border: `1px solid ${needsReason ? '#fecaca' : 'var(--border)'}`, borderRadius: 5, padding: '3px 6px', cursor: 'pointer', maxWidth: 200 }}>
                            <option value="">— set reason —</option>
                            {RETURN_REASONS.map(rs => <option key={rs} value={rs}>{rs}</option>)}
                          </select>
                        </div>
                      )
                    })()}
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    {(() => {
                      const isRto = r.return_type === 'rto' || r.source === 'rto_auto' || r.source === 'rto'
                      return (
                        <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: isRto ? 'var(--today)' : 'var(--accent)', background: isRto ? 'var(--today-bg)' : 'var(--accent-bg)', border: `1px solid ${isRto ? '#fed7aa' : 'var(--border)'}`, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' as const }}>
                          {isRto ? 'RTO' : 'CUSTOMER'}
                        </span>
                      )
                    })()}
                  </td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}>
                    {r.reverse_tracking_id ? (
                      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                        <span style={{ fontFamily: 'DM Mono', fontSize: 10, color: 'var(--text2)' }}>{r.reverse_tracking_id}</span>
                        <span style={{ fontSize: 10, color: r.reverse_tracking_status === 'delivered' ? 'var(--dispatched)' : r.reverse_tracking_status === 'rto' ? 'var(--critical)' : 'var(--text3)' }}>
                          {r.reverse_courier || ''}{r.reverse_tracking_label ? ` · ${r.reverse_tracking_label}` : (r.reverse_tracking_status ? ` · ${r.reverse_tracking_status}` : ' · not synced')}
                        </span>
                      </div>
                    ) : (r.return_type === 'rto' || r.source === 'rto_auto' || r.source === 'rto') ? (
                      // RTO tracks on the forward AWB (Bluedart re-tags) — no reverse ID entry.
                      <span style={{ fontSize: 10, color: 'var(--text3)' }}>tracks on forward AWB</span>
                    ) : r.is_cancelled ? (
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>—</span>
                    ) : (
                      // Customer return, pickup generated → enter the reverse pickup ID now.
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          value={revDraft[r.id]?.id ?? ''}
                          onChange={e => setRevDraft(p => ({ ...p, [r.id]: { id: e.target.value, courier: p[r.id]?.courier ?? '' } }))}
                          placeholder="pickup ID…"
                          style={{ width: 92, padding: '3px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 10, fontFamily: 'DM Mono', outline: 'none' }}
                        />
                        <select
                          value={revDraft[r.id]?.courier ?? ''}
                          onChange={e => setRevDraft(p => ({ ...p, [r.id]: { id: p[r.id]?.id ?? '', courier: e.target.value } }))}
                          style={{ fontSize: 10, padding: '3px 4px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer' }}>
                          <option value="">courier</option>
                          <option value="Bluedart">BD</option>
                          <option value="Delhivery">DL</option>
                        </select>
                        <button
                          disabled={savingId === r.id || !(revDraft[r.id]?.id?.trim()) || !(revDraft[r.id]?.courier)}
                          onClick={() => { const d = revDraft[r.id]; patchReturn(r.id, { reverse_tracking_id: d.id.trim(), reverse_courier: d.courier } as Partial<ReturnRow>); setRevDraft(p => { const n = { ...p }; delete n[r.id]; return n }) }}
                          style={{ padding: '3px 7px', borderRadius: 5, border: 'none', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                            background: (revDraft[r.id]?.id?.trim() && revDraft[r.id]?.courier) ? 'var(--accent)' : 'var(--border2)',
                            color: '#fff' }}>
                          Add
                        </button>
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    {r.warehouse_received ? (
                      <span style={{ fontSize: 11, color: 'var(--dispatched)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <CheckCircle size={12} /> Received
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Clock size={12} /> Awaiting
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    {r.is_cancelled ? (
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>—</span>
                    ) : (() => {
                      const refunded = r.refund_status === 'refunded'
                      // Derive full/partial from amount vs invoice when marking refunded.
                      const markRefunded = () => {
                        const amt = r.refund_amount
                        const inv = r.invoice_amount
                        const type: 'full' | 'partial' | null =
                          amt != null && inv != null ? (amt >= inv ? 'full' : 'partial') : null
                        patchReturn(r.id, { refund_status: 'refunded', refund_type: type, refunded_at: new Date().toISOString() } as Partial<ReturnRow>)
                      }
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                          <button onClick={() => refunded ? patchReturn(r.id, { refund_status: 'pending', refund_type: null, refunded_at: null } as Partial<ReturnRow>) : markRefunded()}
                            disabled={savingId === r.id}
                            style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${refunded ? '#bbf7d0' : '#fed7aa'}`, background: refunded ? 'var(--dispatched-bg)' : 'var(--today-bg)', color: refunded ? 'var(--dispatched)' : 'var(--today)', fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {refunded ? <><CheckCircle size={11} /> Refunded</> : <><Clock size={11} /> Pending</>}
                          </button>
                          {refunded && r.refund_type && (
                            <span style={{ fontSize: 9, fontFamily: 'DM Mono', fontWeight: 700, color: r.refund_type === 'partial' ? 'var(--today)' : 'var(--dispatched)' }}>
                              {r.refund_type.toUpperCase()}{r.refund_type === 'partial' && r.invoice_amount ? ` ₹${r.refund_amount}/₹${r.invoice_amount}` : ''}
                            </span>
                          )}
                        </div>
                      )
                    })()}
                  </td>
                  {canSeeAmount && (
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ color: 'var(--text3)', fontSize: 12 }}>₹</span>
                        <input
                          value={amountDraft[r.id] ?? (r.refund_amount ?? '')}
                          onChange={e => setAmountDraft(prev => ({ ...prev, [r.id]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') saveAmount(r.id) }}
                          onBlur={() => { if (amountDraft[r.id] !== undefined) saveAmount(r.id) }}
                          placeholder="0"
                          style={{ width: 80, padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, fontFamily: 'DM Mono', outline: 'none' }}
                        />
                      </div>
                    </td>
                  )}
                  <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>
                    {new Date(r.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}>
                    {r.is_cancelled ? (
                      <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--text3)', background: 'var(--bg2)', border: '1px solid var(--border)', padding: '2px 7px', borderRadius: 4 }}>CANCELLED</span>
                    ) : (r.return_type === 'customer' || r.source === 'manual') && !r.warehouse_received && r.refund_status !== 'refunded' ? (
                      // Customer changed their mind — cancel the return request. Order stays normal.
                      <button onClick={() => { if (confirm('Cancel this return request? The order stays delivered/normal.')) patchReturn(r.id, { is_cancelled: true, cancelled_at: new Date().toISOString() } as Partial<ReturnRow>) }}
                        disabled={savingId === r.id}
                        style={{ padding: '3px 9px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>
                        Cancel request
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
