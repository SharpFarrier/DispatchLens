'use client'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { fetchTracking } from '@/lib/tracking'
import { DBOrder } from '@/types'
import { logOrderEvent } from '@/lib/orderEvents'
import { RotateCcw, Search, X, CheckCircle, Clock, AlertTriangle, Package, IndianRupee, RefreshCw, Pencil, ChevronRight, ChevronDown, Download, ArrowUp, ArrowDown, Filter, ExternalLink } from 'lucide-react'

// Reasons shared by both RTO and customer returns (physical-condition reasons).
const SHARED_REASONS = [
  'In-transit Damage',
  'Manufacturing Defect',
] as const

// Shown when the return is an RTO (returned to origin, never delivered/kept).
export const RTO_REASONS = [
  ...SHARED_REASONS,
  'Delay in Delivery',
  'Customer Refused Delivery',
  'No Need',
  'Not Available',
  'Other',
] as const

// Shown when the return is a customer return (was delivered, came back).
export const CUSTOMER_RETURN_REASONS = [
  ...SHARED_REASONS,
  'Customer not Satisfied with Quality',
  'A-Z Claim Received',
  'Noise Issue',
  'Size Issue',
  'Self Ship Return',
  'Alignment Issue',
  'Other',
] as const

// Full set (union) — kept for reason-colour lookups and any all-reasons use.
export const RETURN_REASONS = [
  'In-transit Damage',
  'Manufacturing Defect',
  'Customer not Satisfied with Quality',
  'A-Z Claim Received',
  'Customer Refused Delivery',
  'Delay in Delivery',
  'No Need',
  'Not Available',
  'Noise Issue',
  'Size Issue',
  'Self Ship Return',
  'Alignment Issue',
  'Other',
] as const

export interface ReturnRow {
  id: string
  order_id: string | null
  source: 'manual' | 'rto_auto' | 'rto' | 'cancelled'
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
  received_sku: string | null
  sku_mismatch: boolean
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

// ── Shared sort/filter machinery for the Returns tables (main list + daily review) ──
interface RetCol { key: string; label: string; type: 'text' | 'category' | 'date' | 'number'; get: (r: ReturnRow) => string | number }

function isRtoRow(r: ReturnRow) { return r.return_type === 'rto' || r.source === 'rto_auto' || r.source === 'rto' }

// Column value-getters used for filtering & sorting (rendering stays in the table body).
function returnCols(canSeeAmount: boolean): RetCol[] {
  const cols: RetCol[] = [
    { key: 'order_id', label: 'Order', type: 'text', get: r => r.order_id ?? '' },
    { key: 'barcode', label: 'SKU', type: 'text', get: r => r.barcode || '' },
    { key: 'reason', label: 'Reason', type: 'category', get: r => (!r.reason || r.reason === 'Pending review') ? '(no reason)' : r.reason },
    { key: 'type', label: 'Type', type: 'category', get: r => isRtoRow(r) ? 'RTO' : 'Customer' },
    { key: 'reverse', label: 'Reverse', type: 'text', get: r => r.reverse_tracking_id || '' },
    { key: 'warehouse', label: 'Warehouse', type: 'category', get: r => r.warehouse_received ? 'Received' : 'Not received' },
    { key: 'refund', label: 'Refund', type: 'category', get: r => r.refund_status === 'refunded' ? 'Refunded' : 'Pending' },
    { key: 'received_sku', label: 'Received SKU', type: 'text', get: r => r.received_sku || '' },
    { key: 'flag', label: 'Flag', type: 'category', get: r => r.sku_mismatch ? 'SKU mismatch' : '' },
  ]
  if (canSeeAmount) cols.push({ key: 'amount', label: 'Amount', type: 'number', get: r => r.refund_amount ?? 0 })
  cols.push({ key: 'added', label: 'Added', type: 'date', get: r => r.created_at || '' })
  return cols
}

const retToDay = (v: string | number): string => { const s = String(v || ''); return s ? s.slice(0, 10) : '' }

// Hook: holds sort + filter state and returns the filtered+sorted rows + header helpers.
function useReturnFilters(rows: ReturnRow[], cols: RetCol[]) {
  const [sortKey, setSortKey] = useState<string>('added')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [textFilters, setTextFilters] = useState<Record<string, string>>({})
  const [catFilters, setCatFilters] = useState<Record<string, string[]>>({})
  const [dateFilters, setDateFilters] = useState<Record<string, string[]>>({})
  const [openFilter, setOpenFilter] = useState<string | null>(null)
  const [dateTreeOpen, setDateTreeOpen] = useState<Record<string, boolean>>({})
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openFilter) return
    const h = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpenFilter(null) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [openFilter])

  const colByKey = useMemo(() => Object.fromEntries(cols.map(c => [c.key, c])), [cols])

  const catOptions = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const c of cols) if (c.type === 'category') { const set = new Set<string>(); for (const r of rows) set.add(String(c.get(r)) || '(blank)'); m[c.key] = Array.from(set).sort() }
    return m
  }, [cols, rows])

  const dateTrees = useMemo(() => {
    const m: Record<string, Record<string, Record<string, Set<string>>>> = {}
    for (const c of cols) if (c.type === 'date') {
      const tree: Record<string, Record<string, Set<string>>> = {}
      for (const r of rows) { const day = retToDay(c.get(r)); if (!day || day.length < 10) continue; const [y, mo] = [day.slice(0, 4), day.slice(5, 7)]; (tree[y] ??= {})[mo] ??= new Set<string>(); tree[y][mo].add(day) }
      m[c.key] = tree
    }
    return m
  }, [cols, rows])

  const filtered = useMemo(() => {
    let out = rows.filter(r => {
      for (const key in textFilters) { const v = textFilters[key]; if (!v) continue; const col = colByKey[key]; if (col && !String(col.get(r)).toLowerCase().includes(v.toLowerCase())) return false }
      for (const key in catFilters) { const a = catFilters[key]; if (!a || !a.length) continue; const col = colByKey[key]; if (col && !a.includes(String(col.get(r)) || '(blank)')) return false }
      for (const key in dateFilters) { const days = dateFilters[key]; if (!days || !days.length) continue; const col = colByKey[key]; if (col && !days.includes(retToDay(col.get(r)))) return false }
      return true
    })
    const col = colByKey[sortKey]
    if (col) out = [...out].sort((a, b) => { const va = col.get(a), vb = col.get(b); const cmp = col.type === 'number' ? (va as number) - (vb as number) : String(va).localeCompare(String(vb)); return sortDir === 'asc' ? cmp : -cmp })
    return out
  }, [rows, colByKey, textFilters, catFilters, dateFilters, sortKey, sortDir])

  const toggleSort = (key: string) => { if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir('asc') } }
  const hasFilter = (key: string) => !!textFilters[key] || (catFilters[key]?.length ?? 0) > 0 || (dateFilters[key]?.length ?? 0) > 0
  const anyFilter = Object.values(textFilters).some(Boolean) || Object.values(catFilters).some(a => a?.length) || Object.values(dateFilters).some(a => a?.length)
  const clearAll = () => { setTextFilters({}); setCatFilters({}); setDateFilters({}) }

  return { filtered, sortKey, sortDir, toggleSort, hasFilter, anyFilter, clearAll, openFilter, setOpenFilter, popRef, catOptions, dateTrees, textFilters, setTextFilters, catFilters, setCatFilters, dateFilters, setDateFilters, dateTreeOpen, setDateTreeOpen }
}

