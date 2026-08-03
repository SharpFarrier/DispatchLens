'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Live daily picking stats strip, shown above the scan terminal.
 * Everything is derived from existing columns (no migration):
 *  - "Today" = pieces whose picked_at falls on the current IST day.
 *  - Per-picker = today's picked pieces grouped by their pick_session's created_by.
 *  - By-shape  = today's picked pieces grouped by shape.
 * Refetches whenever `refreshKey` bumps (a scan / undo in the terminal) and on a
 * gentle poll so other pickers' progress shows up without a manual reload.
 */

const POLL_MS = 45_000

interface PieceRow { id: string; shape: string | null; size: string | null; colour: string | null; pick_session_id: string | null }
interface SessionRow { id: string; created_by: string | null }
interface AccessRow { id: string; email: string; user_id: string | null }

// Start of "today" in IST (UTC+5:30), returned as a UTC ISO string for the query filter.
function istDayStartUtcISO(): string {
  const now = new Date()
  const istNow = new Date(now.getTime() + 5.5 * 3600 * 1000) // shift wall clock into IST
  const y = istNow.getUTCFullYear(), m = istNow.getUTCMonth(), d = istNow.getUTCDate()
  const startMs = Date.UTC(y, m, d, 0, 0, 0) - 5.5 * 3600 * 1000 // IST midnight expressed in UTC
  return new Date(startMs).toISOString()
}

export default function PickDayStats({ userId, refreshKey }: { userId: string; refreshKey: number }) {
  const supabase = useMemo(() => createClient(), [])
  const [pieces, setPieces] = useState<PieceRow[]>([])
  const [sessById, setSessById] = useState<Record<string, string | null>>({})
  const [userMap, setUserMap] = useState<Record<string, string>>({}) // any id (user_id/id/email) -> email
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const since = istDayStartUtcISO()
      const { data: pcs, error: pErr } = await supabase.from('pieces')
        .select('id, shape, size, colour, pick_session_id')
        .eq('status', 'picked')
        .gte('picked_at', since)
      if (pErr) throw pErr
      const rows: PieceRow[] = (pcs as PieceRow[]) || []
      setPieces(rows)

      const sessionIds = [...new Set(rows.map(r => r.pick_session_id).filter((x): x is string => !!x))]
      if (sessionIds.length) {
        const { data: sess, error: sErr } = await supabase.from('pick_sessions')
          .select('id, created_by').in('id', sessionIds)
        if (sErr) throw sErr
        const map: Record<string, string | null> = {}
        for (const s of (sess as SessionRow[]) || []) map[s.id] = s.created_by
        setSessById(map)
      } else {
        setSessById({})
      }

      // Best-effort name resolution. This route may be permission-gated for non-admins,
      // so a failure here must NOT break the stats — we just fall back to "You" / short id.
      try {
        const res = await fetch('/api/access/all')
        if (res.ok) {
          const j = await res.json()
          const list: AccessRow[] = Array.isArray(j) ? j : (j?.users || [])
          const map: Record<string, string> = {}
          for (const u of list) {
            if (u.email) {
              if (u.user_id) map[u.user_id] = u.email
              if (u.id) map[u.id] = u.email
              map[u.email] = u.email
            }
          }
          setUserMap(map)
        }
      } catch { /* ignore — names are optional */ }

      setUpdatedAt(new Date())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => {
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const labelFor = useCallback((createdBy: string | null): string => {
    if (!createdBy) return 'Unattributed'
    if (createdBy === userId) return 'You'
    const email = userMap[createdBy]
    if (email) return email.split('@')[0]
    return 'Picker ' + createdBy.slice(0, 4)
  }, [userId, userMap])

  const total = pieces.length

  const perPicker = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of pieces) {
      const key = p.pick_session_id ? (sessById[p.pick_session_id] ?? '∅') : '∅'
      counts[key] = (counts[key] || 0) + 1
    }
    return Object.entries(counts)
      .map(([key, count]) => ({ label: labelFor(key === '∅' ? null : key), count, isYou: key === userId }))
      .sort((a, b) => b.count - a.count)
  }, [pieces, sessById, labelFor, userId])

  const byShape = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of pieces) {
      const key = p.shape || '—'
      counts[key] = (counts[key] || 0) + 1
    }
    return Object.entries(counts).map(([shape, count]) => ({ shape, count })).sort((a, b) => b.count - a.count)
  }, [pieces])

  const card = { background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)' }
  const chip = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999,
    border: '1px solid var(--border)', background: 'var(--bg2)', fontSize: 12, fontWeight: 600, color: 'var(--text2)',
  } as const

  return (
    <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 32, fontWeight: 800, color: 'var(--accent)', lineHeight: 1 }}>{loading && !updatedAt ? '—' : total}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)' }}>picked today</span>
        </div>
        <button onClick={() => void load()} title="Refresh"
          style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
          ↻ {updatedAt ? updatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '…'}
        </button>
      </div>

      {err && (
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--critical)' }}>Stats error: {err}</div>
      )}

      {total > 0 && (
        <>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>By picker</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {perPicker.map(p => (
                <span key={p.label} style={{ ...chip, ...(p.isYou ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}>
                  {p.label}
                  <span style={{ fontWeight: 800, color: 'var(--text)' }}>{p.count}</span>
                </span>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>By shape</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {byShape.slice(0, 8).map(s => (
                <span key={s.shape} style={chip}>
                  {s.shape}
                  <span style={{ fontWeight: 800, color: 'var(--text)' }}>{s.count}</span>
                </span>
              ))}
              {byShape.length > 8 && <span style={{ ...chip, color: 'var(--text3)' }}>+{byShape.length - 8} more</span>}
            </div>
          </div>
        </>
      )}

      {total === 0 && !loading && (
        <div style={{ fontSize: 13, color: 'var(--text3)' }}>No pieces picked yet today. Scan a barcode to start.</div>
      )}
    </div>
  )
}
