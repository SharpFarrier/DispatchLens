'use client'
import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { DBOrder } from '@/types'
import { Phone, MessageCircle, ChevronDown, ChevronRight, Check, ArrowUp, ArrowDown, Filter, X, Users, Lock, Unlock, AlertTriangle, RotateCcw } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

const CALLERS = ['Vishaka', 'Priyanka'] as const
const PREDISPATCH_DISPOSITIONS = ['Confirmed', 'WhatsApp-confirmed', 'Cancelled', 'Hold', 'No answer', 'Call back later'] as const
const DELAY_DISPOSITIONS = ['Okay with delay', 'Wants to cancel', 'No answer', 'Call back', 'Escalate'] as const

// Dispositions that require a confirm step + mandatory note before committing.
const CONFIRM_NOTE_DISP = new Set(['Cancelled', 'Hold', 'Wants to cancel'])
// Disposition that requires a mandatory note (no confirm step).
const NOTE_ONLY_DISP = new Set(['Escalate'])
// Dispositions that "lock" an order (greyed at bottom, dropdown disabled).
const LOCKING_DISP = new Set(['Confirmed', 'WhatsApp-confirmed', 'Okay with delay'])

interface CallLog { id: string; order_id: string; queue: string; channel: string; disposition: string | null; note: string | null; caller: string | null; created_at: string }

function deliveryDaysLeft(o: DBOrder): number | null {
  if (!o.promise_date) return null
  const promise = new Date(o.promise_date + 'T00:00:00').getTime()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((promise - today.getTime()) / 86400000)
}

// ── Two independent status dimensions ──
// Confirmation (customer): from confirmation_status.
function confirmationBadge(o: DBOrder): { label: string; fg: string; bg: string } | null {
  switch (o.confirmation_status) {
    case 'confirmed': return { label: 'Confirmed', fg: 'var(--dispatched)', bg: 'var(--dispatched-bg)' }
    case 'whatsapp_confirmed': return { label: 'WhatsApp ✓', fg: '#16a34a', bg: '#f0fdf4' }
    case 'hold': return { label: 'Hold', fg: 'var(--today)', bg: 'var(--today-bg)' }
    case 'cancelled': return { label: 'Cancelled', fg: 'var(--critical)', bg: 'var(--critical-bg)' }
    default: return null
  }
}
// Dispatch (operational): same vocabulary as All Orders tab.
function dispatchStatus(o: DBOrder): { label: string; fg: string; bg: string } {
  if (o.is_cancelled) return { label: 'Cancelled', fg: 'var(--critical)', bg: 'var(--critical-bg)' }
  if (o.is_dispatched) return { label: 'Dispatched', fg: '#7c3aed', bg: '#f5f3ff' }
  if (o.plan_decision === 'hold') return { label: 'Hold', fg: 'var(--today)', bg: 'var(--today-bg)' }
  if (o.plan_decision === 'scheduled' && o.scheduled_date) return { label: `Scheduled · ${fmtDate(o.scheduled_date)}`, fg: '#2563eb', bg: '#eff6ff' }
  if (o.plan_decision === 'scheduled') return { label: 'Scheduled', fg: '#2563eb', bg: '#eff6ff' }
  return { label: 'Imported', fg: 'var(--text2)', bg: 'var(--bg2)' }
}
function fmtDate(d: string | null | undefined) { return d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—' }
const fmtTime = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const todayStr = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString().slice(0, 10) }

type Queue = 'predispatch' | 'callbacks' | 'delay'
interface Row { o: DBOrder }
interface Col { key: string; label: string; type: 'text' | 'category' | 'date' | 'number'; get: (r: Row) => string | number; render?: (r: Row) => React.ReactNode; queues?: Queue[] }

