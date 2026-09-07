'use client'
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { Search, RefreshCw, ChevronRight, ChevronDown, Check, X, Clock, History } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }
const OWNER_EMAIL = 'adityaramnani91581@gmail.com'
type Platform = 'amazon' | 'flipkart' | 'd2c'
const PLATFORMS: { key: Platform; label: string }[] = [{ key: 'amazon', label: 'Amazon' }, { key: 'flipkart', label: 'Flipkart' }, { key: 'd2c', label: 'D2C' }]

// Colour bands: 1d green · 2-4d amber · >4d light red. "—" = not set.
function band(days: number | null | undefined): { bg: string; fg: string } {
  if (days == null) return { bg: 'transparent', fg: 'var(--text3)' }
  if (days <= 1) return { bg: 'var(--dispatched-bg)', fg: 'var(--dispatched)' }
  if (days <= 4) return { bg: 'var(--today-bg)', fg: 'var(--today)' }
  return { bg: 'var(--critical-bg)', fg: 'var(--critical)' }
}

interface SkuMapRow { id: string; master_sku: string; product_name: string | null }
interface HTRow { master_sku: string; amazon_days: number | null; flipkart_days: number | null; d2c_days: number | null }
interface ReqRow { id: string; master_sku: string; platform: Platform; from_days: number | null; to_days: number; reason: string | null; status: string; requested_by: string | null; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null }

