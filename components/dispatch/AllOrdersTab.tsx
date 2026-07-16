'use client'
import { useState, useMemo, useRef, useEffect } from 'react'
import { DBOrder } from '@/types'
import { Search, Download, ArrowUp, ArrowDown, Filter, X } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

export function detectPlatform(orderId: string): 'Amazon' | 'Flipkart' | 'D2C' | 'Manual' | 'Unknown' {
  const id = (orderId || '').trim()
  if (/^\d{3}-\d{7}-\d{7}$/.test(id)) return 'Amazon'
  if (/^OD\d+/i.test(id)) return 'Flipkart'
  if (/^(SW\/LLP|H\d{2}\/)/i.test(id)) return 'Manual'
  if (/^\d{1,8}$/.test(id)) return 'D2C'
  return 'Unknown'
}

const PLATFORM_STYLE: Record<string, { fg: string; bg: string; bd: string }> = {
  Amazon: { fg: '#b45309', bg: '#fff7ed', bd: '#fed7aa' },
  Flipkart: { fg: '#1d4ed8', bg: '#eff6ff', bd: '#bfdbfe' },
  D2C: { fg: '#7c3aed', bg: '#f5f3ff', bd: '#ddd6fe' },
  Manual: { fg: '#0f766e', bg: '#f0fdfa', bd: '#99f6e4' },
  Unknown: { fg: 'var(--text3)', bg: 'var(--bg2)', bd: 'var(--border)' },
}

function statusLabel(o: DBOrder): string {
  if (o.is_cancelled) return 'Cancelled'
  if (o.is_dispatched) return 'Dispatched'
  if (o.plan_decision === 'unfulfillable') return 'Hold'
  if (o.plan_decision === 'scheduled') return 'Scheduled'
  return 'Active'
}
const STATUS_STYLE: Record<string, { fg: string; bg: string }> = {
  Cancelled: { fg: 'var(--critical)', bg: 'var(--critical-bg)' },
  Dispatched: { fg: 'var(--dispatched)', bg: 'var(--dispatched-bg)' },
  Hold: { fg: 'var(--today)', bg: 'var(--today-bg)' },
  Scheduled: { fg: '#2563eb', bg: '#eff6ff' },
  Active: { fg: 'var(--text2)', bg: 'var(--bg2)' },
}

const fmtDate = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'

interface Row { o: DBOrder; platform: string; status: string }

interface Col {
  key: string
  label: string
  type: 'text' | 'category' | 'date' | 'number'
  get: (r: Row) => string | number
  render?: (r: Row) => React.ReactNode
  align?: 'left' | 'right'
}

