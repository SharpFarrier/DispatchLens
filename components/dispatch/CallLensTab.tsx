'use client'
import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { DBOrder } from '@/types'
import { Phone, MessageCircle, ChevronDown, ChevronRight, Check, ArrowUp, ArrowDown, Filter, X, Users } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

const CALLERS = ['Vishaka', 'Priyanka'] as const
const PREDISPATCH_DISPOSITIONS = ['Confirmed', 'Cancelled', 'Hold', 'No answer', 'Call back later', 'WhatsApp-confirmed'] as const
const DELAY_DISPOSITIONS = ['Okay with delay', 'Wants to cancel', 'No answer', 'Call back', 'Escalate'] as const

interface CallLog { id: string; order_id: string; queue: string; channel: string; disposition: string | null; note: string | null; caller: string | null; created_at: string }

function deliveryDaysLeft(o: DBOrder): number | null {
  if (!o.promise_date) return null
  const promise = new Date(o.promise_date + 'T00:00:00').getTime()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((promise - today.getTime()) / 86400000)
}
function statusOf(o: DBOrder): { label: string; fg: string; bg: string } {
  if (o.is_cancelled) return { label: 'Cancelled', fg: 'var(--critical)', bg: 'var(--critical-bg)' }
  if (o.tracking_status === 'delivered') return { label: 'Delivered', fg: 'var(--dispatched)', bg: 'var(--dispatched-bg)' }
  if (o.is_dispatched) return { label: 'Dispatched', fg: '#7c3aed', bg: '#f5f3ff' }
  if (o.plan_decision === 'unfulfillable') return { label: 'Hold', fg: 'var(--today)', bg: 'var(--today-bg)' }
  if (o.plan_decision === 'scheduled') return { label: 'Scheduled', fg: '#2563eb', bg: '#eff6ff' }
  return { label: 'Imported', fg: 'var(--text2)', bg: 'var(--bg2)' }
}
const fmtDate = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'
const fmtTime = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

interface Row { o: DBOrder; status: string }
interface Col { key: string; label: string; type: 'text' | 'category' | 'date' | 'number'; get: (r: Row) => string | number; render?: (r: Row) => React.ReactNode; delayOnly?: boolean }

