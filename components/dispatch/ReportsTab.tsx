'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Clock, Check, FileText, RefreshCw, Files } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }

interface ReqRow {
  id: string; report_type: string; report_label: string | null; params: { summary?: string } | null
  row_count: number | null; status: string; requested_by: string; requested_at: string
  decided_by: string | null; decided_at: string | null; reason: string | null; expires_at: string | null
}

const EXPIRE_DAYS = 7

export default function ReportsTab({ userEmail, isOwner, onPendingChange }: { userEmail: string; isOwner: boolean; onPendingChange?: (n: number) => void }) {
  const supabase = createClient()
  const [rows, setRows] = useState<ReqRow[]>([])
  const [loading, setLoading] = useState(true)
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('export_requests').select('*').order('requested_at', { ascending: false }).limit(200)
    if (!isOwner) q = q.eq('requested_by', userEmail)
    const { data } = await q
    const list = (data || []) as ReqRow[]
    setRows(list)
    setLoading(false)
    if (onPendingChange) onPendingChange(list.filter(r => r.status === 'pending').length)
  }, [supabase, isOwner, userEmail, onPendingChange])
  useEffect(() => { void load() }, [load])

  const decide = async (r: ReqRow, status: 'approved' | 'denied') => {
    const now = new Date()
    const patch: Record<string, unknown> = { status, decided_by: userEmail, decided_at: now.toISOString(), reason: (reasonDraft[r.id] || '').trim() || null }
    if (status === 'approved') patch.expires_at = new Date(now.getTime() + EXPIRE_DAYS * 86400000).toISOString()
    await supabase.from('export_requests').update(patch).eq('id', r.id)
    await supabase.from('export_log').insert({ request_id: r.id, report_type: r.report_type, actor: userEmail, action: status, row_count: r.row_count })
    setReasonDraft(p => { const n = { ...p }; delete n[r.id]; return n })
    await load()
  }

  const fmt = (d: string | null) => d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
  const expiresIn = (d: string | null) => { if (!d) return ''; const days = Math.ceil((new Date(d).getTime() - Date.now()) / 86400000); return days > 0 ? `expires in ${days}d` : 'expired' }
  const tabForType = (t: string) => ({ returns: 'Returns', recon: 'Recon', all_orders: 'All Orders', dispatched: 'Dispatched', demand: 'Plan', plan: 'Plan', calllens: 'CallLens' } as Record<string, string>)[t] || t

  const pending = rows.filter(r => r.status === 'pending')
  const approvedLive = rows.filter(r => r.status === 'approved' && r.expires_at && new Date(r.expires_at) > new Date())
  // Requester's own closed/denied requests read neutrally as "Closed".
  const myOther = rows.filter(r => r.status === 'denied' || (r.status === 'approved' && (!r.expires_at || new Date(r.expires_at) <= new Date())))

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16, maxWidth: 620 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Reports</h1>
        {isOwner && pending.length > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', background: 'var(--critical)', borderRadius: 20, padding: '1px 9px' }}>{pending.length} pending</span>}
        <button onClick={load} style={{ marginLeft: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text2)', cursor: 'pointer', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}><RefreshCw size={12} /> Refresh</button>
      </div>

      {loading ? (
        <div style={{ ...card, padding: 30, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          {/* Pending (owner approves; requester sees their own as awaiting) */}
          {pending.length > 0 && (
            <div style={{ ...card, overflow: 'hidden' as const }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--today-bg)', display: 'flex', alignItems: 'center', gap: 7 }}>
                <Clock size={14} style={{ color: 'var(--today)' }} /><span style={{ fontSize: 13, fontWeight: 700, color: 'var(--today)' }}>{isOwner ? `Pending approval (${pending.length})` : 'Awaiting approval'}</span>
              </div>
              {pending.map((r, i) => (
                <div key={r.id} style={{ padding: '12px 14px', borderBottom: i < pending.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{r.report_label || tabForType(r.report_type) + ' export'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', margin: '2px 0 10px' }}>{isOwner ? `${r.requested_by.split('@')[0]} · ` : ''}{r.row_count != null ? `${r.row_count} rows · ` : ''}{r.params?.summary ? `${r.params.summary} · ` : ''}{fmt(r.requested_at)}</div>
                  {isOwner ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
                      <input value={reasonDraft[r.id] ?? ''} onChange={e => setReasonDraft(p => ({ ...p, [r.id]: e.target.value }))} placeholder="Reason (optional)" style={{ flex: 1, minWidth: 120, padding: '6px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }} />
                      <button onClick={() => decide(r, 'approved')} style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: 'var(--dispatched)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><Check size={14} /> Approve</button>
                      <button onClick={() => decide(r, 'denied')} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Close</button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--today)' }}>Awaiting owner approval</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Approved & live */}
          <div style={{ ...card, overflow: 'hidden' as const }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}><Files size={14} style={{ color: 'var(--dispatched)' }} /> Approved reports</span>
              <span style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{approvedLive.length}</span>
            </div>
            {approvedLive.length === 0 ? (
              <div style={{ padding: 18, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No approved reports.</div>
            ) : approvedLive.map((r, i) => (
              <div key={r.id} style={{ padding: '11px 14px', borderBottom: i < approvedLive.length - 1 ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
                <FileText size={16} style={{ color: 'var(--text3)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{r.report_label || tabForType(r.report_type) + ' export'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{isOwner ? `${r.requested_by.split('@')[0]} · ` : ''}approved {fmt(r.decided_at)} · {expiresIn(r.expires_at)}</div>
                </div>
                <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap' as const }}>Download from {tabForType(r.report_type)}</span>
              </div>
            ))}
          </div>

          {/* Requester's neutral 'Closed' items */}
          {!isOwner && myOther.length > 0 && (
            <div style={{ ...card, overflow: 'hidden' as const }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', fontSize: 13, fontWeight: 700, color: 'var(--text3)' }}>Closed</div>
              {myOther.map((r, i) => (
                <div key={r.id} style={{ padding: '11px 14px', borderBottom: i < myOther.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{r.report_label || tabForType(r.report_type) + ' export'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>Closed{r.reason ? ` · ${r.reason}` : ''} · {fmt(r.decided_at || r.requested_at)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