export default function AllOrdersTab({ orders }: { orders: DBOrder[] }) {
  const [globalQ, setGlobalQ] = useState('')
  const [sortKey, setSortKey] = useState<string>('created')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [openFilter, setOpenFilter] = useState<string | null>(null)
  const [textFilters, setTextFilters] = useState<Record<string, string>>({})
  const [catFilters, setCatFilters] = useState<Record<string, Set<string>>>({})
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openFilter) return
    const h = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpenFilter(null) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [openFilter])

  const base: Row[] = useMemo(() =>
    orders.map(o => ({ o, platform: detectPlatform(o.order_id), status: statusLabel(o) })), [orders])

  const COLS: Col[] = useMemo(() => [
    { key: 'order_date', label: 'Order Date', type: 'date', get: r => r.o.order_date || '', render: r => fmtDate(r.o.order_date) },
    { key: 'dispatch_by', label: 'Dispatch By', type: 'date', get: r => r.o.dispatch_by_date || '', render: r => fmtDate(r.o.dispatch_by_date) },
    { key: 'order_id', label: 'Order ID', type: 'text', get: r => r.o.order_id, render: r => <span style={{ color: 'var(--text)' }}>{r.o.order_id}</span> },
    { key: 'platform', label: 'Platform', type: 'category', get: r => r.platform, render: r => { const p = PLATFORM_STYLE[r.platform]; return <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: p.fg, background: p.bg, border: `1px solid ${p.bd}`, padding: '2px 7px', borderRadius: 4 }}>{r.platform}</span> } },
    { key: 'customer', label: 'Customer', type: 'text', get: r => r.o.customer_name || '', render: r => <span style={{ fontFamily: 'DM Sans' }}>{r.o.customer_name}</span> },
    { key: 'sku', label: 'SKU', type: 'text', get: r => r.o.sku || '' },
    { key: 'barcode_sku', label: 'Barcode SKU', type: 'text', get: r => r.o.barcode_sku || '', render: r => <span style={{ color: 'var(--text3)' }}>{r.o.barcode_sku || '—'}</span> },
    { key: 'courier', label: 'Courier', type: 'category', get: r => r.o.courier || '', render: r => <span style={{ fontWeight: 500, color: r.o.courier === 'Bluedart' ? '#2563eb' : '#7c3aed' }}>{r.o.courier === 'Bluedart' ? 'BD' : 'DL'}</span> },
    { key: 'awb', label: 'AWB', type: 'text', get: r => r.o.tracking_number || '', render: r => <span style={{ color: 'var(--text2)' }}>{r.o.tracking_number || '—'}</span> },
    { key: 'lr', label: 'LR', type: 'text', get: r => r.o.lr_number || '', render: r => <span style={{ color: 'var(--text3)' }}>{r.o.lr_number || '—'}</span> },
    { key: 'status', label: 'Status', type: 'category', get: r => r.status, render: r => { const s = STATUS_STYLE[r.status]; return <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: s.fg, background: s.bg, padding: '2px 7px', borderRadius: 4 }}>{r.status}</span> } },
    { key: 'pincode', label: 'Pincode · City', type: 'text', get: r => `${r.o.pincode || ''} ${r.o.city || ''}`.trim(), render: r => <span>{r.o.pincode}{r.o.city ? ` · ${r.o.city}` : ''}</span> },
    { key: 'promise', label: 'Promise', type: 'date', get: r => r.o.promise_date || '', render: r => <span style={{ color: 'var(--text2)' }}>{fmtDate(r.o.promise_date)}</span> },
    { key: 'dispatched', label: 'Dispatched', type: 'date', get: r => r.o.dispatched_at || '', render: r => <span style={{ color: 'var(--text2)' }}>{fmtDate(r.o.dispatched_at)}</span> },
    { key: 'contact', label: 'Contact', type: 'text', get: r => r.o.contact_number || '', render: r => <span style={{ color: 'var(--text2)' }}>{r.o.contact_number || '—'}</span> },
    { key: 'value', label: 'Value', type: 'number', align: 'right', get: r => r.o.taxable_value != null ? (r.o.taxable_value + (r.o.tax_amount || 0)) : -1, render: r => <span style={{ color: 'var(--text2)' }}>{r.o.taxable_value != null ? `₹${(r.o.taxable_value + (r.o.tax_amount || 0)).toLocaleString('en-IN')}` : '—'}</span> },
    { key: 'created', label: 'Created', type: 'date', get: r => r.o.created_at || '', render: r => <span style={{ color: 'var(--text3)' }}>{fmtDate(r.o.created_at)}</span> },
  ], [])

  const colByKey = useMemo(() => Object.fromEntries(COLS.map(c => [c.key, c])), [COLS])

  const catOptions = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const c of COLS) if (c.type === 'category') {
      const set = new Set<string>()
      for (const r of base) set.add(String(c.get(r)) || '(blank)')
      m[c.key] = Array.from(set).sort()
    }
    return m
  }, [COLS, base])

  const rows = useMemo(() => {
    const gq = globalQ.trim().toLowerCase()
    let out = base.filter(r => {
      if (gq) {
        const hay = COLS.map(c => String(c.get(r))).join(' ').toLowerCase()
        if (!hay.includes(gq)) return false
      }
      for (const [key, val] of Object.entries(textFilters)) {
        if (!val) continue
        const col = colByKey[key]; if (!col) continue
        if (!String(col.get(r)).toLowerCase().includes(val.toLowerCase())) return false
      }
      for (const [key, allowed] of Object.entries(catFilters)) {
        if (!allowed || allowed.size === 0) continue
        const col = colByKey[key]; if (!col) continue
        if (!allowed.has(String(col.get(r)) || '(blank)')) return false
      }
      return true
    })
    const col = colByKey[sortKey]
    if (col) {
      out = [...out].sort((a, b) => {
        const va = col.get(a), vb = col.get(b)
        let cmp: number
        if (col.type === 'number') cmp = (va as number) - (vb as number)
        else cmp = String(va).localeCompare(String(vb))
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return out
  }, [base, COLS, colByKey, globalQ, textFilters, catFilters, sortKey, sortDir])

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }
  const hasFilter = (key: string) => !!textFilters[key] || (catFilters[key]?.size ?? 0) > 0
  const clearAll = () => { setTextFilters({}); setCatFilters({}); setGlobalQ('') }
  const anyFilter = globalQ || Object.values(textFilters).some(Boolean) || Object.values(catFilters).some(s => s?.size)

  const exportCsv = () => {
    const headers = COLS.map(c => c.label)
    const lines = rows.map(r => COLS.map(c => `"${String(c.get(r)).replace(/"/g, '""')}"`).join(','))
    const csv = [headers.join(','), ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `all-orders-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>All Orders</h1>
        <span style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--text3)' }}>{rows.length} of {orders.length}</span>
        <div style={{ position: 'relative' as const, minWidth: 240, flex: '0 1 320px' }}>
          <Search size={13} style={{ position: 'absolute' as const, left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)' }} />
          <input value={globalQ} onChange={e => setGlobalQ(e.target.value)} placeholder="Search all columns…"
            style={{ width: '100%', padding: '7px 10px 7px 30px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }} />
        </div>
        {anyFilter && (
          <button onClick={clearAll} style={{ padding: '6px 11px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <X size={12} /> Clear filters
          </button>
        )}
        <button onClick={exportCsv} style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Download size={12} /> Export CSV
        </button>
      </div>

      <div style={{ ...card, overflow: 'visible' }}>
        <div style={{ overflowX: 'auto' as const, overflowY: 'auto' as const, maxHeight: 'calc(100vh - 240px)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 1500 }}>
            <thead style={{ position: 'sticky' as const, top: 0, zIndex: 30 }}>
              <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                {COLS.map(col => (
                  <th key={col.key} style={{ padding: '8px 10px', textAlign: col.align || 'left', background: 'var(--bg2)', whiteSpace: 'nowrap' as const, position: 'relative' as const, userSelect: 'none' as const }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start' }}>
                      <span onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: sortKey === col.key ? 'var(--accent)' : 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        {col.label}
                        {sortKey === col.key && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </span>
                      <button onClick={() => setOpenFilter(openFilter === col.key ? null : col.key)}
                        title="Filter" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, display: 'inline-flex', color: hasFilter(col.key) ? 'var(--accent)' : 'var(--text3)', opacity: hasFilter(col.key) ? 1 : 0.45 }}>
                        <Filter size={11} />
                      </button>
                    </div>
                    {openFilter === col.key && (
                      <div ref={popRef} style={{ position: 'absolute' as const, top: '100%', left: 0, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 10, zIndex: 50, minWidth: 170, textAlign: 'left' as const, fontFamily: 'DM Sans' }}>
                        {col.type === 'category' ? (
                          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3, maxHeight: 220, overflowY: 'auto' as const }}>
                            {(catOptions[col.key] || []).map(opt => {
                              const set = catFilters[col.key] || new Set<string>()
                              const on = set.has(opt)
                              return (
                                <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text2)', cursor: 'pointer', padding: '2px 0' }}>
                                  <input type="checkbox" checked={on} onChange={() => {
                                    setCatFilters(prev => { const next = new Set(prev[col.key] || []); if (on) next.delete(opt); else next.add(opt); return { ...prev, [col.key]: next } })
                                  }} />
                                  {opt}
                                </label>
                              )
                            })}
                            {(catFilters[col.key]?.size ?? 0) > 0 && (
                              <button onClick={() => setCatFilters(prev => ({ ...prev, [col.key]: new Set() }))} style={{ marginTop: 4, fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' as const, padding: 0 }}>clear</button>
                            )}
                          </div>
                        ) : (
                          <input autoFocus value={textFilters[col.key] || ''} onChange={e => setTextFilters(prev => ({ ...prev, [col.key]: e.target.value }))}
                            placeholder={`Filter ${col.label}…`}
                            style={{ width: '100%', padding: '6px 8px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const }} />
                        )}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={COLS.length} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>No orders match.</td></tr>
              ) : rows.map((r, i) => (
                <tr key={r.o.id} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                  {COLS.map(col => (
                    <td key={col.key} style={{ padding: '8px 10px', fontFamily: col.key === 'customer' ? 'DM Sans' : 'DM Mono', fontSize: 11, textAlign: col.align || 'left', whiteSpace: 'nowrap' as const, color: 'var(--text)' }}>
                      {col.render ? col.render(r) : String(col.get(r))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
