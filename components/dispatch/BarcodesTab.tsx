'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { format } from 'date-fns'
import { Spinner, EmptyState, ColourDot } from './warehouse-ui'

interface Piece {
  id: string
  barcode: string
  shape: string | null
  size: string | null
  colour: string | null
  mattress: string | null
  status: string
  coating_trolley_id: string | null
  pick_session_id: string | null
  packed_barcode: string | null
  coated_at: string | null
  picked_at: string | null
  packed_at: string | null
  created_at: string
}

const STATUS_ORDER = ['coated', 'picked', 'packed', 'dispatched']
const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  coated:     { label: 'Coated',     bg: 'var(--accent-bg)',     fg: 'var(--accent)' },
  error:      { label: 'Error',      bg: 'var(--critical-bg)',   fg: 'var(--critical)' },
  picked:     { label: 'Picked',     bg: 'var(--today-bg)',      fg: 'var(--today)' },
  packed:     { label: 'Packed',     bg: 'var(--plan-bg)',       fg: 'var(--plan)' },
  dispatched: { label: 'Dispatched', bg: 'var(--dispatched-bg)', fg: 'var(--dispatched)' },
}

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] || { label: status, bg: 'var(--bg2)', fg: 'var(--text3)' }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 999, background: m.bg, color: m.fg }}>
      {m.label}
    </span>
  )
}

// Inline lifecycle dots: coated → picked → packed → dispatched
function Lifecycle({ piece }: { piece: Piece }) {
  const reached = (s: string) => {
    const order = STATUS_ORDER.indexOf(piece.status)
    const idx = STATUS_ORDER.indexOf(s)
    return idx >= 0 && idx <= order
  }
  const ts: Record<string, string | null> = {
    coated: piece.coated_at, picked: piece.picked_at, packed: piece.packed_at, dispatched: null,
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {STATUS_ORDER.map((s, i) => {
        const on = reached(s)
        const m = STATUS_META[s]
        return (
          <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span title={ts[s] ? format(new Date(ts[s]!), 'dd MMM yy, HH:mm') : m.label}
              style={{
                width: 8, height: 8, borderRadius: '50%',
                background: on ? m.fg : 'var(--border2)',
              }} />
            {i < STATUS_ORDER.length - 1 && (
              <span style={{ width: 10, height: 2, background: reached(STATUS_ORDER[i + 1]) ? m.fg : 'var(--border2)' }} />
            )}
          </span>
        )
      })}
    </div>
  )
}