type RetFilterCtx = ReturnType<typeof useReturnFilters>

// A filterable + sortable <th> for the Returns tables.
function RetHeaderCell({ col, ctx }: { col: RetCol; ctx: RetFilterCtx }) {
  const monthName = (mo: string) => ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(mo, 10)] || mo
  const dayNum = (day: string) => parseInt(day.slice(8, 10), 10)
  const toggleDays = (colKey: string, days: string[], on: boolean) => ctx.setDateFilters(prev => { const cur = new Set(prev[colKey] || []); if (on) days.forEach(d => cur.add(d)); else days.forEach(d => cur.delete(d)); return { ...prev, [colKey]: Array.from(cur) } })
  const daysUnder = (tree: Record<string, Record<string, Set<string>>>, y?: string, mo?: string): string[] => { const out: string[] = []; for (const yy in tree) { if (y && yy !== y) continue; for (const mm in tree[yy]) { if (mo && mm !== mo) continue; tree[yy][mm].forEach(d => out.push(d)) } } return out }
  const allChecked = (colKey: string, days: string[]) => { const sel = new Set(ctx.dateFilters[colKey] || []); return days.length > 0 && days.every(d => sel.has(d)) }
  const someChecked = (colKey: string, days: string[]) => { const sel = new Set(ctx.dateFilters[colKey] || []); return days.some(d => sel.has(d)) }
  const treeNodeOpen = (k: string) => ctx.dateTreeOpen[k] ?? false
  const toggleNode = (k: string) => ctx.setDateTreeOpen(prev => ({ ...prev, [k]: !(prev[k] ?? false) }))

  return (
    <th style={{ padding: '9px 12px', textAlign: col.type === 'number' ? 'right' as const : 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const, position: 'relative' as const }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: col.type === 'number' ? 'flex-end' : 'flex-start' }}>
        <span onClick={() => ctx.toggleSort(col.key)} style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, color: ctx.sortKey === col.key ? 'var(--accent)' : 'inherit' }}>
          {col.label}{ctx.sortKey === col.key && (ctx.sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
        </span>
        <button onClick={() => ctx.setOpenFilter(ctx.openFilter === col.key ? null : col.key)} title="Filter" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, display: 'inline-flex', color: ctx.hasFilter(col.key) ? 'var(--accent)' : 'var(--text3)', opacity: ctx.hasFilter(col.key) ? 1 : 0.4 }}><Filter size={11} /></button>
      </div>
      {ctx.openFilter === col.key && (
        <div ref={ctx.popRef} style={{ position: 'absolute' as const, top: '100%', left: 0, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 10, zIndex: 50, minWidth: 170, textAlign: 'left' as const, fontFamily: 'DM Sans', fontWeight: 400 }}>
          {col.type === 'category' ? (
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3, maxHeight: 240, overflowY: 'auto' as const }}>
              {(ctx.catOptions[col.key] || []).map(opt => { const cur = ctx.catFilters[col.key] || []; const on = cur.includes(opt); return (
                <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text2)', cursor: 'pointer', padding: '2px 0' }}>
                  <input type="checkbox" checked={on} onChange={() => ctx.setCatFilters(prev => { const c = prev[col.key] || []; const next = c.includes(opt) ? c.filter(x => x !== opt) : [...c, opt]; return { ...prev, [col.key]: next } })} />{opt}
                </label>) })}
            </div>
          ) : col.type === 'date' ? (() => {
            const tree = ctx.dateTrees[col.key] || {}
            const years = Object.keys(tree).sort((a, b) => b.localeCompare(a))
            if (!years.length) return <div style={{ fontSize: 12, color: 'var(--text3)' }}>No dates</div>
            return (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 1, maxHeight: 280, overflowY: 'auto' as const, minWidth: 180 }}>
                {(ctx.dateFilters[col.key]?.length ?? 0) > 0 && <button onClick={() => ctx.setDateFilters(prev => ({ ...prev, [col.key]: [] }))} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: '0 0 4px' }}>Clear</button>}
                {years.map(y => { const yKey = `${col.key}|${y}`, yDays = daysUnder(tree, y); const months = Object.keys(tree[y]).sort((a, b) => b.localeCompare(a)); return (
                  <div key={y}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0' }}>
                      <span onClick={() => toggleNode(yKey)} style={{ cursor: 'pointer', color: 'var(--text3)', display: 'inline-flex', width: 12 }}>{treeNodeOpen(yKey) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                      <input type="checkbox" checked={allChecked(col.key, yDays)} ref={el => { if (el) el.indeterminate = !allChecked(col.key, yDays) && someChecked(col.key, yDays) }} onChange={e => toggleDays(col.key, yDays, e.target.checked)} />
                      <span onClick={() => toggleNode(yKey)} style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{y}</span>
                    </div>
                    {treeNodeOpen(yKey) && months.map(mo => { const mKey = `${col.key}|${y}-${mo}`, mDays = daysUnder(tree, y, mo); const days = Array.from(tree[y][mo]).sort((a, b) => b.localeCompare(a)); return (
                      <div key={mo} style={{ marginLeft: 17 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0' }}>
                          <span onClick={() => toggleNode(mKey)} style={{ cursor: 'pointer', color: 'var(--text3)', display: 'inline-flex', width: 12 }}>{treeNodeOpen(mKey) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                          <input type="checkbox" checked={allChecked(col.key, mDays)} ref={el => { if (el) el.indeterminate = !allChecked(col.key, mDays) && someChecked(col.key, mDays) }} onChange={e => toggleDays(col.key, mDays, e.target.checked)} />
                          <span onClick={() => toggleNode(mKey)} style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>{monthName(mo)}</span>
                        </div>
                        {treeNodeOpen(mKey) && days.map(d => { const on = (ctx.dateFilters[col.key] || []).includes(d); return (
                          <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 17, padding: '2px 0', fontSize: 12, color: 'var(--text2)', cursor: 'pointer', fontFamily: 'DM Mono' }}>
                            <input type="checkbox" checked={on} onChange={() => toggleDays(col.key, [d], !on)} />{dayNum(d)}
                          </label>) })}
                      </div>) })}
                  </div>) })}
              </div>
            )
          })() : (
            <input autoFocus value={ctx.textFilters[col.key] || ''} onChange={e => ctx.setTextFilters(prev => ({ ...prev, [col.key]: e.target.value }))} placeholder={`Filter ${col.label}…`} style={{ width: '100%', padding: '6px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const }} />
          )}
        </div>
      )}
    </th>
  )
}