export default function HandlingTimeTab({ userEmail }: { userEmail: string }) {
  const supabase = createClient()
  const [skus, setSkus] = useState<SkuMapRow[]>([])
  const [ht, setHt] = useState<Record<string, HTRow>>({})
  const [reqs, setReqs] = useState<ReqRow[]>([])
  const [stock, setStock] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [reqModal, setReqModal] = useState<{ sku: string; platform: Platform; current: number | null } | null>(null)
  const [reviewModal, setReviewModal] = useState<ReqRow | null>(null)
  const [editCell, setEditCell] = useState<{ sku: string; platform: Platform } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [maps, hts, rqs] = await Promise.all([
      fetchAllRows<SkuMapRow>((from, to) => supabase.from('dispatch_sku_map').select('id, master_sku, product_name').order('master_sku').range(from, to)),
      fetchAllRows<HTRow>((from, to) => supabase.from('handling_times').select('*').range(from, to)),
      fetchAllRows<ReqRow>((from, to) => supabase.from('handling_change_requests').select('*').order('requested_at', { ascending: false }).range(from, to)),
    ])
    const htMap: Record<string, HTRow> = {}
    for (const h of hts) htMap[h.master_sku] = h
    setSkus(maps); setHt(htMap); setReqs(rqs)
    // stock per master sku (stocked packed units)
    const units = await fetchAllRows<{ sku: string | null }>((from, to) => supabase.from('packed_units').select('sku').eq('status', 'stocked').range(from, to))
    const st: Record<string, number> = {}
    for (const u of units) { const k = (u.sku || '').trim(); if (k) st[k] = (st[k] || 0) + 1 }
    setStock(st); setLoading(false)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  const pendingBySku = useMemo(() => {
    const m: Record<string, ReqRow[]> = {}
    for (const r of reqs) if (r.status === 'pending') (m[r.master_sku] ??= []).push(r)
    return m
  }, [reqs])
  const pendingCount = useMemo(() => reqs.filter(r => r.status === 'pending').length, [reqs])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return skus
    return skus.filter(s => s.master_sku.toLowerCase().includes(term) || (s.product_name || '').toLowerCase().includes(term))
  }, [skus, q])

  const daysFor = (sku: string, p: Platform): number | null => { const h = ht[sku]; return h ? (h[`${p}_days` as keyof HTRow] as number | null) : null }

  // Inline-set the current live value directly (initial setup / manual correction — logged as a self-approved change).
  const setValue = async (sku: string, p: Platform, val: number | null) => {
    const existing = ht[sku]
    const patch = { master_sku: sku, [`${p}_days`]: val, updated_at: new Date().toISOString(), updated_by: userEmail }
    await supabase.from('handling_times').upsert(patch, { onConflict: 'master_sku' })
    setHt(prev => ({ ...prev, [sku]: { master_sku: sku, amazon_days: existing?.amazon_days ?? null, flipkart_days: existing?.flipkart_days ?? null, d2c_days: existing?.d2c_days ?? null, [`${p}_days`]: val } as HTRow }))
    setEditCell(null)
  }

  const submitRequest = async (sku: string, p: Platform, current: number | null, to: number, reason: string) => {
    const { data } = await supabase.from('handling_change_requests').insert({
      master_sku: sku, platform: p, from_days: current, to_days: to, reason: reason.trim() || null, status: 'pending', requested_by: userEmail,
    }).select().maybeSingle()
    if (data) setReqs(prev => [data as ReqRow, ...prev])
    setReqModal(null)
  }

  const decide = async (r: ReqRow, status: 'approved' | 'rejected', note: string) => {
    const now = new Date().toISOString()
    await supabase.from('handling_change_requests').update({ status, decided_by: userEmail, decided_at: now, decision_note: note.trim() || null }).eq('id', r.id)
    if (status === 'approved') await setValue(r.master_sku, r.platform, r.to_days)
    setReqs(prev => prev.map(x => x.id === r.id ? { ...x, status, decided_by: userEmail, decided_at: now, decision_note: note.trim() || null } : x))
    setReviewModal(null)
  }

  const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16, maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Handling Time</h1>
        {pendingCount > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', background: 'var(--critical)', borderRadius: 20, padding: '1px 9px' }}>{pendingCount} pending</span>}
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>Keep handling as low as possible · source of truth (set manually)</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 7, padding: '6px 10px', background: 'var(--surface)' }}>
            <Search size={14} style={{ color: 'var(--text3)' }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search SKU / product" style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, outline: 'none', width: 160 }} />
          </div>
          <button onClick={load} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text2)', cursor: 'pointer', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}><RefreshCw size={12} /> Refresh</button>
        </div>
      </div>

      {loading ? (
        <div style={{ ...card, padding: 30, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' as const }}>
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13, minWidth: 700 }}>
              <thead>
                <tr style={{ background: 'var(--bg2)', color: 'var(--text3)', fontSize: 11 }}>
                  <th style={{ padding: '9px 12px', textAlign: 'left' as const }}>SKU / Product</th>
                  <th style={{ padding: '9px 12px', textAlign: 'center' as const }}>Stock</th>
                  {PLATFORMS.map(p => <th key={p.key} style={{ padding: '9px 12px', textAlign: 'center' as const }}>{p.label}</th>)}
                  <th style={{ padding: '9px 12px' }} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, i) => {
                  const pend = pendingBySku[s.master_sku] || []
                  const hist = reqs.filter(r => r.master_sku === s.master_sku)
                  const isOpen = expanded === s.master_sku
                  return (
                    <Fragment key={s.master_sku}>
                      <tr style={{ borderTop: '1px solid var(--border)', background: pend.length ? 'var(--today-bg)' : (i % 2 ? 'var(--bg2)' : 'transparent') }}>
                        <td style={{ padding: '11px 12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <button onClick={() => setExpanded(isOpen ? null : s.master_sku)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0, display: 'flex' }}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                            <span style={{ fontWeight: 500 }}>{s.product_name || s.master_sku}</span>
                            {pend.length > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--today)', border: '1px solid #fed7aa', borderRadius: 4, padding: '0 5px' }}>pending</span>}
                          </div>
                          <div style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)', marginLeft: 20 }}>{s.master_sku}</div>
                        </td>
                        <td style={{ padding: '11px 12px', textAlign: 'center' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{stock[s.master_sku] ?? 0}</td>
                        {PLATFORMS.map(p => {
                          const d = daysFor(s.master_sku, p.key)
                          const b = band(d)
                          const pr = pend.find(x => x.platform === p.key)
                          const editingThis = editCell?.sku === s.master_sku && editCell?.platform === p.key
                          return (
                            <td key={p.key} style={{ padding: '11px 12px', textAlign: 'center' as const }}>
                              {editingThis ? (
                                <input autoFocus type="number" defaultValue={d ?? ''} onBlur={e => setValue(s.master_sku, p.key, e.target.value === '' ? null : parseInt(e.target.value))} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} style={{ width: 46, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--accent)', textAlign: 'center' as const, fontFamily: 'DM Mono' }} />
                              ) : (
                                <span onClick={() => setEditCell({ sku: s.master_sku, platform: p.key })} title="Click to set the current live value" style={{ cursor: 'pointer', fontFamily: 'DM Mono', fontWeight: 600, color: b.fg, background: b.bg, padding: '3px 9px', borderRadius: 6 }}>{d == null ? '—' : `${d}d`}</span>
                              )}
                              {pr && <div style={{ fontSize: 10, color: 'var(--today)', marginTop: 2 }}>→ {pr.to_days}d requested</div>}
                            </td>
                          )
                        })}
                        <td style={{ padding: '11px 12px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
                          {pend.length > 0
                            ? <button onClick={() => setReviewModal(pend[0])} style={{ fontSize: 12, padding: '5px 12px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Review</button>
                            : <button onClick={() => setReqModal({ sku: s.master_sku, platform: 'amazon', current: daysFor(s.master_sku, 'amazon') })} style={{ fontSize: 12, padding: '5px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontWeight: 600, cursor: 'pointer' }}>Request change</button>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr style={{ background: 'var(--bg2)' }}>
                          <td colSpan={3 + PLATFORMS.length} style={{ padding: '4px 12px 14px 32px' }}>
                            <div style={{ fontSize: 11, color: 'var(--text3)', margin: '6px 0 6px', display: 'flex', alignItems: 'center', gap: 5 }}><History size={12} /> Change history</div>
                            {hist.length === 0 ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>No changes yet.</div> : (
                              <table style={{ borderCollapse: 'collapse' as const, fontSize: 12 }}>
                                <tbody>
                                  {hist.map(r => (
                                    <tr key={r.id}>
                                      <td style={{ padding: '3px 14px 3px 0', fontFamily: 'DM Mono', textTransform: 'capitalize' as const }}>{r.platform}</td>
                                      <td style={{ padding: '3px 14px 3px 0', fontFamily: 'DM Mono' }}>{r.from_days ?? '—'}d → {r.to_days}d</td>
                                      <td style={{ padding: '3px 14px 3px 0', color: r.status === 'approved' ? 'var(--dispatched)' : r.status === 'rejected' ? 'var(--critical)' : 'var(--today)', fontWeight: 600, textTransform: 'capitalize' as const }}>{r.status}</td>
                                      <td style={{ padding: '3px 14px 3px 0', color: 'var(--text3)' }}>{r.reason || ''}</td>
                                      <td style={{ padding: '3px 0', color: 'var(--text3)' }}>by {(r.requested_by || '').split('@')[0]} · {fmt(r.requested_at)}{r.decided_by ? ` · ${r.status} by ${(r.decided_by).split('@')[0]}` : ''}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
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
      )}

      {reqModal && <RequestModal ctx={reqModal} onClose={() => setReqModal(null)} onSubmit={submitRequest} daysFor={daysFor} />}
      {reviewModal && <ReviewModal r={reviewModal} onClose={() => setReviewModal(null)} onDecide={decide} />}
    </div>
  )
}

const inp: React.CSSProperties = { padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, width: '100%', boxSizing: 'border-box' as const }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed' as const, inset: 0, zIndex: 600, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(420px,94vw)', background: 'var(--surface)', borderRadius: 14, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)' }}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function RequestModal({ ctx, onClose, onSubmit, daysFor }: { ctx: { sku: string; platform: Platform; current: number | null }; onClose: () => void; onSubmit: (sku: string, p: Platform, current: number | null, to: number, reason: string) => void; daysFor: (sku: string, p: Platform) => number | null }) {
  const [platform, setPlatform] = useState<Platform>(ctx.platform)
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const current = daysFor(ctx.sku, platform)
  return (
    <Modal title={`Request change · ${ctx.sku}`} onClose={onClose}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 5, fontWeight: 600 }}>Platform</label>
      <select value={platform} onChange={e => setPlatform(e.target.value as Platform)} style={{ ...inp, marginBottom: 12, cursor: 'pointer' }}>
        {PLATFORMS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>
      <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>Current: <b style={{ fontFamily: 'DM Mono' }}>{current == null ? 'not set' : `${current}d`}</b></div>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 5, fontWeight: 600 }}>Requested handling (days)</label>
      <input type="number" value={to} onChange={e => setTo(e.target.value)} placeholder="e.g. 1" style={{ ...inp, marginBottom: 12 }} />
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 5, fontWeight: 600 }}>Reason</label>
      <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. stock healthy, 71 in stock" style={{ ...inp, height: 56, resize: 'vertical' as const, marginBottom: 16 }} />
      <button disabled={to === ''} onClick={() => onSubmit(ctx.sku, platform, current, parseInt(to), reason)} style={{ width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: to === '' ? 'var(--bg2)' : 'var(--accent)', color: to === '' ? 'var(--text3)' : '#fff', fontWeight: 700, fontSize: 14, cursor: to === '' ? 'default' : 'pointer' }}>Submit request</button>
    </Modal>
  )
}

function ReviewModal({ r, onClose, onDecide }: { r: ReqRow; onClose: () => void; onDecide: (r: ReqRow, status: 'approved' | 'rejected', note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <Modal title={`Review · ${r.master_sku} · ${r.platform}`} onClose={onClose}>
      <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}><b style={{ fontFamily: 'DM Mono' }}>{r.from_days ?? '—'}d → {r.to_days}d</b> requested by {(r.requested_by || '').split('@')[0]}</div>
      {r.reason && <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>&ldquo;{r.reason}&rdquo;</div>}
      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8, background: 'var(--bg2)', padding: '8px 10px', borderRadius: 7 }}>Set this on {r.platform === 'amazon' ? 'Amazon Seller Central' : r.platform === 'flipkart' ? 'Flipkart Seller Hub' : 'your D2C site'} first, then approve to record it as live.</div>
      <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)" style={{ ...inp, height: 48, resize: 'vertical' as const, marginBottom: 14 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onDecide(r, 'approved', note)} style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: 'var(--dispatched)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}><Check size={15} /> Approve &amp; mark live ({r.to_days}d)</button>
        <button onClick={() => onDecide(r, 'rejected', note)} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--critical)', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Reject</button>
      </div>
    </Modal>
  )
}