export default function BarcodesTab() {
  const supabase = useMemo(() => createClient(), [])
  const [pieces, setPieces] = useState<Piece[]>([])
  const [loading, setLoading] = useState(true)
  const [windowMode, setWindowMode] = useState<'7d' | 'all'>('7d')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [errorScan, setErrorScan] = useState('')
  const [marking, setMarking] = useState<string | null>(null)
  const [scanMsg, setScanMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString()
    const data = await fetchAllRows<Piece>((from, to) => {
      let q = supabase.from('pieces').select('*').order('created_at', { ascending: false }).order('id', { ascending: false })
      if (windowMode === '7d') q = q.gte('created_at', sevenDaysAgo)
      return q.range(from, to)
    })
    setPieces(data)
    setLoading(false)
  }, [supabase, windowMode])

  useEffect(() => { void load() }, [load])

  // Mark a piece as error — only allowed while still 'coated'. Soft (status='error'),
  // so it drops out of coated stock and can't be picked. Guarded by .eq('status','coated').
  const markError = useCallback(async (piece: { id: string; barcode: string; status: string }, reason: string) => {
    if (piece.status !== 'coated') {
      setScanMsg({ ok: false, text: `${piece.barcode} is "${piece.status}" — only coated pieces can be marked error.` })
      return false
    }
    setMarking(piece.id)
    const { data, error } = await supabase.from('pieces')
      .update({ status: 'error', error_at: new Date().toISOString(), error_reason: reason || null })
      .eq('id', piece.id).eq('status', 'coated').select()
    setMarking(null)
    if (error || !data || data.length === 0) {
      setScanMsg({ ok: false, text: `Couldn't mark ${piece.barcode} — it may have moved past coated.` })
      return false
    }
    setPieces(prev => prev.map(p => p.id === piece.id ? { ...p, status: 'error' } : p))
    setScanMsg({ ok: true, text: `${piece.barcode} marked as error — removed from coated stock.` })
    return true
  }, [supabase])

  const handleErrorScan = useCallback(async () => {
    const code = errorScan.trim()
    if (!code) return
    let piece: { id: string; barcode: string; status: string } | undefined = pieces.find(p => p.barcode === code)
    // If not in the loaded window (e.g. we're on the 7-day view), look it up directly in the DB
    // so scanning always works regardless of the current window.
    if (!piece) {
      const { data } = await supabase.from('pieces').select('id, barcode, status').eq('barcode', code).limit(1)
      if (data && data.length) piece = data[0] as { id: string; barcode: string; status: string }
    }
    if (!piece) { setScanMsg({ ok: false, text: `${code} not found.` }); setErrorScan(''); return }
    const ok = await markError(piece, 'Scanned at Barcodes tab')
    if (ok) setErrorScan('')
  }, [errorScan, pieces, markError, supabase])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: pieces.length, coated: 0, picked: 0, packed: 0, dispatched: 0, error: 0 }
    pieces.forEach(p => { c[p.status] = (c[p.status] || 0) + 1 })
    return c
  }, [pieces])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return pieces.filter(p => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false
      if (!q) return true
      return (
        p.barcode.toLowerCase().includes(q) ||
        (p.shape || '').toLowerCase().includes(q) ||
        (p.colour || '').toLowerCase().includes(q) ||
        (p.size || '').toLowerCase().includes(q)
      )
    })
  }, [pieces, search, statusFilter])

  const inputField = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' as const }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' as const }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Barcodes</h2>
        <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'DM Mono' }}>
          {counts.all} {windowMode === '7d' ? 'in last 7 days' : 'total'}
        </span>
        {/* Window toggle: default 7-day view, or load everything */}
        <div style={{ display: 'flex', gap: 0, marginLeft: 'auto', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {(['7d', 'all'] as const).map(mode => (
            <button key={mode} onClick={() => setWindowMode(mode)}
              style={{
                padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: windowMode === mode ? 'var(--accent)' : 'var(--surface)',
                color: windowMode === mode ? '#fff' : 'var(--text2)',
              }}>
              {mode === '7d' ? 'Last 7 days' : 'Load all'}
            </button>
          ))}
        </div>
      </div>

      {/* Status filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {['all', ...STATUS_ORDER, 'error'].map(s => {
          const active = statusFilter === s
          const label = s === 'all' ? 'All' : (STATUS_META[s]?.label || s)
          return (
            <button key={s} onClick={() => setStatusFilter(s)}
              style={{
                padding: '6px 14px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: active ? 'none' : '1px solid var(--border)',
                background: active ? 'var(--accent)' : 'var(--surface)',
                color: active ? '#fff' : 'var(--text3)',
              }}>
              {label} <span style={{ opacity: 0.7 }}>({counts[s] || 0})</span>
            </button>
          )
        })}
      </div>

      {/* Search */}
      {/* Scan a mis-coated piece to flag it (removes from coated stock) */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>⚠ Mark a coating error</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...inputField, flex: 1 }}
            placeholder="Scan or type the bad piece's barcode…"
            value={errorScan}
            onChange={e => setErrorScan(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleErrorScan() }}
          />
          <button onClick={() => void handleErrorScan()} disabled={!errorScan.trim() || !!marking} style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: 'var(--critical)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const }}>Mark error</button>
        </div>
        {scanMsg && (
          <div style={{ marginTop: 8, fontSize: 13, color: scanMsg.ok ? 'var(--dispatched)' : 'var(--critical)' }}>{scanMsg.text}</div>
        )}
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text3)' }}>Only pieces still in <b>coated</b> state can be flagged. Picked/packed pieces are blocked.</div>
      </div>

      <input style={{ ...inputField, marginBottom: 16 }} placeholder="Search barcode, shape, size, colour…" value={search} onChange={e => setSearch(e.target.value)} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><Spinner size="lg" /></div>
      ) : !filtered.length ? (
        <div>
          <EmptyState icon="🏷️" message={pieces.length ? 'No barcodes match your filter' : windowMode === '7d' ? 'No barcodes in the last 7 days' : 'No barcodes generated yet'} />
          {windowMode === '7d' && search.trim() && (
            <div style={{ textAlign: 'center' as const, marginTop: -8, marginBottom: 16, fontSize: 13, color: 'var(--text3)' }}>
              Searching only the last 7 days.{' '}
              <button onClick={() => setWindowMode('all')} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 0, textDecoration: 'underline' }}>Load all</button>
              {' '}to search everything.
            </div>
          )}
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', overflowX: 'auto' as const, overflowY: 'auto' as const, maxHeight: 'calc(100vh - 380px)' }}>
          <table style={{ width: '100%', fontSize: 14, minWidth: 640, borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky' as const, top: 0, zIndex: 10 }}>
              <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                {['Barcode', 'Frame', 'Status', 'Lifecycle', 'Created', ''].map(h => (
                  <th key={h} style={{ background: 'var(--bg2)', padding: '8px 12px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text3)', textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 13, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>{p.barcode}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>
                    <div style={{ fontWeight: 600 }}>{p.shape || '—'}{p.size ? ` · ${p.size}` : ''}</div>
                    <div style={{ fontSize: 12, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
                      {p.colour && <><ColourDot colour={p.colour} />{p.colour}</>}
                      {p.mattress && p.mattress !== 'N/A' ? ` · ${p.mattress}` : ''}
                    </div>
                  </td>
                  <td style={{ padding: '8px 12px' }}><StatusBadge status={p.status} /></td>
                  <td style={{ padding: '8px 12px' }}><Lifecycle piece={p} /></td>
                  <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{p.created_at ? format(new Date(p.created_at), 'dd MMM yy') : '—'}</td>
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                    {p.status === 'coated' ? (
                      <button onClick={() => void markError(p, 'Flagged in Barcodes tab')} disabled={marking === p.id} style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                        {marking === p.id ? '…' : 'Mark error'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot style={{ background: 'var(--bg2)', borderTop: '2px solid var(--border)' }}>
              <tr>
                <td colSpan={6} style={{ padding: '8px 12px', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>
                  Showing {filtered.length} of {counts.all}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