// ── One received-but-unmapped return: enter forward AWB -> find order -> confirm link ──
function UnmappedRow({ row, supabase, onLinked }: { row: ReturnRow; supabase: ReturnType<typeof createClient>; onLinked: (r: ReturnRow) => void }) {
  const [awb, setAwb] = useState('')
  const [found, setFound] = useState<DBOrder | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const findOrder = async () => {
    const q = awb.trim()
    if (!q) { setError('Enter a forward AWB'); return }
    setBusy(true); setError(null); setFound(null)
    const { data } = await supabase.from('dispatch_orders').select('*').eq('tracking_number', q).limit(1).maybeSingle()
    if (!data) { setError('No match — check the number'); setBusy(false); return }
    setFound(data as DBOrder); setBusy(false)
  }

  const confirmLink = async () => {
    if (!found) return
    setBusy(true); setError(null)
    const { data: existing } = await supabase.from('returns').select('id').eq('order_id', found.order_id).neq('id', row.id).limit(1).maybeSingle()
    if (existing) { setError(`Order ${found.order_id} already has a return — not linked`); setBusy(false); return }
    const orderedSku = (found.barcode_sku || found.sku || '') as string
    const mismatch = !!(row.received_sku && orderedSku && row.received_sku !== orderedSku)
    const { data } = await supabase.from('returns').update({
      order_id: found.order_id,
      barcode: found.scanned_barcode || row.barcode || null,
      return_type: row.return_type || 'customer',
      sku_mismatch: mismatch,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id).select().maybeSingle()
    if (data) {
      void logOrderEvent(found.order_id, 'return', 'Return mapped to order via forward AWB', row.reverse_tracking_id ? `reverse ${row.reverse_tracking_id}` : null)
      onLinked(data as ReturnRow)
    } else { setError('Could not link — try again'); setBusy(false) }
  }

  const recvAt = row.warehouse_received_at ? new Date(row.warehouse_received_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
        <span style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--text)' }}>{row.reverse_tracking_id}</span>
        {row.received_sku && <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>{row.received_sku}</span>}
        <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--today)', background: 'var(--today-bg)', border: '1px solid #fed7aa', padding: '2px 7px', borderRadius: 4 }}>RECEIVED · UNMAPPED</span>
        {recvAt && <span style={{ fontSize: 12, color: 'var(--text3)' }}>received {recvAt}</span>}
        <input value={awb} onChange={e => { setAwb(e.target.value); setError(null); setFound(null) }}
          onKeyDown={e => { if (e.key === 'Enter') findOrder() }}
          placeholder="Enter forward AWB to map"
          style={{ flex: 1, minWidth: 200, border: '1px solid var(--border)', background: 'var(--bg2)', borderRadius: 7, padding: '7px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'DM Mono', outline: 'none' }} />
        <button onClick={findOrder} disabled={busy || !awb.trim()}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text2)', cursor: busy || !awb.trim() ? 'default' : 'pointer', padding: '7px 14px', fontSize: 12, fontWeight: 600 }}>Find order</button>
      </div>
      {error && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--critical)', marginTop: 8 }}>{error}</div>}
      {found && (
        <div style={{ marginTop: 10, background: 'var(--bg2)', border: '1px solid var(--accent)', borderRadius: 7, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
          <div style={{ fontSize: 13 }}>
            <span style={{ fontFamily: 'DM Mono', color: 'var(--text)' }}>{found.order_id}</span>
            <span style={{ color: 'var(--text3)' }}> · {found.sku || found.scanned_barcode || '—'}{found.dispatched_at ? ` · dispatched ${new Date(found.dispatched_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</span>
            {row.received_sku && (found.barcode_sku || found.sku) && row.received_sku !== (found.barcode_sku || found.sku) && (
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--critical)', marginTop: 4 }}>received {row.received_sku} \u2260 ordered {found.barcode_sku || found.sku} — will be flagged, refund held</div>
            )}
          </div>
          <button onClick={confirmLink} disabled={busy}
            style={{ background: 'var(--accent)', border: 'none', borderRadius: 7, color: '#fff', cursor: busy ? 'default' : 'pointer', padding: '7px 14px', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
            <CheckCircle size={13} /> Confirm link
          </button>
        </div>
      )}
    </div>
  )
}

export default function ReturnsTab({ canSeeAmount, onOpenOrder, reloadSignal }: Props) {
  const supabase = createClient()
  const [returns, setReturns] = useState<ReturnRow[]>([])
  const [subTab, setSubTab] = useState<'returns' | 'daily' | 'cancelled'>('returns')
  const cols = useMemo(() => returnCols(canSeeAmount), [canSeeAmount])
  const mapped = useMemo(() => returns.filter(r => r.order_id), [returns])
  const unmapped = useMemo(() => returns.filter(r => !r.order_id), [returns])
  const mismatched = useMemo(() => returns.filter(r => r.order_id && r.sku_mismatch), [returns])
  const flt = useReturnFilters(mapped, cols)
  const shownReturns = flt.filtered
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
  // Which customer-return row is currently editing its (existing) reverse tracking ID.
  const [editingRevId, setEditingRevId] = useState<string | null>(null)

  // ── Load returns + courier-RTO orders not yet tracked ──
  const load = useCallback(async () => {
    setLoading(true)
    const { data: ret } = await supabase.from('returns').select('*').order('created_at', { ascending: false }).order('id', { ascending: false })
    const rows = (ret || []) as ReturnRow[]
    setReturns(rows)
    // Auto-RTO candidates: dispatched orders the courier flagged rto, not already in returns.
    const tracked = new Set(rows.filter(r => r.order_id).map(r => r.order_id as string))
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
      const row = data as ReturnRow
      setReturns(prev => [row, ...prev.filter(r => r.order_id !== o.order_id)])
      setRtoOrders(prev => prev.filter(x => x.id !== o.id))
      void logOrderEvent(row.order_id ?? '', 'return', `Return created${row.return_type ? ` · ${row.return_type === 'rto' ? 'RTO' : 'Customer'}` : ''}`, row.reason || null)
    }
    setSavingId(null)
  }

  // Move a return from unmapped -> mapped after it's linked to an order.
  const onReturnLinked = (updated: ReturnRow) => {
    setReturns(prev => prev.map(r => r.id === updated.id ? updated : r))
  }

  // ── Update refund status / amount / reason ──
  const exportReturns = () => {
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const header = ['Order', 'SKU', 'Reason', 'Type', 'Reverse tracking', 'Reverse courier', 'Warehouse received', 'Received at', 'Refund status', ...(canSeeAmount ? ['Refund amount'] : []), 'Added']
    const lines = shownReturns.map(r => [
      r.order_id,
      r.barcode || '',
      (!r.reason || r.reason === 'Pending review') ? '' : r.reason,
      isRtoRow(r) ? 'RTO' : 'Customer',
      r.reverse_tracking_id || '',
      r.reverse_courier || '',
      r.warehouse_received ? 'Yes' : 'No',
      r.warehouse_received_at ? new Date(r.warehouse_received_at).toLocaleString('en-IN') : '',
      r.refund_status,
      ...(canSeeAmount ? [r.refund_amount != null ? String(r.refund_amount) : ''] : []),
      r.created_at ? new Date(r.created_at).toLocaleDateString('en-IN') : '',
    ].map(esc).join(','))
    const csv = [header.join(','), ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `returns-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const patchReturn = async (id: string, patch: Partial<ReturnRow>) => {
    if (patch.refund_status === 'refunded') {
      const cur = returns.find(r => r.id === id)
      if (cur?.sku_mismatch) { alert('This return has a SKU mismatch — clear the mismatch flag before marking it refunded.'); return }
    }
    setSavingId(id)
    const before = returns.find(r => r.id === id)
    const { data } = await supabase.from('returns')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).select().maybeSingle()
    if (data) {
      const row = data as ReturnRow
      setReturns(prev => prev.map(r => r.id === id ? row : r))
      // Mirror meaningful return changes onto the order timeline.
      if ('warehouse_received' in patch) {
        void logOrderEvent(row.order_id ?? '', 'return', patch.warehouse_received ? 'Return received at factory' : 'Return receipt undone', row.barcode ? `piece ${row.barcode}` : null)
      }
      if ('refund_status' in patch) {
        if (patch.refund_status === 'refunded') void logOrderEvent(row.order_id ?? '', 'return', `Refund issued${row.refund_type ? ` · ${row.refund_type}` : ''}`, row.refund_amount != null ? `₹${row.refund_amount}` : null)
        else void logOrderEvent(row.order_id ?? '', 'return', 'Refund reverted (back to pending)')
      }
      if ('reason' in patch && patch.reason && before && before.reason !== patch.reason) {
        void logOrderEvent(row.order_id ?? '', 'return', `Return reason set · ${patch.reason}`)
      }
    }
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
        <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{subTab === 'returns' && flt.anyFilter ? `${shownReturns.length} of ${mapped.length}` : `${mapped.length} tracked`}</span>
        {subTab === 'returns' && flt.anyFilter && <button onClick={flt.clearAll} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--accent)', cursor: 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}><X size={12} /> Clear filters</button>}
        <button onClick={load} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', cursor: 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <RefreshCw size={12} /> Refresh
        </button>
        <button onClick={syncReverse} disabled={revSyncing} style={{ background: revSyncing ? 'var(--bg2)' : 'var(--accent)', border: 'none', borderRadius: 6, color: revSyncing ? 'var(--text3)' : '#fff', cursor: revSyncing ? 'default' : 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
          <RotateCcw size={12} /> {revSyncing ? 'Syncing…' : 'Sync Reverse'}
        </button>
        <button onClick={exportReturns} disabled={!shownReturns.length} title={flt.anyFilter ? 'Export the filtered rows as CSV' : 'Export the returns list as CSV'} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: shownReturns.length ? 'var(--text2)' : 'var(--text3)', cursor: shownReturns.length ? 'pointer' : 'not-allowed', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
          <Download size={12} /> Export{subTab === 'returns' && flt.anyFilter ? ' (filtered)' : ''}
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

      {/* Sub-tab switcher */}
      <div style={{ display: 'flex', gap: 6 }}>
        {(['returns', 'daily', 'cancelled'] as const).map(t => (
          <button key={t} onClick={() => setSubTab(t)} style={{
            padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700,
            border: subTab === t ? '2px solid var(--accent)' : '1px solid var(--border)',
            background: subTab === t ? 'var(--accent)' : 'var(--surface)', color: subTab === t ? '#fff' : 'var(--text2)',
          }}>{t === 'returns' ? 'Returns' : t === 'daily' ? 'Daily review' : 'Cancelled'}</button>
        ))}
      </div>

      {subTab === 'daily' ? (
        <DailyReview returns={mapped} canSeeAmount={canSeeAmount} savingId={savingId} onRefund={patchReturn} onOpenOrder={onOpenOrder} />
      ) : subTab === 'cancelled' ? (
        <CancelledReview canSeeAmount={canSeeAmount} onOpenOrder={onOpenOrder} />
      ) : (<>

      {/* ── Awaiting order mapping (received, no order yet) ── */}
      {unmapped.length > 0 && (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', background: 'var(--today-bg)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
            <Clock size={14} style={{ color: 'var(--today)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--today)' }}>Awaiting order mapping ({unmapped.length})</span>
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>received — enter the forward AWB to link each to its order</span>
          </div>
          {unmapped.map(r => (
            <UnmappedRow key={r.id} row={r} supabase={supabase} onLinked={onReturnLinked} />
          ))}
        </div>
      )}

      {/* ── SKU mismatch — refund held until cleared ── */}
      {mismatched.length > 0 && (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', background: 'var(--critical-bg)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
            <AlertTriangle size={14} style={{ color: 'var(--critical)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--critical)' }}>SKU mismatch — refund held ({mismatched.length})</span>
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>received item differs from the order — review, then clear to release the refund</span>
          </div>
          {mismatched.map(r => (
            <div key={r.id} style={{ padding: '10px 18px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
              <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text)' }}>{r.order_id}</span>
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>received <span style={{ fontFamily: 'DM Mono', color: 'var(--critical)' }}>{r.received_sku || '—'}</span></span>
              <button onClick={() => patchReturn(r.id, { sku_mismatch: false })} disabled={savingId === r.id}
                style={{ marginLeft: 'auto', padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                {savingId === r.id ? 'Clearing…' : 'Clear mismatch'}
              </button>
            </div>
          ))}
        </div>
      )}

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
                {cols.map(c => <RetHeaderCell key={c.key} col={c} ctx={flt} />)}
                <th style={{ padding: '9px 12px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const }}></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={canSeeAmount ? 10 : 9} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading…</td></tr>
              ) : returns.length === 0 ? (
                <tr><td colSpan={canSeeAmount ? 10 : 9} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>No returns tracked yet. Add one above.</td></tr>
              ) : shownReturns.length === 0 ? (
                <tr><td colSpan={canSeeAmount ? 10 : 9} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>No returns match the current filters.</td></tr>
              ) : shownReturns.map((r, i) => (
                <tr key={r.id} style={{ borderBottom: i < shownReturns.length - 1 ? '1px solid var(--border)' : 'none', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                  <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{r.order_id}</td>
                  <td style={{ padding: '9px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{r.barcode || '—'}</td>
                  <td style={{ padding: '9px 12px' }}>
                    {(() => {
                      const needsReason = r.warehouse_received && (!r.reason || r.reason === 'Pending review')
                      // Show the stored value; if it's the placeholder / unset, sit on the blank option.
                      const selectVal = (!r.reason || r.reason === 'Pending review') ? '' : r.reason
                      const isRto = r.return_type === 'rto' || r.source === 'rto_auto' || r.source === 'rto'
                      const reasonList: readonly string[] = isRto ? RTO_REASONS : CUSTOMER_RETURN_REASONS
                      // If the stored reason isn't in the type's list (e.g. an older value), still show it.
                      const options = selectVal && !reasonList.includes(selectVal)
                        ? [selectVal, ...reasonList] : reasonList
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {needsReason && (
                            <span title="Received — reason not set yet" style={{ fontSize: 9, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--critical)', background: 'var(--critical-bg)', border: '1px solid #fecaca', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' as const }}>NEEDS REASON</span>
                          )}
                          <select value={selectVal} onChange={e => patchReturn(r.id, { reason: e.target.value })}
                            style={{ fontSize: 11, fontFamily: 'DM Sans', color: reasonColor(selectVal || null), background: 'var(--surface)', border: `1px solid ${needsReason ? '#fecaca' : 'var(--border)'}`, borderRadius: 5, padding: '3px 6px', cursor: 'pointer', maxWidth: 200 }}>
                            <option value="">— set reason —</option>
                            {options.map(rs => <option key={rs} value={rs}>{rs}</option>)}
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
                    {r.reverse_tracking_id && editingRevId === r.id ? (
                      // Editing an EXISTING reverse ID (customer returns — pickup IDs change across attempts).
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          value={revDraft[r.id]?.id ?? r.reverse_tracking_id ?? ''}
                          onChange={e => setRevDraft(p => ({ ...p, [r.id]: { id: e.target.value, courier: p[r.id]?.courier ?? r.reverse_courier ?? '' } }))}
                          style={{ width: 92, padding: '3px 6px', borderRadius: 5, border: '1px solid var(--accent)', background: 'var(--bg)', color: 'var(--text)', fontSize: 10, fontFamily: 'DM Mono', outline: 'none' }}
                        />
                        <select
                          value={revDraft[r.id]?.courier ?? r.reverse_courier ?? ''}
                          onChange={e => setRevDraft(p => ({ ...p, [r.id]: { id: p[r.id]?.id ?? r.reverse_tracking_id ?? '', courier: e.target.value } }))}
                          style={{ fontSize: 10, padding: '3px 4px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer' }}>
                          <option value="">courier</option>
                          <option value="Bluedart">BD</option>
                          <option value="Delhivery">DL</option>
                        </select>
                        <button
                          disabled={savingId === r.id || !(revDraft[r.id]?.id?.trim() ?? r.reverse_tracking_id)}
                          onClick={() => {
                            const d = revDraft[r.id]
                            const newId = (d?.id ?? r.reverse_tracking_id ?? '').trim()
                            const newCourier = d?.courier ?? r.reverse_courier ?? ''
                            // Changing the pickup ID resets the reverse tracking status (new AWB to sync).
                            patchReturn(r.id, { reverse_tracking_id: newId, reverse_courier: newCourier, reverse_tracking_status: null, reverse_tracking_label: null } as Partial<ReturnRow>)
                            setEditingRevId(null); setRevDraft(p => { const n = { ...p }; delete n[r.id]; return n })
                          }}
                          style={{ padding: '3px 7px', borderRadius: 5, border: 'none', fontSize: 10, fontWeight: 600, cursor: 'pointer', background: 'var(--dispatched)', color: '#fff' }}>✓</button>
                        <button onClick={() => { setEditingRevId(null); setRevDraft(p => { const n = { ...p }; delete n[r.id]; return n }) }}
                          style={{ padding: '3px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text3)', fontSize: 10, cursor: 'pointer' }}>✕</button>
                      </div>
                    ) : r.reverse_tracking_id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                          <span style={{ fontFamily: 'DM Mono', fontSize: 10, color: 'var(--text2)' }}>{r.reverse_tracking_id}</span>
                          <span style={{ fontSize: 10, color: r.reverse_tracking_status === 'delivered' ? 'var(--dispatched)' : r.reverse_tracking_status === 'rto' ? 'var(--critical)' : 'var(--text3)' }}>
                            {r.reverse_courier || ''}{r.reverse_tracking_label ? ` · ${r.reverse_tracking_label}` : (r.reverse_tracking_status ? ` · ${r.reverse_tracking_status}` : ' · not synced')}
                          </span>
                        </div>
                        {/* Customer returns: pickup ID changes across attempts — allow editing. RTO stays read-only. */}
                        {!(r.return_type === 'rto' || r.source === 'rto_auto' || r.source === 'rto') && !r.is_cancelled && (
                          <button onClick={() => setEditingRevId(r.id)} title="Edit reverse tracking ID"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, opacity: 0.5, display: 'flex', alignItems: 'center' }}
                            onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                            onMouseLeave={e => e.currentTarget.style.opacity = '0.5'}>
                            <Pencil size={10} />
                          </button>
                        )}
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
      </>)}
    </div>
  )
}

// ── Daily review: returns received per day + refund status, for the returns manager ──
function CancelledReview({ canSeeAmount, onOpenOrder }: { canSeeAmount: boolean; onOpenOrder: (order: DBOrder) => void }) {
  const supabase = createClient()
  const [orders, setOrders] = useState<DBOrder[]>([])
  const [retByOrder, setRetByOrder] = useState<Record<string, ReturnRow>>({})
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [win, setWin] = useState<'7d' | '30d' | 'custom'>('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [amtEdits, setAmtEdits] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const cancelled = await fetchAllRows<DBOrder>((from, to) =>
      supabase.from('dispatch_orders').select('*').eq('is_cancelled', true)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to))
    setOrders(cancelled)
    const { data: rets } = await supabase.from('returns').select('*').eq('source', 'cancelled')
    const map: Record<string, ReturnRow> = {}
    for (const r of (rets || []) as ReturnRow[]) if (r.order_id) map[r.order_id] = r
    setRetByOrder(map)
    setLoading(false)
  }, [supabase])
  useEffect(() => { load() }, [load])

  const platformOf = (oid: string) => { const t = (oid || '').trim(); if (/^\d{3}-\d{7}-\d{7}$/.test(t)) return 'Amazon'; if (t.startsWith('OD')) return 'Flipkart'; if (/^\d{4,6}$/.test(t)) return 'Website'; return 'Other' }
  const cancelDate = (o: DBOrder) => o.manual_cancelled_at || o.cancellation_requested_at || o.created_at || ''
  const orderAmount = (o: DBOrder) => (o.taxable_value || 0) + (o.tax_amount || 0)
  const dayKey = (iso: string) => iso ? iso.slice(0, 10) : ''
  const fmtDay = (key: string) => { const d = new Date(key + 'T00:00:00'); return isNaN(d.getTime()) ? key : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) }

  const range = useMemo<{ from: string | null; to: string | null }>(() => {
    const now = new Date(); const iso = (d: Date) => d.toISOString().slice(0, 10)
    if (win === '7d') return { from: iso(new Date(now.getTime() - 6 * 86400000)), to: null }
    if (win === '30d') return { from: iso(new Date(now.getTime() - 29 * 86400000)), to: null }
    return { from: customFrom || null, to: customTo || null }
  }, [win, customFrom, customTo])

  const inWindow = useMemo(() => orders.filter(o => {
    const k = dayKey(cancelDate(o))
    if (!k) return false
    if (range.from && k < range.from) return false
    if (range.to && k > range.to) return false
    return true
  }), [orders, range])

  const days = useMemo(() => {
    const g: Record<string, DBOrder[]> = {}
    for (const o of inWindow) { const k = dayKey(cancelDate(o)); (g[k] ||= []).push(o) }
    return Object.keys(g).sort((a, b) => b.localeCompare(a)).map(k => ({ key: k, orders: g[k] }))
  }, [inWindow])

  const totalPending = useMemo(() => inWindow.reduce((s, o) => { const r = retByOrder[o.order_id]; return (r && r.refund_status === 'refunded') ? s : s + orderAmount(o) }, 0), [inWindow, retByOrder])

  const markRefunded = async (o: DBOrder) => {
    setSavingId(o.id)
    const now = new Date().toISOString()
    const raw = amtEdits[o.order_id]
    const amt = raw != null ? (parseFloat(raw.replace(/[^0-9.]/g, '')) || 0) : orderAmount(o)
    const existing = retByOrder[o.order_id]
    try {
      if (existing) {
        const { data } = await supabase.from('returns').update({ refund_status: 'refunded', refund_amount: amt, refund_type: 'full', refunded_at: now, updated_at: now }).eq('id', existing.id).select().maybeSingle()
        if (data) setRetByOrder(prev => ({ ...prev, [o.order_id]: data as ReturnRow }))
      } else {
        const { data: auth } = await supabase.auth.getUser()
        const { data } = await supabase.from('returns').insert({
          order_id: o.order_id, source: 'cancelled', return_type: null, reason: 'Order cancelled',
          refund_status: 'refunded', refund_amount: amt, refund_type: 'full', refunded_at: now,
          invoice_amount: orderAmount(o) || null, warehouse_received: false, reverse_tracking_id: null,
          created_by: auth?.user?.id ?? null, created_by_email: auth?.user?.email ?? null, updated_at: now,
        }).select().maybeSingle()
        if (data) setRetByOrder(prev => ({ ...prev, [o.order_id]: data as ReturnRow }))
      }
      void logOrderEvent(o.order_id, 'return', 'Cancellation refund issued', `\u20b9${amt}`)
    } catch { /* surfaced via row state */ }
    setSavingId(null)
  }

  const undoRefund = async (o: DBOrder) => {
    const existing = retByOrder[o.order_id]; if (!existing) return
    setSavingId(o.id)
    const { data } = await supabase.from('returns').update({ refund_status: 'pending', refund_type: null, refunded_at: null, updated_at: new Date().toISOString() }).eq('id', existing.id).select().maybeSingle()
    if (data) setRetByOrder(prev => ({ ...prev, [o.order_id]: data as ReturnRow }))
    setSavingId(null)
  }

  const openOrder = async (orderId: string) => { const { data } = await supabase.from('dispatch_orders').select('*').eq('order_id', orderId).limit(1).maybeSingle(); if (data) onOpenOrder(data as DBOrder) }

  const winBtn = (k: '7d' | '30d' | 'custom', label: string) => (
    <button key={k} onClick={() => setWin(k)} style={{ padding: '6px 14px', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 700, border: win === k ? '2px solid var(--accent)' : '1px solid var(--border)', background: win === k ? 'var(--accent-bg)' : 'var(--surface)', color: win === k ? 'var(--accent)' : 'var(--text2)' }}>{label}</button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' as const }}>
        {winBtn('7d', 'Last 7 days')}{winBtn('30d', 'Last 30 days')}{winBtn('custom', 'Custom')}
        {win === 'custom' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }} />
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>to</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }} />
          </div>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text3)', fontFamily: 'DM Mono' }}>
          {inWindow.length} cancelled{canSeeAmount ? ` \u00b7 \u20b9${totalPending.toLocaleString('en-IN')} to refund` : ''}
        </span>
      </div>

      {loading ? (
        <div style={{ ...card, padding: 40, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading cancelled orders…</div>
      ) : days.length === 0 ? (
        <div style={{ ...card, padding: 40, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No cancelled orders in this window.</div>
      ) : days.map(({ key, orders: dayOrders }) => {
        const isOpen = collapsed[key] !== true
        const dayPending = dayOrders.reduce((s, o) => { const r = retByOrder[o.order_id]; return (r && r.refund_status === 'refunded') ? s : s + orderAmount(o) }, 0)
        const allRefunded = dayOrders.every(o => retByOrder[o.order_id]?.refund_status === 'refunded')
        return (
          <div key={key} style={{ ...card, overflow: 'hidden' }}>
            <button onClick={() => setCollapsed(prev => ({ ...prev, [key]: prev[key] !== true }))}
              style={{ width: '100%', textAlign: 'left' as const, padding: '10px 16px', background: 'var(--bg2)', border: 'none', borderBottom: isOpen ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              {isOpen ? <ChevronDown size={16} style={{ color: 'var(--text3)' }} /> : <ChevronRight size={16} style={{ color: 'var(--text3)' }} />}
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{fmtDay(key)}</span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{dayOrders.length} cancelled</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'DM Mono', fontSize: 13, color: allRefunded ? 'var(--dispatched)' : 'var(--today)' }}>
                {allRefunded ? 'all refunded' : canSeeAmount ? `\u20b9${dayPending.toLocaleString('en-IN')} pending` : `${dayOrders.filter(o => retByOrder[o.order_id]?.refund_status !== 'refunded').length} pending`}
              </span>
            </button>
            {isOpen && dayOrders.map((o, i) => {
              const r = retByOrder[o.order_id]
              const refunded = r?.refund_status === 'refunded'
              const amtVal = amtEdits[o.order_id] ?? String(orderAmount(o))
              return (
                <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderTop: i === 0 ? 'none' : '1px solid var(--border)', background: refunded ? 'var(--dispatched-bg)' : 'transparent' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, color: 'var(--text)' }}>{o.customer_name || '—'}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' as const }}>
                      <span onClick={() => openOrder(o.order_id)} style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--accent)', cursor: 'pointer' }}>{o.order_id.length > 20 ? o.order_id.slice(0, 20) + '\u2026' : o.order_id}</span>
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{platformOf(o.order_id)}</span>
                      <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{o.sku}</span>
                    </div>
                  </div>
                  {canSeeAmount && (refunded
                    ? <span style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--dispatched)', width: 92, textAlign: 'right' as const }}>\u20b9{(r?.refund_amount ?? orderAmount(o)).toLocaleString('en-IN')}</span>
                    : <input value={amtVal} onChange={e => setAmtEdits(prev => ({ ...prev, [o.order_id]: e.target.value }))}
                        style={{ width: 92, textAlign: 'right' as const, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontFamily: 'DM Mono' }} />)}
                  {refunded ? (
                    <button onClick={() => undoRefund(o)} disabled={savingId === o.id}
                      style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{savingId === o.id ? '…' : 'Undo'}</button>
                  ) : (
                    <button onClick={() => markRefunded(o)} disabled={savingId === o.id}
                      style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--dispatched)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' as const }}><CheckCircle size={14} /> {savingId === o.id ? 'Saving…' : 'Mark refunded'}</button>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function DailyReview({ returns, canSeeAmount, savingId, onRefund, onOpenOrder }: {
  returns: ReturnRow[]
  canSeeAmount: boolean
  savingId: string | null
  onRefund: (id: string, patch: Partial<ReturnRow>) => void
  onOpenOrder: (order: DBOrder) => void
}) {
  const supabase = createClient()
  const [win, setWin] = useState<'7d' | '30d' | 'custom'>('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({})

  // Returns data only carries order_id; the history panel needs a full DBOrder, so look it up.
  const openOrder = useCallback(async (orderId: string) => {
    const { data } = await supabase.from('dispatch_orders').select('*').eq('order_id', orderId).limit(1).maybeSingle()
    if (data) onOpenOrder(data as DBOrder)
  }, [supabase, onOpenOrder])

  const platformOf = (oid: string) => {
    const t = (oid || '').trim()
    if (/^\d{3}-\d{7}-\d{7}$/.test(t)) return 'Amazon'
    if (t.startsWith('OD')) return 'Flipkart'
    if (/^\d{4,6}$/.test(t)) return 'Website'
    return 'Other'
  }
  const dayKey = (iso: string | null) => iso ? iso.slice(0, 10) : ''
  const fmtDay = (key: string) => { const d = new Date(key + 'T00:00:00'); return isNaN(d.getTime()) ? key : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) }
  const fmtTime = (iso: string | null) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }

  // Window bounds on the received DATE.
  const range = useMemo<{ from: string | null; to: string | null }>(() => {
    const now = new Date()
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    if (win === '7d') return { from: iso(new Date(now.getTime() - 6 * 86400000)), to: null }
    if (win === '30d') return { from: iso(new Date(now.getTime() - 29 * 86400000)), to: null }
    return { from: customFrom || null, to: customTo || null }
  }, [win, customFrom, customTo])

  // Only received returns, within the window.
  const receivedInWindow = useMemo(() => {
    return returns.filter(r => {
      if (!r.warehouse_received || !r.warehouse_received_at) return false
      const k = dayKey(r.warehouse_received_at)
      if (range.from && k < range.from) return false
      if (range.to && k > range.to) return false
      return true
    })
  }, [returns, range])

  // Column sort/filter layered on top of the window (same machinery as the main list).
  const cols = useMemo(() => returnCols(canSeeAmount), [canSeeAmount])
  const flt = useReturnFilters(receivedInWindow, cols)
  const received = flt.filtered

  const days = useMemo(() => {
    const m: Record<string, ReturnRow[]> = {}
    for (const r of received) { const k = dayKey(r.warehouse_received_at); (m[k] ??= []).push(r) }
    return Object.keys(m).sort((a, b) => b.localeCompare(a)).map(k => ({ key: k, rows: m[k] }))
  }, [received])

  const totals = useMemo(() => {
    const pending = received.filter(r => r.refund_status === 'pending')
    return {
      received: received.length,
      pending: pending.length,
      refunded: received.filter(r => r.refund_status === 'refunded').length,
      pendingValue: pending.reduce((s, r) => s + (r.refund_amount || r.invoice_amount || 0), 0),
    }
  }, [received])

  const toggle = (k: string) => setOpenDays(p => ({ ...p, [k]: !(p[k] ?? false) }))
  const money = (n: number) => Math.round(n).toLocaleString('en-IN')

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
      {/* Window selector */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
        <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 700 }}>Received:</span>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {([['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['custom', 'Custom']] as [typeof win, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setWin(key)} style={{
              padding: '5px 11px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: win === key ? 'var(--accent)' : 'transparent', color: win === key ? '#fff' : 'var(--text2)',
            }}>{label}</button>
          ))}
        </div>
        {win === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }} />
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>→</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }} />
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>
        <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: '10px 14px' }}><div style={{ fontSize: 12, color: 'var(--text3)' }}>Received</div><div style={{ fontSize: 22, fontWeight: 800 }}>{totals.received}</div></div>
        <div style={{ background: 'var(--today-bg)', borderRadius: 8, padding: '10px 14px' }}><div style={{ fontSize: 12, color: 'var(--today)' }}>Refund pending</div><div style={{ fontSize: 22, fontWeight: 800, color: 'var(--today)' }}>{totals.pending}</div></div>
        <div style={{ background: 'var(--dispatched-bg)', borderRadius: 8, padding: '10px 14px' }}><div style={{ fontSize: 12, color: 'var(--dispatched)' }}>Refunded</div><div style={{ fontSize: 22, fontWeight: 800, color: 'var(--dispatched)' }}>{totals.refunded}</div></div>
        {canSeeAmount && <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: '10px 14px' }}><div style={{ fontSize: 12, color: 'var(--text3)' }}>Pending value</div><div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'DM Mono' }}>₹{money(totals.pendingValue)}</div></div>}
      </div>

      {/* Filter / sort bar — same machinery as the main list; filters re-group the days below. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
        <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 700 }}>Filter / sort:</span>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'visible' as const }}>
          <table style={{ borderCollapse: 'collapse' as const }}>
            <thead><tr>{cols.map(c => <RetHeaderCell key={c.key} col={c} ctx={flt} />)}</tr></thead>
          </table>
        </div>
        {flt.anyFilter && <button onClick={flt.clearAll} style={{ padding: '5px 11px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}><X size={12} /> Clear filters</button>}
      </div>

      {!days.length ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>{flt.anyFilter ? 'No received returns match the current filters.' : 'No returns received in this window.'}</div>
      ) : days.map(({ key, rows }) => {
        const open = openDays[key] ?? (key === days[0].key)  // first day open by default
        const pend = rows.filter(r => r.refund_status === 'pending').length
        const refd = rows.filter(r => r.refund_status === 'refunded').length
        const pval = rows.filter(r => r.refund_status === 'pending').reduce((s, r) => s + (r.refund_amount || r.invoice_amount || 0), 0)
        return (
          <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            <div onClick={() => toggle(key)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--bg2)', cursor: 'pointer' }}>
              <span style={{ display: 'inline-flex', transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none' }}><ChevronRight size={15} /></span>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{fmtDay(key)}</span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{rows.length} received</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
                {pend > 0 && <span style={{ background: 'var(--today-bg)', color: 'var(--today)', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>{pend} pending</span>}
                {refd > 0 && <span style={{ background: 'var(--dispatched-bg)', color: 'var(--dispatched)', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>{refd} refunded</span>}
                {canSeeAmount && pval > 0 && <span style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' }}>₹{money(pval)} pend.</span>}
              </div>
            </div>
            {open && (
              <div style={{ overflowX: 'auto' as const }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 720 }}>
                  <thead style={{ background: 'var(--surface)' }}>
                    <tr>{['Order', 'Platform', 'SKU', 'Reverse AWB', 'Type', 'Received at', 'Handled by', 'Refund', ''].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: h === 'Refund' || h === '' ? 'right' as const : 'left' as const, fontSize: 11, fontWeight: 700, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const refunded = r.refund_status === 'refunded'
                      return (
                        <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '7px 10px' }}><span onClick={() => openOrder(r.order_id ?? '')} style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--accent)', cursor: 'pointer' }}>{r.order_id}</span></td>
                          <td style={{ padding: '7px 10px', color: 'var(--text2)' }}>{platformOf(r.order_id ?? '')}</td>
                          <td style={{ padding: '7px 10px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{r.barcode || '—'}</td>
                          <td style={{ padding: '7px 10px', fontFamily: 'DM Mono', fontSize: 11 }}>{r.reverse_tracking_id ? (() => {
                            const url = r.reverse_courier === 'Bluedart' ? `https://www.bluedart.com/trackdartresultthirdparty?trackFor=0&trackNo=${r.reverse_tracking_id}` : r.reverse_courier === 'Delhivery' ? `https://www.delhivery.com/track/package/${r.reverse_tracking_id}` : null
                            return url
                              ? <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)', textDecoration: 'none' }} onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')} onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>{r.reverse_tracking_id} <ExternalLink size={9} /></a>
                              : <span style={{ color: 'var(--text2)' }}>{r.reverse_tracking_id}</span>
                          })() : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                          <td style={{ padding: '7px 10px', color: 'var(--text2)', textTransform: 'capitalize' as const }}>{r.return_type || r.source.replace('_', ' ')}</td>
                          <td style={{ padding: '7px 10px', color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{fmtTime(r.warehouse_received_at)}</td>
                          <td style={{ padding: '7px 10px', color: 'var(--text3)', fontSize: 11 }}>{r.created_by_email ? r.created_by_email.split('@')[0] : '—'}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' as const }}>
                            {refunded ? (
                              <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-end', gap: 1 }}>
                                <span style={{ background: 'var(--dispatched-bg)', color: 'var(--dispatched)', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3 }}><CheckCircle size={11} /> Refunded</span>
                                <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{r.refund_type ? r.refund_type.toUpperCase() : ''}{canSeeAmount && r.refund_amount ? ` ₹${money(r.refund_amount)}` : ''} · {fmtTime(r.refunded_at)}</span>
                              </div>
                            ) : (
                              <span style={{ background: 'var(--today-bg)', color: 'var(--today)', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Clock size={11} /> Pending</span>
                            )}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' as const }}>
                            <button onClick={() => onRefund(r.id, refunded
                              ? { refund_status: 'pending', refund_type: null, refunded_at: null } as Partial<ReturnRow>
                              : { refund_status: 'refunded', refund_type: (r.refund_type || 'full'), refunded_at: new Date().toISOString() } as Partial<ReturnRow>)}
                              disabled={savingId === r.id}
                              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: refunded ? 'var(--text3)' : 'var(--dispatched)', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' as const }}>
                              {refunded ? 'Undo' : 'Mark refunded'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
