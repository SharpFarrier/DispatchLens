'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Search } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

interface PackedUnit {
  id: string; barcode: string; sku: string; seq: number; status: string; source: string
  packed_at: string | null; stocked_at: string | null; dispatched_at: string | null; rto_at: string | null
}

const STATUS_STYLE: Record<string, { color: string; bg: string }> = {
  packed:        { color: 'var(--accent)', bg: 'var(--accent-bg)' },
  stocked:       { color: 'var(--dispatched)', bg: 'var(--dispatched-bg)' },
  'in-dispatch': { color: 'var(--hold)', bg: 'var(--hold-bg)' },
  dispatched:    { color: 'var(--text2)', bg: 'var(--bg2)' },
  rto:           { color: 'var(--critical)', bg: 'var(--critical-bg)' },
}

function StatusBadge({ s }: { s: string }) {
  const st = STATUS_STYLE[s] || { color: 'var(--text3)', bg: 'var(--bg2)' }
  return <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, padding: '2px 7px', borderRadius: 4, color: st.color, background: st.bg }}>{s}</span>
}

function ts(v: string | null) {
  if (!v) return '—'
  return new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function UnitsTab() {
  const supabase = createClient()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<PackedUnit[] | null>(null)
  const [searched, setSearched] = useState('')

  async function runSearch() {
    const q = query.trim()
    if (!q) return
    setLoading(true)
    setSearched(q)
    try {
      const { data, error } = await supabase.from('packed_units')
        .select('*')
        .or(`barcode.ilike.%${q}%,sku.ilike.%${q}%`)
        .order('sku').order('seq')
        .limit(500)
      if (error) throw error
      setResults((data as PackedUnit[]) || [])
    } catch {
      setResults([])
    }
    setLoading(false)
  }

  const summary = results ? results.reduce((acc: Record<string, number>, u) => { acc[u.status] = (acc[u.status] || 0) + 1; return acc }, {}) : {}

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Find Units</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '7px 12px', flex: 1 }}>
            <Search size={13} style={{ color: 'var(--text3)' }} />
            <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && runSearch()}
              placeholder="Barcode or SKU (e.g. ME-B-BL-EL-3 or …-3-1257)"
              style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'DM Sans', width: '100%' }} />
          </div>
          <button onClick={runSearch} style={{ padding: '7px 22px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Search</button>
        </div>
      </div>

      {loading && <div style={{ ...card, padding: 48, textAlign: 'center' as const, color: 'var(--text3)' }}>Searching…</div>}

      {!loading && results && (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)' }}>{results.length} unit(s)</span>
            {Object.entries(summary).map(([s, n]) => (
              <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text3)' }}>
                <StatusBadge s={s} /> {n}
              </span>
            ))}
          </div>

          {!results.length ? (
            <div style={{ ...card, padding: 48, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No units match &quot;{searched}&quot;</div>
          ) : results.length === 1 ? (
            (() => {
              const u = results[0]
              return (
                <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--text)' }}>{u.barcode}</span>
                    <StatusBadge s={u.status} />
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' }}>SKU {u.sku} · seq {u.seq} · source {u.source}</div>
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 8, fontSize: 12 }}>
                    <span style={{ color: 'var(--text3)' }}>Packed</span><span style={{ color: 'var(--text2)', textAlign: 'right' as const, fontFamily: 'DM Mono' }}>{ts(u.packed_at)}</span>
                    <span style={{ color: 'var(--text3)' }}>Stocked</span><span style={{ color: 'var(--text2)', textAlign: 'right' as const, fontFamily: 'DM Mono' }}>{ts(u.stocked_at)}</span>
                    <span style={{ color: 'var(--text3)' }}>Dispatched</span><span style={{ color: 'var(--text2)', textAlign: 'right' as const, fontFamily: 'DM Mono' }}>{ts(u.dispatched_at)}</span>
                    <span style={{ color: 'var(--text3)' }}>RTO</span><span style={{ color: 'var(--text2)', textAlign: 'right' as const, fontFamily: 'DM Mono' }}>{ts(u.rto_at)}</span>
                  </div>
                </div>
              )
            })()
          ) : (
            <div style={{ ...card, overflow: 'auto', maxHeight: 448 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '8px 12px', textAlign: 'left' as const, fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, color: 'var(--text3)' }}>Barcode</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left' as const, fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, color: 'var(--text3)' }}>Status</th>
                    <th style={{ padding: '8px 12px', textAlign: 'right' as const, fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, color: 'var(--text3)' }}>Stocked</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((u, i) => (
                    <tr key={u.id} style={{ borderTop: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                      <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{u.barcode}</td>
                      <td style={{ padding: '8px 12px' }}><StatusBadge s={u.status} /></td>
                      <td style={{ padding: '8px 12px', textAlign: 'right' as const, fontSize: 11, fontFamily: 'DM Mono', color: 'var(--text3)' }}>{ts(u.stocked_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
