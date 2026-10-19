'use client'
import { useEffect, useMemo, useState } from 'react'
import {
  FeatureRequest, ReqStatus, ReqPriority, STATUS_LABEL, PRIORITY_LABEL,
  STATUS_RANK, PRIORITY_RANK, relativeTime, requestsToCsv,
} from '@/lib/requests'
import { Download, X, Trash2, Pencil, ExternalLink, Check, ArrowRight } from 'lucide-react'

const cyclePri = (p: ReqPriority): ReqPriority => (p === 'low' ? 'med' : p === 'med' ? 'high' : 'low')

// The Requests tab. Owners (can_owner) see everything with filters + batch
// triage; everyone else sees only the requests they submitted and can edit or
// delete their own while still Open.

type StatusFilter = 'all' | ReqStatus

export default function RequestsTab({
  userEmail, onNavigate, onCountChange,
}: {
  userEmail: string; onNavigate?: (tabKey: string) => void; onCountChange?: (openCount: number) => void
}) {
  const [rows, setRows] = useState<FeatureRequest[]>([])
  const [isManager, setIsManager] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const [fStatus, setFStatus] = useState<StatusFilter>('all')
  const [fPri, setFPri] = useState<'all' | ReqPriority>('all')
  const [fTab, setFTab] = useState<string>('all')
  const [fWho, setFWho] = useState<string>('all')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [light, setLight] = useState<{ urls: string[]; idx: number } | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [eTitle, setETitle] = useState(''); const [eDetails, setEDetails] = useState(''); const [ePri, setEPri] = useState<ReqPriority>('med')

  const load = async () => {
    setErr('')
    try {
      const res = await fetch('/api/requests')
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not load requests') }
      const data = await res.json()
      const list = (data.rows || []) as FeatureRequest[]
      setRows(list); setIsManager(!!data.isManager)
      onCountChange?.(list.filter(r => r.status !== 'done').length)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load requests')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = useMemo(() => Array.from(new Set(rows.map(r => r.tab_label))).sort(), [rows])
  const whos = useMemo(() => Array.from(new Set(rows.map(r => r.created_by_name || r.created_by))).sort(), [rows])

  const counts = useMemo(() => {
    const c = { open: 0, in_progress: 0, done: 0 }
    rows.forEach(r => { c[r.status]++ })
    return c
  }, [rows])

  const filtered = useMemo(() => {
    let out = rows.slice()
    if (isManager) {
      if (fStatus !== 'all') out = out.filter(r => r.status === fStatus)
      if (fPri !== 'all') out = out.filter(r => r.priority === fPri)
      if (fTab !== 'all') out = out.filter(r => r.tab_label === fTab)
      if (fWho !== 'all') out = out.filter(r => (r.created_by_name || r.created_by) === fWho)
    }
    return out
  }, [rows, isManager, fStatus, fPri, fTab, fWho])

  const groups = useMemo(() => {
    const g: Record<string, FeatureRequest[]> = {}
    filtered.forEach(r => { (g[r.tab_label] = g[r.tab_label] || []).push(r) })
    Object.values(g).forEach(list => list.sort((a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      b.created_at.localeCompare(a.created_at)))
    return g
  }, [filtered])

  // ── mutations ──
  const call = async (opts: { method: string; body?: unknown; q?: string }) => {
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/requests${opts.q || ''}`, {
        method: opts.method,
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Update failed') }
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Update failed') }
    finally { setBusy(false) }
  }
  const setStatus = (id: string, status: ReqStatus) => call({ method: 'PATCH', body: { id, status } })
  const setPriority = (id: string, priority: ReqPriority) => call({ method: 'PATCH', body: { id, priority } })
  const batch = (status: ReqStatus) => { const ids = Array.from(sel); setSel(new Set()); call({ method: 'PATCH', body: { ids, status } }) }
  const del = (id: string) => call({ method: 'DELETE', q: `?id=${encodeURIComponent(id)}` })

  const startEdit = (r: FeatureRequest) => { setEditId(r.id); setETitle(r.title); setEDetails(r.details || ''); setEPri(r.priority) }
  const saveEdit = async () => { const id = editId!; setEditId(null); await call({ method: 'PATCH', body: { id, title: eTitle, details: eDetails, priority: ePri } }) }

  const toggleSel = (id: string) => setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const exportCsv = () => {
    const chosen = sel.size ? filtered.filter(r => sel.has(r.id)) : filtered
    const blob = new Blob([requestsToCsv(chosen)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `requests-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  // ── bits ──
  const StatusPill = ({ s }: { s: ReqStatus }) => {
    const col = s === 'open' ? 'var(--amber)' : s === 'in_progress' ? 'var(--hold)' : 'var(--green)'
    const bg = s === 'open' ? 'var(--amber-soft)' : s === 'in_progress' ? 'var(--hold-bg)' : 'var(--green-soft)'
    return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, borderRadius: 20, padding: '3px 9px', color: col, background: bg }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: col }} />{STATUS_LABEL[s]}
    </span>
  }
  const Flag = ({ p, onClick }: { p: ReqPriority; onClick?: () => void }) => {
    const col = p === 'high' ? 'var(--red)' : p === 'med' ? 'var(--amber)' : 'var(--text3)'
    const bg = p === 'high' ? 'var(--red-soft)' : p === 'med' ? 'var(--amber-soft)' : 'var(--line-2)'
    return <button onClick={onClick} disabled={!onClick} title={onClick ? 'Click to change priority' : undefined} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
      borderRadius: 5, padding: '2px 6px', color: col, background: bg, border: 'none', cursor: onClick ? 'pointer' : 'default',
    }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: col }} />{PRIORITY_LABEL[p]}</button>
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>Loading requests…</div>

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '4px 2px 120px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 21, fontWeight: 600, margin: 0, letterSpacing: '-.01em', color: 'var(--text)' }}>Requests</h1>
          <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 3 }}>
            {isManager ? 'Everything the team has flagged, grouped by the tab it belongs to.' : 'Requests you raised and where they stand. Only you and the owner can see these.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {([['open', 'var(--amber)'], ['in_progress', 'var(--hold)'], ['done', 'var(--green)']] as [ReqStatus, string][]).map(([k, col]) => (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 13px', minWidth: 76 }}>
              <b style={{ fontFamily: 'var(--font-mono)', fontSize: 19, fontWeight: 600, color: col }}>{counts[k]}</b>
              <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text3)' }}>{STATUS_LABEL[k]}</span>
            </div>
          ))}
        </div>
      </div>

      {isManager && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ display: 'inline-flex', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 2, gap: 1 }}>
            {(['all', 'open', 'in_progress', 'done'] as StatusFilter[]).map(s => (
              <button key={s} onClick={() => setFStatus(s)} style={{
                border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, padding: '5px 11px', borderRadius: 6,
                background: fStatus === s ? 'var(--text)' : 'transparent', color: fStatus === s ? '#fff' : 'var(--text2)',
              }}>{s === 'all' ? 'All' : STATUS_LABEL[s]}</button>
            ))}
          </div>
          <select value={fPri} onChange={e => setFPri(e.target.value as 'all' | ReqPriority)} style={selStyle}>
            <option value="all">All priorities</option><option value="high">High</option><option value="med">Medium</option><option value="low">Low</option>
          </select>
          <select value={fTab} onChange={e => setFTab(e.target.value)} style={selStyle}>
            <option value="all">All tabs</option>{tabs.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={fWho} onChange={e => setFWho(e.target.value)} style={selStyle}>
            <option value="all">All submitters</option>{whos.map(w => <option key={w} value={w}>{w}</option>)}
          </select>
          <button onClick={exportCsv} style={{ ...selStyle, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text2)' }}>
            <Download size={13} /> Export
          </button>
        </div>
      )}

      {isManager && sel.size > 0 && (
        <div style={{ position: 'sticky', top: 'env(safe-area-inset-top, 0px)', zIndex: 5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'var(--text)', color: '#fff', borderRadius: 10, padding: '9px 13px', marginBottom: 12 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{sel.size} selected</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => batch('in_progress')} disabled={busy} style={{ ...barBtn, background: 'var(--hold)' }}><ArrowRight size={13} /> In progress</button>
          <button onClick={() => batch('done')} disabled={busy} style={{ ...barBtn, background: 'var(--green)' }}><Check size={13} /> Mark done</button>
          <button onClick={() => setSel(new Set())} style={{ ...barBtn, background: 'rgba(255,255,255,.14)' }}>Clear</button>
        </div>
      )}

      {err && <div style={{ fontSize: 12.5, color: 'var(--red)', background: 'var(--red-soft)', padding: '9px 12px', borderRadius: 9, marginBottom: 12 }}>{err}</div>}

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '44px 16px', color: 'var(--text3)', fontSize: 13 }}>
          {rows.length === 0 ? 'No requests yet. Use the “+ Request” button on any tab to add one.' : 'Nothing matches these filters.'}
        </div>
      ) : (
        Object.keys(groups).map(tab => {
          const list = groups[tab]
          const key = list[0].tab_key
          return (
            <div key={tab} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 2px 8px' }}>
                <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text2)' }}>{tab}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 20, padding: '1px 8px' }}>{list.length}</span>
                {onNavigate && key !== 'unknown' && (
                  <button onClick={() => onNavigate(key)} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-sans)' }}>
                    Open tab <ExternalLink size={11} />
                  </button>
                )}
                <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {list.map(r => {
                  const mine = r.created_by === userEmail
                  const canSelect = isManager && r.status !== 'done'
                  const editing = editId === r.id
                  return (
                    <div key={r.id} style={{ display: 'flex', gap: 11, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 11, padding: '12px 13px', alignItems: 'flex-start', opacity: r.status === 'done' ? 0.64 : 1 }}>
                      {canSelect && (
                        <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggleSel(r.id)} style={{ width: 16, height: 16, marginTop: 2, accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {editing ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                            <input value={eTitle} onChange={e => setETitle(e.target.value)} style={inpSm} />
                            <textarea value={eDetails} onChange={e => setEDetails(e.target.value)} rows={2} placeholder="Details (optional)" style={{ ...inpSm, resize: 'vertical' as const }} />
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              {(['low', 'med', 'high'] as ReqPriority[]).map(p => (
                                <button key={p} onClick={() => setEPri(p)} style={{ fontSize: 11, fontWeight: 600, borderRadius: 6, padding: '4px 9px', cursor: 'pointer', border: `1px solid ${ePri === p ? 'var(--accent)' : 'var(--line)'}`, color: ePri === p ? 'var(--accent)' : 'var(--text2)', background: ePri === p ? 'var(--accent-soft)' : 'var(--panel-2)' }}>{PRIORITY_LABEL[p]}</button>
                              ))}
                              <span style={{ flex: 1 }} />
                              <button onClick={() => setEditId(null)} style={{ fontSize: 12, fontWeight: 600, border: '1px solid var(--line)', background: 'var(--panel-2)', color: 'var(--text2)', borderRadius: 7, padding: '5px 11px', cursor: 'pointer' }}>Cancel</button>
                              <button onClick={saveEdit} disabled={!eTitle.trim()} style={{ fontSize: 12, fontWeight: 600, border: 'none', background: 'var(--accent)', color: '#fff', borderRadius: 7, padding: '5px 11px', cursor: 'pointer' }}>Save</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', margin: '0 0 3px', textDecoration: r.status === 'done' ? 'line-through' : 'none' }}>{r.title}</p>
                            {r.details && <p style={{ fontSize: 12, color: 'var(--text2)', margin: '0 0 7px', whiteSpace: 'pre-wrap' }}>{r.details}</p>}
                            {!!(r.screenshot_urls && r.screenshot_urls.length) && (
                              <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                                {r.screenshot_urls.map((u, i) => (
                                  <button key={i} onClick={() => setLight({ urls: r.screenshot_urls!, idx: i })} style={{ width: 46, height: 46, borderRadius: 7, overflow: 'hidden', border: '1px solid var(--line)', padding: 0, cursor: 'pointer', background: 'var(--panel-2)' }}>
                                    <img src={u} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                  </button>
                                ))}
                              </div>
                            )}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 11, color: 'var(--text3)' }}>
                              <Flag p={r.priority} onClick={isManager ? () => setPriority(r.id, cyclePri(r.priority)) : undefined} />
                              <span>•</span>
                              <span style={{ fontWeight: 600, color: 'var(--text2)' }}>{r.created_by_name || r.created_by}{mine ? ' (you)' : ''}</span>
                              <span>•</span>
                              <span>{relativeTime(r.created_at)}</span>
                            </div>
                          </>
                        )}
                      </div>

                      {!editing && (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7, flexShrink: 0 }}>
                          {isManager ? (
                            <select value={r.status} onChange={e => setStatus(r.id, e.target.value as ReqStatus)} style={{ ...selStyle, padding: '4px 8px', fontSize: 11.5 }}>
                              <option value="open">Open</option><option value="in_progress">In progress</option><option value="done">Done</option>
                            </select>
                          ) : <StatusPill s={r.status} />}
                          {mine && r.status === 'open' && (
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button onClick={() => startEdit(r)} title="Edit" style={iconBtn}><Pencil size={13} /></button>
                              <button onClick={() => del(r.id)} title="Delete" style={iconBtn}><Trash2 size={13} /></button>
                            </div>
                          )}
                          {isManager && !mine && (
                            <button onClick={() => del(r.id)} title="Delete" style={{ ...iconBtn, color: 'var(--text3)' }}><Trash2 size={13} /></button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })
      )}

      {light && (
        <div onClick={() => setLight(null)} style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(27,25,23,.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <button onClick={() => setLight(null)} aria-label="Close" style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(255,255,255,.14)', border: 'none', color: '#fff', borderRadius: '50%', width: 36, height: 36, cursor: 'pointer', display: 'grid', placeItems: 'center' }}><X size={18} /></button>
          <img src={light.urls[light.idx]} alt="" onClick={e => e.stopPropagation()} style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 10, objectFit: 'contain' }} />
          {light.urls.length > 1 && (
            <div style={{ position: 'absolute', bottom: 20, display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
              {light.urls.map((_, i) => (
                <button key={i} onClick={() => setLight({ urls: light.urls, idx: i })} style={{ width: 9, height: 9, borderRadius: '50%', border: 'none', cursor: 'pointer', background: i === light.idx ? '#fff' : 'rgba(255,255,255,.4)' }} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const selStyle: React.CSSProperties = { fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--text2)', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }
const barBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: '#fff', borderRadius: 7, padding: '6px 12px' }
const iconBtn: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--text2)', borderRadius: 7, padding: '5px 7px', cursor: 'pointer', display: 'grid', placeItems: 'center' }
const inpSm: React.CSSProperties = { width: '100%', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text)', background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', boxSizing: 'border-box' }