export default function CallLensTab({ currentUserEmail }: { currentUserEmail: string }) {
  const supabase = createClient()
  const [orders, setOrders] = useState<DBOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [queue, setQueue] = useState<Queue>('predispatch')
  const [logs, setLogs] = useState<Record<string, CallLog[]>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  // Disposition draft per order: disposition + note + optional callback date.
  const [dispDraft, setDispDraft] = useState<Record<string, { disp: string; note: string; callbackDate: string }>>({})
  // Which order is in a confirm-step (awaiting the confirm click).
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null)
  // Unlock reason draft per order.
  const [unlockDraft, setUnlockDraft] = useState<Record<string, string>>({})
  const [unlockingFor, setUnlockingFor] = useState<string | null>(null)
  // "Mark as return" confirm (delay cancellation requests).
  const [returningFor, setReturningFor] = useState<string | null>(null)
  // sort + filter
  const [sortKey, setSortKey] = useState<string>('order_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [openFilter, setOpenFilter] = useState<string | null>(null)
  const [textFilters, setTextFilters] = useState<Record<string, string>>({})
  const [catFilters, setCatFilters] = useState<Record<string, string[]>>({})
  const popRef = useRef<HTMLDivElement>(null)
  // selection + bulk
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkCaller, setBulkCaller] = useState<string>('')
  const [bulkSaving, setBulkSaving] = useState(false)

  useEffect(() => {
    if (!openFilter) return
    const h = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpenFilter(null) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [openFilter])

  const load = useCallback(async () => {
    setLoading(true)
    const rows = await fetchAllRows<DBOrder>((from, to) =>
      supabase.from('dispatch_orders').select('*')
        .order('order_date', { ascending: false }).order('id', { ascending: false }).range(from, to))
    setOrders(rows); setLoading(false)
  }, [supabase])
  useEffect(() => { load() }, [load])
  useEffect(() => { setSelected(new Set()); setOpenFilter(null); setConfirmingFor(null); setUnlockingFor(null); setReturningFor(null) }, [queue])

  const notInTransit = useMemo(() => new Set(['delivered', 'rto', 'returned', 'return to origin', 'rto delivered', 'rto initiated', 'cancelled', 'lost']), [])

  // Queue membership.
  const inPreDispatch = useCallback((o: DBOrder) => !o.is_dispatched && !o.is_cancelled && !o.callback_date, [])
  const inCallbacks = useCallback((o: DBOrder) => !!o.callback_date && !o.is_dispatched && !o.is_cancelled, [])
  const inDelay = useCallback((o: DBOrder) => o.is_dispatched && !notInTransit.has((o.tracking_status || '').toLowerCase()), [notInTransit])

  const base: Row[] = useMemo(() => {
    const pred = queue === 'predispatch' ? inPreDispatch : queue === 'callbacks' ? inCallbacks : inDelay
    return orders.filter(pred).map(o => ({ o }))
  }, [orders, queue, inPreDispatch, inCallbacks, inDelay])

  const counts = useMemo(() => ({
    pre: orders.filter(inPreDispatch).length,
    cb: orders.filter(inCallbacks).length,
    del: orders.filter(inDelay).length,
  }), [orders, inPreDispatch, inCallbacks, inDelay])

  // "locked" = an order that's been actioned into a terminal-for-this-queue confirmation state.
  const isLocked = useCallback((o: DBOrder): boolean => {
    if (queue === 'predispatch') return o.confirmation_status === 'confirmed' || o.confirmation_status === 'whatsapp_confirmed'
    if (queue === 'delay') return o.last_disposition === 'Okay with delay'
    return false
  }, [queue])

  const COLS: Col[] = useMemo(() => [
    { key: 'order_date', label: 'Order Date', type: 'date', get: r => r.o.order_date || '', render: r => fmtDate(r.o.order_date) },
    { key: 'dispatch_by', label: 'Dispatch By', type: 'date', get: r => r.o.dispatch_by_date || '', render: r => { const d = r.o.dispatch_by_date; if (!d) return <span style={{ color: 'var(--text3)' }}>—</span>; const overdue = d < todayStr(); const due = d === todayStr(); return <span style={{ fontFamily: 'DM Mono', fontWeight: 700, color: overdue ? 'var(--critical)' : due ? 'var(--today)' : 'var(--text2)' }}>{new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span> } },
    { key: 'callback_date', label: 'Callback', type: 'date', queues: ['callbacks'], get: r => r.o.callback_date || '', render: r => { const d = r.o.callback_date; if (!d) return '—'; const overdue = d < todayStr(); const due = d === todayStr(); return <span style={{ fontFamily: 'DM Mono', fontWeight: 700, color: overdue ? 'var(--critical)' : due ? 'var(--today)' : 'var(--text2)' }}>{overdue ? `${fmtDate(d)} · overdue` : due ? `${fmtDate(d)} · today` : fmtDate(d)}</span> } },
    { key: 'order_id', label: 'Order', type: 'text', get: r => r.o.order_id },
    { key: 'customer', label: 'Customer', type: 'text', get: r => r.o.customer_name || '' },
    { key: 'sku', label: 'SKU', type: 'text', get: r => r.o.sku || '' },
    { key: 'contact', label: 'Contact', type: 'text', get: r => r.o.contact_number || '', render: r => r.o.contact_number ? <a href={`tel:${r.o.contact_number}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{r.o.contact_number}</a> : '—' },
    { key: 'confirmation', label: 'Confirmation', type: 'category', queues: ['predispatch', 'callbacks'], get: r => confirmationBadge(r.o)?.label || '(pending)', render: r => { const b = confirmationBadge(r.o); return b ? <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: b.fg, background: b.bg, padding: '2px 7px', borderRadius: 4 }}>{b.label}</span> : <span style={{ color: 'var(--text3)', fontSize: 11 }}>pending</span> } },
    { key: 'dispatch', label: 'Dispatch', type: 'category', get: r => dispatchStatus(r.o).label, render: r => { const s = dispatchStatus(r.o); return <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: s.fg, background: s.bg, padding: '2px 7px', borderRadius: 4 }}>{s.label}</span> } },
    { key: 'flags', label: 'Flags', type: 'category', queues: ['delay'], get: r => r.o.cancellation_requested ? 'Cancellation requested' : r.o.escalated ? 'Escalated' : '(none)', render: r => (<span style={{ display: 'inline-flex', gap: 4 }}>
        {r.o.cancellation_requested && <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--critical)', background: 'var(--critical-bg)', padding: '2px 7px', borderRadius: 4 }}>Cancel req</span>}
        {r.o.escalated && <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: '#b45309', background: '#fff7ed', padding: '2px 7px', borderRadius: 4 }}>Escalated</span>}
        {!r.o.cancellation_requested && !r.o.escalated && <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}
      </span>) },
    { key: 'promise', label: 'Promise', type: 'date', queues: ['delay'], get: r => r.o.promise_date || '', render: r => fmtDate(r.o.promise_date) },
    { key: 'dispatched', label: 'Dispatched', type: 'date', queues: ['delay'], get: r => r.o.dispatched_at || '', render: r => fmtDate(r.o.dispatched_at) },
    { key: 'delivery', label: 'Delivery', type: 'number', queues: ['delay'], get: r => { const d = deliveryDaysLeft(r.o); return d === null ? 9999 : d }, render: r => { const dl = deliveryDaysLeft(r.o); if (dl === null) return '—'; const c = dl < 0 ? 'var(--critical)' : dl <= 1 ? 'var(--today)' : 'var(--dispatched)'; const t = dl < 0 ? `${Math.abs(dl)}d overdue` : dl === 0 ? 'due today' : `${dl}d left`; return <span style={{ fontFamily: 'DM Mono', fontWeight: 700, color: c }}>{t}</span> } },
    { key: 'caller', label: 'Caller', type: 'category', get: r => r.o.assigned_caller || '(none)' },
    { key: 'last_disposition', label: 'Last disp.', type: 'category', get: r => r.o.last_disposition || '(none)', render: r => r.o.last_disposition ? <span style={{ fontSize: 11, color: 'var(--text2)' }}>{r.o.last_disposition}</span> : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span> },
  ], [])

  const activeCols = useMemo(() => COLS.filter(c => !c.queues || c.queues.includes(queue)), [COLS, queue])
  const colByKey = useMemo(() => Object.fromEntries(COLS.map(c => [c.key, c])), [COLS])

  const catOptions = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const c of activeCols) if (c.type === 'category') {
      const set = new Set<string>()
      for (const r of base) set.add(String(c.get(r)) || '(blank)')
      m[c.key] = Array.from(set).sort()
    }
    return m
  }, [activeCols, base])

  const rows = useMemo(() => {
    let out = base.filter(r => {
      for (const key in textFilters) { const v = textFilters[key]; if (!v) continue; const col = colByKey[key]; if (col && !String(col.get(r)).toLowerCase().includes(v.toLowerCase())) return false }
      for (const key in catFilters) { const a = catFilters[key]; if (!a || !a.length) continue; const col = colByKey[key]; if (col && !a.includes(String(col.get(r)) || '(blank)')) return false }
      return true
    })
    // Sort — but always push locked rows to the bottom.
    const col = colByKey[sortKey]
    out = [...out].sort((a, b) => {
      const la = isLocked(a.o) ? 1 : 0, lb = isLocked(b.o) ? 1 : 0
      if (la !== lb) return la - lb  // locked go last
      if (!col) return 0
      const va = col.get(a), vb = col.get(b)
      const cmp = col.type === 'number' ? (va as number) - (vb as number) : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return out
  }, [base, colByKey, textFilters, catFilters, sortKey, sortDir, isLocked])

  const toggleSort = (key: string) => { if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir('asc') } }
  const hasFilter = (key: string) => !!textFilters[key] || (catFilters[key]?.length ?? 0) > 0
  const anyFilter = Object.values(textFilters).some(Boolean) || Object.values(catFilters).some(a => a?.length)
  const clearAll = () => { setTextFilters({}); setCatFilters({}) }

  const allFilteredIds = useMemo(() => rows.map(r => r.o.order_id), [rows])
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every(id => selected.has(id))
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(allFilteredIds))
  const toggleRow = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const bulkReassign = async () => {
    if (!bulkCaller || selected.size === 0) return
    setBulkSaving(true)
    try {
      const ids = Array.from(selected); const now = new Date().toISOString()
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200)
        await supabase.from('dispatch_orders').update({ assigned_caller: bulkCaller, updated_at: now }).in('order_id', chunk)
      }
      setOrders(prev => prev.map(o => selected.has(o.order_id) ? { ...o, assigned_caller: bulkCaller } as DBOrder : o))
      setSelected(new Set()); setBulkCaller('')
    } finally { setBulkSaving(false) }
  }

  const loadLogs = useCallback(async (orderId: string) => {
    const { data } = await supabase.from('call_logs').select('*').eq('order_id', orderId).order('created_at', { ascending: false })
    setLogs(prev => ({ ...prev, [orderId]: (data as CallLog[]) || [] }))
  }, [supabase])
  const toggleExpand = (orderId: string) => { if (expanded === orderId) { setExpanded(null); return } setExpanded(orderId); if (!logs[orderId]) loadLogs(orderId) }

  const dispositions = queue === 'delay' ? DELAY_DISPOSITIONS : PREDISPATCH_DISPOSITIONS

  const draftFor = (id: string) => dispDraft[id] || { disp: '', note: '', callbackDate: '' }
  const setDraft = (id: string, patch: Partial<{ disp: string; note: string; callbackDate: string }>) =>
    setDispDraft(prev => ({ ...prev, [id]: { ...draftFor(id), ...patch } }))

  const logDisposition = async (o: DBOrder, disp: string, note: string, channel = 'call') => {
    await supabase.from('call_logs').insert({ order_id: o.order_id, queue, channel, disposition: disp, note: note || null, caller: o.assigned_caller || null, created_by_email: currentUserEmail })
  }

  // Commit a disposition (after any confirm/note gating already satisfied).
  const commitDisposition = async (o: DBOrder) => {
    const d = draftFor(o.order_id)
    if (!d.disp) return
    setSaving(o.order_id)
    try {
      const now = new Date().toISOString()
      const patch: Record<string, unknown> = { last_disposition: d.disp, last_disposition_at: now, updated_at: now }

      if (queue === 'predispatch' || queue === 'callbacks') {
        if (d.disp === 'Confirmed') { patch.confirmation_status = 'confirmed'; patch.confirmation_at = now; patch.callback_date = null }
        else if (d.disp === 'WhatsApp-confirmed') { patch.confirmation_status = 'whatsapp_confirmed'; patch.confirmation_at = now; patch.callback_date = null }
        else if (d.disp === 'Cancelled') { patch.confirmation_status = 'cancelled'; patch.confirmation_at = now; patch.is_cancelled = true; patch.manual_cancelled = true; patch.manual_cancelled_at = now; patch.callback_date = null }
        else if (d.disp === 'Hold') { patch.confirmation_status = 'hold'; patch.confirmation_at = now; patch.plan_decision = 'hold'; patch.scheduled_date = null; patch.callback_date = null }
        else if (d.disp === 'No answer') { /* log only */ }
        else if (d.disp === 'Call back later') { patch.callback_date = d.callbackDate || todayStr() }
      } else { // delay
        if (d.disp === 'Okay with delay') { /* lock via last_disposition */ }
        else if (d.disp === 'Wants to cancel') { patch.cancellation_requested = true; patch.cancellation_requested_at = now }
        else if (d.disp === 'No answer') { /* log only */ }
        else if (d.disp === 'Call back') { patch.callback_date = d.callbackDate || todayStr() }
        else if (d.disp === 'Escalate') { patch.escalated = true; patch.escalated_at = now }
      }

      await logDisposition(o, d.disp, d.note)
      await supabase.from('dispatch_orders').update(patch).eq('order_id', o.order_id)
      setOrders(prev => prev.map(x => x.order_id === o.order_id ? { ...x, ...patch } as DBOrder : x))
      setDispDraft(prev => { const n = { ...prev }; delete n[o.order_id]; return n })
      setConfirmingFor(null)
      if (logs[o.order_id]) loadLogs(o.order_id)
    } finally { setSaving(null) }
  }

  // Called on Save click — routes through confirm-step / note gating.
  const onSaveDisposition = (o: DBOrder) => {
    const d = draftFor(o.order_id)
    if (!d.disp) return
    if ((CONFIRM_NOTE_DISP.has(d.disp) || NOTE_ONLY_DISP.has(d.disp)) && !d.note.trim()) return // note required
    if (CONFIRM_NOTE_DISP.has(d.disp) && confirmingFor !== o.order_id) { setConfirmingFor(o.order_id); return } // ask confirm
    commitDisposition(o)
  }

  // Unlock a confirmed (locked) order with mandatory reason.
  const unlockOrder = async (o: DBOrder) => {
    const reason = (unlockDraft[o.order_id] || '').trim()
    if (!reason) return
    setSaving(o.order_id)
    try {
      const now = new Date().toISOString()
      await logDisposition(o, 'Unlocked', reason)
      const patch = { confirmation_status: null, confirmation_at: null, last_disposition: 'Unlocked', last_disposition_at: now, updated_at: now }
      await supabase.from('dispatch_orders').update(patch).eq('order_id', o.order_id)
      setOrders(prev => prev.map(x => x.order_id === o.order_id ? { ...x, ...patch } as DBOrder : x))
      setUnlockingFor(null); setUnlockDraft(prev => { const n = { ...prev }; delete n[o.order_id]; return n })
      if (logs[o.order_id]) loadLogs(o.order_id)
    } finally { setSaving(null) }
  }

  // Logistics: mark a cancellation-requested order as a return (confirm-gated).
  const markAsReturn = async (o: DBOrder) => {
    setSaving(o.order_id)
    try {
      const now = new Date().toISOString()
      const { data: { user } } = await supabase.auth.getUser()
      await supabase.from('returns').upsert({
        order_id: o.order_id, source: 'rto', return_type: 'rto',
        reason: 'Customer cancellation (in-transit)',
        barcode: o.scanned_barcode || null,
        reverse_tracking_id: o.tracking_number || null,
        reverse_courier: o.courier || null,
        notes: 'Created from CallLens delay cancellation request',
        created_by: user?.id ?? null, created_by_email: user?.email ?? null,
        updated_at: now,
      }, { onConflict: 'order_id' })
      await logDisposition(o, 'Marked as return', 'Logistics confirmed RTO / return')
      // Clear the cancellation-requested flag; the return record now owns it.
      // Set tracking_status to 'rto' so the order leaves the delay queue (which
      // excludes rto) and the Returns tab takes over.
      const patch = { cancellation_requested: false, tracking_status: 'rto', last_disposition: 'Marked as return', last_disposition_at: now, updated_at: now }
      await supabase.from('dispatch_orders').update(patch).eq('order_id', o.order_id)
      setOrders(prev => prev.map(x => x.order_id === o.order_id ? { ...x, ...patch } as DBOrder : x))
      setReturningFor(null)
      if (logs[o.order_id]) loadLogs(o.order_id)
    } finally { setSaving(null) }
  }

  const setCaller = async (o: DBOrder, caller: string) => {
    await supabase.from('dispatch_orders').update({ assigned_caller: caller, updated_at: new Date().toISOString() }).eq('order_id', o.order_id)
    setOrders(prev => prev.map(x => x.order_id === o.order_id ? { ...x, assigned_caller: caller } as DBOrder : x))
  }
  const toggleWhatsapp = async (o: DBOrder) => {
    const now = new Date().toISOString(); const next = !o.whatsapp_sent
    await supabase.from('dispatch_orders').update({ whatsapp_sent: next, whatsapp_sent_at: next ? now : null, updated_at: now }).eq('order_id', o.order_id)
    if (next) await supabase.from('call_logs').insert({ order_id: o.order_id, queue, channel: 'whatsapp', disposition: 'WhatsApp sent', caller: o.assigned_caller || null, created_by_email: currentUserEmail })
    setOrders(prev => prev.map(x => x.order_id === o.order_id ? { ...x, whatsapp_sent: next } as DBOrder : x))
    if (logs[o.order_id]) loadLogs(o.order_id)
  }

  const totalCols = activeCols.length + 4 // checkbox + WA + Disposition + log

  const QueueBtn = ({ q, label, n }: { q: Queue; label: string; n: number }) => (
    <button onClick={() => setQueue(q)} style={{ padding: '6px 12px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: queue === q ? 'var(--surface)' : 'transparent', color: queue === q ? 'var(--text)' : 'var(--text3)', boxShadow: queue === q ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
      {label} <b style={{ color: queue === q ? 'var(--accent)' : 'var(--text3)' }}>{n}</b>
    </button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>CallLens</h1>
        <div style={{ display: 'flex', gap: 3, background: 'var(--bg2)', padding: 3, borderRadius: 7 }}>
          <QueueBtn q="predispatch" label="Pre-dispatch confirm" n={counts.pre} />
          <QueueBtn q="callbacks" label="Callbacks" n={counts.cb} />
          <QueueBtn q="delay" label="Delay check" n={counts.del} />
        </div>
        <span style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--text3)' }}>{loading ? 'loading…' : `${rows.length} shown`}</span>
        {anyFilter && <button onClick={clearAll} style={{ padding: '5px 11px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}><X size={12} /> Clear filters</button>}
      </div>

      {selected.size > 0 && (
        <div style={{ ...card, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--accent-bg)', border: '1px solid var(--accent)' }}>
          <Users size={15} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>{selected.size} selected</span>
          <span style={{ fontSize: 13, color: 'var(--text2)' }}>Reassign to</span>
          <select value={bulkCaller} onChange={e => setBulkCaller(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, cursor: 'pointer' }}>
            <option value="">Choose caller…</option>{CALLERS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={bulkReassign} disabled={!bulkCaller || bulkSaving} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: bulkCaller ? 'var(--accent)' : 'var(--bg2)', color: bulkCaller ? '#fff' : 'var(--text3)', fontSize: 13, fontWeight: 700, cursor: bulkCaller ? 'pointer' : 'not-allowed' }}>{bulkSaving ? 'Reassigning…' : 'Reassign'}</button>
          <button onClick={() => setSelected(new Set())} style={{ marginLeft: 'auto', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 12, cursor: 'pointer' }}>Clear</button>
        </div>
      )}

      <div style={{ ...card, overflow: 'visible' }}>
        <div style={{ overflowX: 'auto' as const, overflowY: 'auto' as const, maxHeight: 'calc(100vh - 260px)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 1250 }}>
            <thead style={{ position: 'sticky' as const, top: 0, zIndex: 30 }}>
              <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '8px 10px', background: 'var(--bg2)', width: 34 }}><input type="checkbox" checked={allSelected} onChange={toggleSelectAll} title="Select all filtered" /></th>
                {activeCols.map(col => (
                  <th key={col.key} style={{ padding: '8px 10px', textAlign: 'left' as const, background: 'var(--bg2)', whiteSpace: 'nowrap' as const, position: 'relative' as const, userSelect: 'none' as const }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: sortKey === col.key ? 'var(--accent)' : 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        {col.label}{sortKey === col.key && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </span>
                      <button onClick={() => setOpenFilter(openFilter === col.key ? null : col.key)} title="Filter" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, display: 'inline-flex', color: hasFilter(col.key) ? 'var(--accent)' : 'var(--text3)', opacity: hasFilter(col.key) ? 1 : 0.45 }}><Filter size={11} /></button>
                    </div>
                    {openFilter === col.key && (
                      <div ref={popRef} style={{ position: 'absolute' as const, top: '100%', left: 0, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 10, zIndex: 50, minWidth: 170, textAlign: 'left' as const, fontFamily: 'DM Sans' }}>
                        {col.type === 'category' ? (
                          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3, maxHeight: 220, overflowY: 'auto' as const }}>
                            {(catOptions[col.key] || []).map(opt => { const cur = catFilters[col.key] || []; const on = cur.includes(opt); return (
                              <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text2)', cursor: 'pointer', padding: '2px 0' }}>
                                <input type="checkbox" checked={on} onChange={() => setCatFilters(prev => { const c = prev[col.key] || []; const next = c.includes(opt) ? c.filter(x => x !== opt) : [...c, opt]; return { ...prev, [col.key]: next } })} />{opt}
                              </label>) })}
                          </div>
                        ) : (
                          <input autoFocus value={textFilters[col.key] || ''} onChange={e => setTextFilters(prev => ({ ...prev, [col.key]: e.target.value }))} placeholder={`Filter ${col.label}…`} style={{ width: '100%', padding: '6px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const }} />
                        )}
                      </div>
                    )}
                  </th>
                ))}
                {['WA', 'Disposition', ''].map((h, i) => <th key={i} style={{ padding: '8px 10px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const, background: 'var(--bg2)' }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={totalCols} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={totalCols} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>No orders in this queue.</td></tr>
              ) : rows.map((r, i) => {
                const o = r.o
                const d = draftFor(o.order_id)
                const open = expanded === o.order_id
                const sel = selected.has(o.order_id)
                const locked = isLocked(o)
                const inConfirm = confirmingFor === o.order_id
                const inUnlock = unlockingFor === o.order_id
                const inReturn = returningFor === o.order_id
                const noteRequired = CONFIRM_NOTE_DISP.has(d.disp) || NOTE_ONLY_DISP.has(d.disp)
                const showCallbackDate = d.disp === 'Call back later' || d.disp === 'Call back'
                return (
                  <Fragment key={o.id}>
                    <tr style={{ borderBottom: open ? 'none' : '1px solid var(--border)', background: sel ? 'var(--accent-bg)' : locked ? 'var(--bg2)' : (i % 2 === 0 ? 'transparent' : 'var(--bg2)'), opacity: locked ? 0.6 : 1 }}>
                      <td style={{ padding: '8px 10px' }}><input type="checkbox" checked={sel} onChange={() => toggleRow(o.order_id)} /></td>
                      {activeCols.map(col => (
                        <td key={col.key} style={{ padding: '8px 10px', fontFamily: col.key === 'customer' ? 'DM Sans' : 'DM Mono', fontSize: 11, whiteSpace: 'nowrap' as const, color: 'var(--text)', maxWidth: col.key === 'customer' ? 150 : undefined, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {col.key === 'caller' ? (
                            <select value={o.assigned_caller || ''} onChange={e => setCaller(o, e.target.value)} style={{ fontSize: 11, padding: '3px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer' }}>
                              <option value="">—</option>{CALLERS.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          ) : col.render ? col.render(r) : String(col.get(r))}
                        </td>
                      ))}
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' as const }}>
                        <button onClick={() => toggleWhatsapp(o)} title="Toggle WhatsApp sent" style={{ background: 'none', border: 'none', cursor: 'pointer', color: o.whatsapp_sent ? '#16a34a' : 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 600 }}><MessageCircle size={13} /> {o.whatsapp_sent ? 'sent' : '—'}</button>
                      </td>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' as const, minWidth: 260 }}>
                        {locked ? (
                          // Locked → show lock + unlock affordance.
                          inUnlock ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <input autoFocus value={unlockDraft[o.order_id] || ''} onChange={e => setUnlockDraft(prev => ({ ...prev, [o.order_id]: e.target.value }))} placeholder="reason to reopen (required)…" style={{ fontSize: 11, padding: '4px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', width: 170, outline: 'none' }} />
                              <button onClick={() => unlockOrder(o)} disabled={saving === o.order_id || !(unlockDraft[o.order_id] || '').trim()} style={{ padding: '4px 8px', borderRadius: 5, border: 'none', background: (unlockDraft[o.order_id] || '').trim() ? 'var(--accent)' : 'var(--bg2)', color: (unlockDraft[o.order_id] || '').trim() ? '#fff' : 'var(--text3)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Reopen</button>
                              <button onClick={() => setUnlockingFor(null)} style={{ padding: '4px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 11, cursor: 'pointer' }}>Cancel</button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text3)', fontSize: 11 }}>
                              <Lock size={12} /> <span>{o.last_disposition || 'Actioned'}</span>
                              <button onClick={() => setUnlockingFor(o.order_id)} title="Reopen with reason" style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 6px', color: 'var(--accent)', fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Unlock size={11} /> Reopen</button>
                            </div>
                          )
                        ) : inConfirm ? (
                          // Confirm step for Cancelled / Hold / Wants to cancel.
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--critical-bg)', border: '1px solid #fecaca', borderRadius: 6, padding: '4px 8px' }}>
                            <AlertTriangle size={13} style={{ color: 'var(--critical)' }} />
                            <span style={{ fontSize: 11, color: 'var(--critical)', fontWeight: 600 }}>Confirm “{d.disp}”?</span>
                            <button onClick={() => commitDisposition(o)} disabled={saving === o.order_id} style={{ padding: '4px 9px', borderRadius: 5, border: 'none', background: 'var(--critical)', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{saving === o.order_id ? '…' : 'Yes'}</button>
                            <button onClick={() => setConfirmingFor(null)} style={{ padding: '4px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 11, cursor: 'pointer' }}>Back</button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' as const }}>
                            <select value={d.disp} onChange={e => setDraft(o.order_id, { disp: e.target.value })} style={{ fontSize: 11, padding: '4px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer' }}>
                              <option value="">{o.last_disposition ? `↻ ${o.last_disposition}` : 'Set disposition…'}</option>
                              {dispositions.map(dp => <option key={dp} value={dp}>{dp}</option>)}
                            </select>
                            {d.disp && (<>
                              {showCallbackDate && <input type="date" value={d.callbackDate} onChange={e => setDraft(o.order_id, { callbackDate: e.target.value })} title="Callback date (optional)" style={{ fontSize: 11, padding: '3px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />}
                              <input value={d.note} onChange={e => setDraft(o.order_id, { note: e.target.value })} placeholder={noteRequired ? 'note (required)…' : 'note…'} style={{ fontSize: 11, padding: '4px 7px', borderRadius: 5, border: `1px solid ${noteRequired && !d.note.trim() ? '#fecaca' : 'var(--border)'}`, background: 'var(--bg)', color: 'var(--text)', width: 120, outline: 'none' }} />
                              <button onClick={() => onSaveDisposition(o)} disabled={saving === o.order_id || (noteRequired && !d.note.trim())} style={{ padding: '4px 8px', borderRadius: 5, border: 'none', background: (noteRequired && !d.note.trim()) ? 'var(--bg2)' : 'var(--accent)', color: (noteRequired && !d.note.trim()) ? 'var(--text3)' : '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={11} /> {saving === o.order_id ? '…' : 'Save'}</button>
                            </>)}
                            {/* Logistics: Mark as return for cancellation-requested delay orders */}
                            {queue === 'delay' && o.cancellation_requested && !d.disp && (
                              inReturn ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--today-bg)', border: '1px solid #fed7aa', borderRadius: 6, padding: '3px 7px' }}>
                                  <span style={{ fontSize: 11, color: 'var(--today)', fontWeight: 600 }}>Create return?</span>
                                  <button onClick={() => markAsReturn(o)} disabled={saving === o.order_id} style={{ padding: '3px 8px', borderRadius: 5, border: 'none', background: 'var(--today)', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{saving === o.order_id ? '…' : 'Confirm'}</button>
                                  <button onClick={() => setReturningFor(null)} style={{ padding: '3px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 11, cursor: 'pointer' }}>Back</button>
                                </span>
                              ) : (
                                <button onClick={() => setReturningFor(o.order_id)} title="Logistics: coordinate RTO then create the return" style={{ padding: '4px 9px', borderRadius: 5, border: '1px solid #fed7aa', background: 'var(--today-bg)', color: 'var(--today)', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><RotateCcw size={11} /> Mark as return</button>
                              )
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' as const }}>
                        <button onClick={() => toggleExpand(o.order_id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11 }}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} log</button>
                      </td>
                    </tr>
                    {open && (
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                        <td colSpan={totalCols} style={{ padding: '4px 12px 14px 40px' }}>
                          {!logs[o.order_id] ? <span style={{ fontSize: 12, color: 'var(--text3)' }}>Loading history…</span>
                            : logs[o.order_id].length === 0 ? <span style={{ fontSize: 12, color: 'var(--text3)' }}>No calls or messages logged yet.</span>
                            : <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 14, display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                                {logs[o.order_id].map(l => (
                                  <div key={l.id} style={{ fontSize: 12, color: 'var(--text2)', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', color: l.channel === 'whatsapp' ? '#16a34a' : 'var(--accent)' }}>{l.channel === 'whatsapp' ? <MessageCircle size={12} /> : <Phone size={12} />}</span>
                                    <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{fmtTime(l.created_at)}</span>
                                    <span style={{ fontWeight: 600 }}>{l.disposition}</span>
                                    {l.note && <span style={{ color: 'var(--text3)' }}>· {l.note}</span>}
                                    {l.caller && <span style={{ color: 'var(--text3)', fontSize: 11 }}>· {l.caller}</span>}
                                  </div>
                                ))}
                              </div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