export default function CallLensTab({ currentUserEmail }: { currentUserEmail: string }) {
  const supabase = createClient()
  const [orders, setOrders] = useState<DBOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [queue, setQueue] = useState<'predispatch' | 'delay'>('predispatch')
  const [logs, setLogs] = useState<Record<string, CallLog[]>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dispDraft, setDispDraft] = useState<Record<string, { disp: string; note: string }>>({})
  const [saving, setSaving] = useState<string | null>(null)
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
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [openFilter])

  const load = useCallback(async () => {
    setLoading(true)
    const rows = await fetchAllRows<DBOrder>((from, to) =>
      supabase.from('dispatch_orders').select('*').eq('is_cancelled', false)
        .order('order_date', { ascending: false }).order('id', { ascending: false }).range(from, to))
    setOrders(rows); setLoading(false)
  }, [supabase])
  useEffect(() => { load() }, [load])

  // Reset selection + sort default when queue changes.
  useEffect(() => { setSelected(new Set()); setOpenFilter(null) }, [queue])

  const notInTransit = useMemo(() => new Set(['delivered', 'rto', 'returned', 'return to origin', 'rto delivered', 'rto initiated', 'cancelled', 'lost']), [])

  const base: Row[] = useMemo(() => {
    return orders.filter(o => {
      if (queue === 'predispatch') return !o.is_dispatched && !o.is_cancelled
      return o.is_dispatched && !notInTransit.has((o.tracking_status || '').toLowerCase())
    }).map(o => ({ o, status: statusOf(o).label }))
  }, [orders, queue, notInTransit])

  const counts = useMemo(() => {
    const pre = orders.filter(o => !o.is_dispatched && !o.is_cancelled)
    const del = orders.filter(o => o.is_dispatched && !notInTransit.has((o.tracking_status || '').toLowerCase()))
    return { pre: pre.length, del: del.length }
  }, [orders, notInTransit])

  const COLS: Col[] = useMemo(() => [
    { key: 'order_date', label: 'Order Date', type: 'date', get: r => r.o.order_date || '', render: r => fmtDate(r.o.order_date) },
    { key: 'order_id', label: 'Order', type: 'text', get: r => r.o.order_id },
    { key: 'customer', label: 'Customer', type: 'text', get: r => r.o.customer_name || '' },
    { key: 'sku', label: 'SKU', type: 'text', get: r => r.o.sku || '' },
    { key: 'contact', label: 'Contact', type: 'text', get: r => r.o.contact_number || '', render: r => r.o.contact_number ? <a href={`tel:${r.o.contact_number}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{r.o.contact_number}</a> : '—' },
    { key: 'status', label: 'Status', type: 'category', get: r => r.status, render: r => { const s = statusOf(r.o); return <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: s.fg, background: s.bg, padding: '2px 7px', borderRadius: 4 }}>{s.label}</span> } },
    { key: 'promise', label: 'Promise', type: 'date', delayOnly: true, get: r => r.o.promise_date || '', render: r => fmtDate(r.o.promise_date) },
    { key: 'dispatched', label: 'Dispatched', type: 'date', delayOnly: true, get: r => r.o.dispatched_at || '', render: r => fmtDate(r.o.dispatched_at) },
    { key: 'delivery', label: 'Delivery', type: 'number', delayOnly: true, get: r => { const d = deliveryDaysLeft(r.o); return d === null ? 9999 : d }, render: r => { const dl = deliveryDaysLeft(r.o); if (dl === null) return '—'; const c = dl < 0 ? 'var(--critical)' : dl <= 1 ? 'var(--today)' : 'var(--dispatched)'; const t = dl < 0 ? `${Math.abs(dl)}d overdue` : dl === 0 ? 'due today' : `${dl}d left`; return <span style={{ fontFamily: 'DM Mono', fontWeight: 700, color: c }}>{t}</span> } },
    { key: 'caller', label: 'Caller', type: 'category', get: r => r.o.assigned_caller || '(none)' },
  ], [])

  const activeCols = useMemo(() => COLS.filter(c => !c.delayOnly || queue === 'delay'), [COLS, queue])
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
      for (const key in textFilters) {
        const val = textFilters[key]; if (!val) continue
        const col = colByKey[key]; if (!col) continue
        if (!String(col.get(r)).toLowerCase().includes(val.toLowerCase())) return false
      }
      for (const key in catFilters) {
        const allowed = catFilters[key]; if (!allowed || allowed.length === 0) continue
        const col = colByKey[key]; if (!col) continue
        if (!allowed.includes(String(col.get(r)) || '(blank)')) return false
      }
      return true
    })
    const col = colByKey[sortKey]
    if (col) out = [...out].sort((a, b) => {
      const va = col.get(a), vb = col.get(b)
      const cmp = col.type === 'number' ? (va as number) - (vb as number) : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return out
  }, [base, colByKey, textFilters, catFilters, sortKey, sortDir])

  const toggleSort = (key: string) => { if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir('asc') } }
  const hasFilter = (key: string) => !!textFilters[key] || (catFilters[key]?.length ?? 0) > 0
  const anyFilter = Object.values(textFilters).some(Boolean) || Object.values(catFilters).some(a => a?.length)
  const clearAll = () => { setTextFilters({}); setCatFilters({}) }

  // selection
  const allFilteredIds = useMemo(() => rows.map(r => r.o.order_id), [rows])
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every(id => selected.has(id))
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(allFilteredIds))
  const toggleRow = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const bulkReassign = async () => {
    if (!bulkCaller || selected.size === 0) return
    setBulkSaving(true)
    try {
      const ids = Array.from(selected)
      const now = new Date().toISOString()
      // Chunk to avoid oversized IN clauses.
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

  const dispositions = queue === 'predispatch' ? PREDISPATCH_DISPOSITIONS : DELAY_DISPOSITIONS

  const applyDisposition = async (o: DBOrder) => {
    const draft = dispDraft[o.order_id]; if (!draft || !draft.disp) return
    setSaving(o.order_id)
    try {
      const now = new Date().toISOString()
      await supabase.from('call_logs').insert({ order_id: o.order_id, queue, channel: 'call', disposition: draft.disp, note: draft.note || null, caller: o.assigned_caller || null, created_by_email: currentUserEmail })
      const patch: Record<string, unknown> = { last_disposition: draft.disp, last_disposition_at: now, updated_at: now }
      if (queue === 'predispatch') {
        if (draft.disp === 'Confirmed' || draft.disp === 'WhatsApp-confirmed') patch.plan_decision = 'scheduled'
        else if (draft.disp === 'Cancelled') { patch.is_cancelled = true; patch.manual_cancelled = true; patch.manual_cancelled_at = now }
        else if (draft.disp === 'Hold') patch.plan_decision = 'unfulfillable'
      } else if (draft.disp === 'Wants to cancel') { patch.is_cancelled = true; patch.manual_cancelled = true; patch.manual_cancelled_at = now }
      await supabase.from('dispatch_orders').update(patch).eq('order_id', o.order_id)
      setOrders(prev => prev.map(x => x.order_id === o.order_id ? { ...x, ...patch } as DBOrder : x))
      setDispDraft(prev => { const n = { ...prev }; delete n[o.order_id]; return n })
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>CallLens</h1>
        <div style={{ display: 'flex', gap: 3, background: 'var(--bg2)', padding: 3, borderRadius: 7 }}>
          <button onClick={() => setQueue('predispatch')} style={{ padding: '6px 12px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: queue === 'predispatch' ? 'var(--surface)' : 'transparent', color: queue === 'predispatch' ? 'var(--text)' : 'var(--text3)', boxShadow: queue === 'predispatch' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
            Pre-dispatch confirm <b style={{ color: 'var(--accent)' }}>{counts.pre}</b>
          </button>
          <button onClick={() => setQueue('delay')} style={{ padding: '6px 12px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: queue === 'delay' ? 'var(--surface)' : 'transparent', color: queue === 'delay' ? 'var(--text)' : 'var(--text3)', boxShadow: queue === 'delay' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
            Delay check <b>{counts.del}</b>
          </button>
        </div>
        <span style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--text3)' }}>{loading ? 'loading…' : `${rows.length} shown`}</span>
        {anyFilter && <button onClick={clearAll} style={{ padding: '5px 11px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}><X size={12} /> Clear filters</button>}
      </div>

      {/* Bulk reassign bar — appears when rows are selected */}
      {selected.size > 0 && (
        <div style={{ ...card, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--accent-bg)', border: '1px solid var(--accent)' }}>
          <Users size={15} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>{selected.size} selected</span>
          <span style={{ fontSize: 13, color: 'var(--text2)' }}>Reassign to</span>
          <select value={bulkCaller} onChange={e => setBulkCaller(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, cursor: 'pointer' }}>
            <option value="">Choose caller…</option>
            {CALLERS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={bulkReassign} disabled={!bulkCaller || bulkSaving} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: bulkCaller ? 'var(--accent)' : 'var(--bg2)', color: bulkCaller ? '#fff' : 'var(--text3)', fontSize: 13, fontWeight: 700, cursor: bulkCaller ? 'pointer' : 'not-allowed' }}>{bulkSaving ? 'Reassigning…' : 'Reassign'}</button>
          <button onClick={() => setSelected(new Set())} style={{ marginLeft: 'auto', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 12, cursor: 'pointer' }}>Clear selection</button>
        </div>
      )}

      <div style={{ ...card, overflow: 'visible' }}>
        <div style={{ overflowX: 'auto' as const, overflowY: 'auto' as const, maxHeight: 'calc(100vh - 260px)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 1200 }}>
            <thead style={{ position: 'sticky' as const, top: 0, zIndex: 30 }}>
              <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '8px 10px', background: 'var(--bg2)', width: 34 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} title="Select all filtered" />
                </th>
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
                            {(catOptions[col.key] || []).map(opt => {
                              const cur = catFilters[col.key] || []; const on = cur.includes(opt)
                              return (<label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text2)', cursor: 'pointer', padding: '2px 0' }}>
                                <input type="checkbox" checked={on} onChange={() => setCatFilters(prev => { const c = prev[col.key] || []; const next = c.includes(opt) ? c.filter(x => x !== opt) : [...c, opt]; return { ...prev, [col.key]: next } })} />{opt}
                              </label>)
                            })}
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
                const draft = dispDraft[o.order_id] || { disp: '', note: '' }
                const open = expanded === o.order_id
                const sel = selected.has(o.order_id)
                return (
                  <Fragment key={o.id}>
                    <tr style={{ borderBottom: open ? 'none' : '1px solid var(--border)', background: sel ? 'var(--accent-bg)' : (i % 2 === 0 ? 'transparent' : 'var(--bg2)') }}>
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
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' as const }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <select value={draft.disp} onChange={e => setDispDraft(prev => ({ ...prev, [o.order_id]: { ...draft, disp: e.target.value } }))} style={{ fontSize: 11, padding: '4px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer' }}>
                            <option value="">{o.last_disposition ? `↻ ${o.last_disposition}` : 'Set disposition…'}</option>
                            {dispositions.map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
                          {draft.disp && (<>
                            <input value={draft.note} onChange={e => setDispDraft(prev => ({ ...prev, [o.order_id]: { ...draft, note: e.target.value } }))} placeholder="note…" style={{ fontSize: 11, padding: '4px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', width: 110, outline: 'none' }} />
                            <button onClick={() => applyDisposition(o)} disabled={saving === o.order_id} style={{ padding: '4px 8px', borderRadius: 5, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={11} /> {saving === o.order_id ? '…' : 'Save'}</button>
                          </>)}
                        </div>
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
