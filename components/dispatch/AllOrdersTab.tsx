'use client'
import { useState, useMemo } from 'react'
import { DBOrder } from '@/types'
import { Search, Download } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

// ── Platform detection from order-ID pattern (locked against real data) ──
export function detectPlatform(orderId: string): 'Amazon' | 'Flipkart' | 'D2C' | 'Manual' | 'Unknown' {
  const id = (orderId || '').trim()
  if (/^\d{3}-\d{7}-\d{7}$/.test(id)) return 'Amazon'
  if (/^OD\d+/i.test(id)) return 'Flipkart'
  if (/^(SW\/LLP|H\d{2}\/)/i.test(id)) return 'Manual'   // SW/LLP-0017, H25/26-27/258
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

// Derive a human status from order flags.
function orderStatus(o: DBOrder): { label: string; fg: string; bg: string } {
  if (o.is_cancelled) return { label: 'Cancelled', fg: 'var(--critical)', bg: 'var(--critical-bg)' }
  if (o.is_dispatched) return { label: 'Dispatched', fg: 'var(--dispatched)', bg: 'var(--dispatched-bg)' }
  if (o.plan_decision === 'unfulfillable') return { label: 'Hold / Unfulfillable', fg: 'var(--today)', bg: 'var(--today-bg)' }
  if (o.plan_decision === 'scheduled') return { label: 'Scheduled', fg: '#2563eb', bg: '#eff6ff' }
  return { label: 'Active', fg: 'var(--text2)', bg: 'var(--bg2)' }
}

const STATUS_FILTERS = ['All', 'Active', 'Scheduled', 'Hold', 'Dispatched', 'Cancelled'] as const
const PLATFORM_FILTERS = ['All', 'Amazon', 'Flipkart', 'D2C', 'Manual'] as const

export default function AllOrdersTab({ orders }: { orders: DBOrder[] }) {
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<typeof STATUS_FILTERS[number]>('All')
  const [platformFilter, setPlatformFilter] = useState<typeof PLATFORM_FILTERS[number]>('All')

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase()
    return orders
      .map(o => ({ o, platform: detectPlatform(o.order_id), status: orderStatus(o) }))
      .filter(({ o, platform, status }) => {
        if (platformFilter !== 'All' && platform !== platformFilter) return false
        if (statusFilter !== 'All') {
          const s = status.label.toLowerCase()
          if (statusFilter === 'Hold' && !s.includes('hold')) return false
          else if (statusFilter !== 'Hold' && !s.startsWith(statusFilter.toLowerCase())) return false
        }
        if (query) {
          const hay = `${o.order_id} ${o.customer_name} ${o.sku} ${o.barcode_sku || ''} ${o.tracking_number || ''} ${o.lr_number || ''} ${o.contact_number || ''} ${o.pincode || ''} ${o.city || ''}`.toLowerCase()
          if (!hay.includes(query)) return false
        }
        return true
      })
      .sort((a, b) => (b.o.created_at || '').localeCompare(a.o.created_at || ''))
  }, [orders, q, statusFilter, platformFilter])

  const exportCsv = () => {
    const headers = ['Order Date', 'Dispatch By', 'Order ID', 'Platform', 'Customer', 'SKU', 'Barcode SKU', 'Courier', 'AWB', 'LR', 'Status', 'Pincode', 'City', 'Promise', 'Dispatched', 'Contact', 'Order Value', 'Created']
    const lines = rows.map(({ o, platform, status }) => [
      o.order_date || '', o.dispatch_by_date || '',
      o.order_id, platform, o.customer_name, o.sku, o.barcode_sku || '', o.courier, o.tracking_number || '', o.lr_number || '',
      status.label, o.pincode || '', o.city || '',
      o.promise_date || '', o.dispatched_at ? new Date(o.dispatched_at).toISOString().slice(0, 10) : '',
      o.contact_number || '', o.taxable_value != null ? (o.taxable_value + (o.tax_amount || 0)) : '',
      o.created_at ? new Date(o.created_at).toISOString().slice(0, 10) : '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    const csv = [headers.join(','), ...lines].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `all-orders-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const fmtDate = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>All Orders</h1>
        <span style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--text3)' }}>{rows.length} of {orders.length}</span>
        <button onClick={exportCsv} style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Download size={12} /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' as const, alignItems: 'center' }}>
        <div style={{ position: 'relative' as const, minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
          <Search size={13} style={{ position: 'absolute' as const, left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search order, customer, AWB, phone…"
            style={{ width: '100%', padding: '7px 10px 7px 30px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }} />
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', padding: 3, borderRadius: 7 }}>
          {STATUS_FILTERS.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              style={{ padding: '5px 11px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: statusFilter === s ? 'var(--surface)' : 'transparent', color: statusFilter === s ? 'var(--text)' : 'var(--text3)',
                boxShadow: statusFilter === s ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>{s}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', padding: 3, borderRadius: 7 }}>
          {PLATFORM_FILTERS.map(p => (
            <button key={p} onClick={() => setPlatformFilter(p)}
              style={{ padding: '5px 11px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'DM Mono',
                background: platformFilter === p ? 'var(--surface)' : 'transparent',
                color: platformFilter === p ? (PLATFORM_STYLE[p]?.fg || 'var(--text)') : 'var(--text3)',
                boxShadow: platformFilter === p ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>{p}</button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' as const, overflowY: 'auto' as const, maxHeight: 'calc(100vh - 260px)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 1400 }}>
            <thead style={{ position: 'sticky' as const, top: 0, zIndex: 20 }}>
              <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                {['Order Date', 'Dispatch By', 'Order ID', 'Platform', 'Customer', 'SKU', 'Barcode SKU', 'Courier', 'AWB', 'LR', 'Status', 'Pincode · City', 'Promise', 'Dispatched', 'Contact', 'Value', 'Created'].map((h, i) => (
                  <th key={i} style={{ padding: '9px 12px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const, background: 'var(--bg2)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={17} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>No orders match.</td></tr>
              ) : rows.map(({ o, platform, status }, i) => {
                const ps = PLATFORM_STYLE[platform]
                return (
                  <tr key={o.id} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{fmtDate(o.order_date)}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{fmtDate(o.dispatch_by_date)}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', whiteSpace: 'nowrap' as const }}>{o.order_id}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
                      <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: ps.fg, background: ps.bg, border: `1px solid ${ps.bd}`, padding: '2px 7px', borderRadius: 4 }}>{platform}</span>
                    </td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.customer_name}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, whiteSpace: 'nowrap' as const }}>{o.sku}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{o.barcode_sku || '—'}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
                      <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 500, color: o.courier === 'Bluedart' ? '#2563eb' : '#7c3aed' }}>{o.courier === 'Bluedart' ? 'BD' : 'DL'}</span>
                    </td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{o.tracking_number || '—'}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{o.lr_number || '—'}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
                      <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: status.fg, background: status.bg, padding: '2px 7px', borderRadius: 4 }}>{status.label}</span>
                    </td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, whiteSpace: 'nowrap' as const }}>{o.pincode}{o.city ? ` · ${o.city}` : ''}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{fmtDate(o.promise_date)}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{fmtDate(o.dispatched_at)}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{o.contact_number || '—'}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>{o.taxable_value != null ? `₹${(o.taxable_value + (o.tax_amount || 0)).toLocaleString('en-IN')}` : '—'}</td>
                    <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>{fmtDate(o.created_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
