'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import DrumDatePicker from './DrumDatePicker'
import { Plus, Trash2, ChevronRight, Tag, Check, Square, CheckSquare } from 'lucide-react'

// Phase C — time-boxed promotions. During an event, a SKU's expected price is
// base × (1 − discount%), and (if set) the platform charges a REDUCED commission
// rate. The reward is the commission saved = (normal rate − reduced rate) × principal.
interface EventSku { id: string; sku: string; discount_pct: number; off_amazon: number | null; off_flipkart: number | null }
interface DiscEvent { id: string; name: string; platform: string; start_date: string; end_date: string; skus: EventSku[] }
interface MasterSku { sku: string; name: string }
const PLATFORMS = ['Amazon', 'Flipkart', 'Website', 'Both'] as const

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }
const input = { padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const }
const fmtDate = (s: string) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const platColor = (p: string) => p === 'Amazon' ? { fg: '#b45309', bg: '#fef3c7' } : p === 'Flipkart' ? { fg: '#2563eb', bg: '#eff6ff' } : p === 'Website' ? { fg: '#7c3aed', bg: '#f5f3ff' } : { fg: 'var(--text2)', bg: 'var(--bg2)' }

interface BulkState { disc: string; commA: string; commF: string; filter: string; sel: Record<string, boolean>; init: boolean }

export default function DiscountEvents() {
  const supabase = createClient()
  const [events, setEvents] = useState<DiscEvent[]>([])
  const [masterSkus, setMasterSkus] = useState<MasterSku[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [ev, setEv] = useState({ name: '', platform: 'Both', start: '', end: '' })
  const [bulk, setBulk] = useState<Record<string, BulkState>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: evs } = await supabase.from('recon_discount_events').select('*').order('start_date', { ascending: false })
      const { data: sks } = await supabase.from('recon_discount_event_skus').select('*')
      const byEvent: Record<string, EventSku[]> = {}
      for (const s of (sks || []) as Record<string, unknown>[]) {
        const eid = String(s.event_id)
        const legacy = s.commission_rate == null ? null : Number(s.commission_rate)
        ;(byEvent[eid] ??= []).push({ id: String(s.id), sku: String(s.sku ?? ''), discount_pct: Number(s.discount_pct ?? 0), off_amazon: s.commission_off_amazon == null ? legacy : Number(s.commission_off_amazon), off_flipkart: s.commission_off_flipkart == null ? legacy : Number(s.commission_off_flipkart) })
      }
      setEvents((evs || []).map((e: Record<string, unknown>) => ({
        id: String(e.id), name: String(e.name ?? ''), platform: String(e.platform ?? 'Both'),
        start_date: String(e.start_date ?? ''), end_date: String(e.end_date ?? ''), skus: byEvent[String(e.id)] || [],
      })))
    } catch (e) { setMsg({ ok: false, text: 'Load failed: ' + (e as Error).message }) }
    setLoading(false)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  // Master SKU list (from the sheet) for the select/deselect picker.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/recon/master'); if (!res.ok) return
        const j = await res.json(); const skus = j.skus || {}
        const seen = new Set<string>(); const list: MasterSku[] = []
        for (const k of Object.keys(skus)) { const p = skus[k]; const ms = (p.masterSku || '').trim(); if (ms && !seen.has(ms)) { seen.add(ms); list.push({ sku: ms, name: p.productName || '' }) } }
        list.sort((a, b) => a.sku.localeCompare(b.sku))
        setMasterSkus(list)
      } catch { /* non-fatal */ }
    })()
  }, [])

  const addEvent = async () => {
    const name = ev.name.trim()
    if (!name) { setMsg({ ok: false, text: 'Name the event.' }); return }
    if (!ev.start || !ev.end) { setMsg({ ok: false, text: 'Set start and end dates.' }); return }
    if (ev.end < ev.start) { setMsg({ ok: false, text: 'End date is before start date.' }); return }
    setSaving(true); setMsg(null)
    try {
      const { error } = await supabase.from('recon_discount_events').insert({ name, platform: ev.platform, start_date: ev.start, end_date: ev.end })
      if (error) throw error
      setMsg({ ok: true, text: `Added event "${name}".` })
      setEv({ name: '', platform: 'Both', start: '', end: '' })
      void load()
    } catch (e) { setMsg({ ok: false, text: 'Add failed: ' + (e as Error).message }) }
    setSaving(false)
  }

  const deleteEvent = async (id: string) => {
    setMsg(null)
    const { error } = await supabase.from('recon_discount_events').delete().eq('id', id)
    if (error) { setMsg({ ok: false, text: 'Delete failed: ' + error.message }); return }
    setEvents(prev => prev.filter(e => e.id !== id))
  }

  const deleteSku = async (id: string, eventId: string) => {
    const { error } = await supabase.from('recon_discount_event_skus').delete().eq('id', id)
    if (error) { setMsg({ ok: false, text: 'Delete failed: ' + error.message }); return }
    setEvents(prev => prev.map(e => e.id === eventId ? { ...e, skus: e.skus.filter(s => s.id !== id) } : e))
  }

  const getBulk = (eid: string): BulkState => bulk[eid] || { disc: '', commA: '', commF: '', filter: '', sel: {}, init: false }
  const setBulkFor = (eid: string, patch: Partial<BulkState>) => setBulk(prev => ({ ...prev, [eid]: { ...getBulk(eid), ...patch } }))
  // Lazily default-select every master SKU the first time the panel opens.
  const ensureInit = (eid: string) => { const b = getBulk(eid); if (!b.init) { const sel: Record<string, boolean> = {}; for (const m of masterSkus) sel[m.sku] = true; setBulkFor(eid, { sel, init: true }) } }

  const applyBulk = async (eventId: string) => {
    const b = getBulk(eventId)
    const disc = parseFloat(b.disc)
    const commA = b.commA.trim() === '' ? null : parseFloat(b.commA)
    const commF = b.commF.trim() === '' ? null : parseFloat(b.commF)
    if (isNaN(disc)) { setMsg({ ok: false, text: 'Enter a discount %.' }); return }
    const chosen = masterSkus.filter(m => b.sel[m.sku]).map(m => m.sku)
    if (!chosen.length) { setMsg({ ok: false, text: 'No SKUs selected.' }); return }
    setSaving(true); setMsg(null)
    try {
      // Replace any existing rows for these SKUs in this event, then insert fresh.
      await supabase.from('recon_discount_event_skus').delete().eq('event_id', eventId).in('sku', chosen)
      const rows = chosen.map(sku => ({ event_id: eventId, sku, discount_pct: disc, commission_off_amazon: commA, commission_off_flipkart: commF }))
      const { error } = await supabase.from('recon_discount_event_skus').insert(rows)
      if (error) throw error
      setMsg({ ok: true, text: `Applied ${disc}% off to ${chosen.length} SKU(s)${commA != null ? ` · AMZ −${commA}%` : ''}${commF != null ? ` · FK −${commF}%` : ''}.` })
      void load()
    } catch (e) { setMsg({ ok: false, text: 'Apply failed: ' + (e as Error).message }) }
    setSaving(false)
  }

  // Quick single add — supports __ALL__ for a blanket.
  const addOne = async (eventId: string, sku: string, disc: string, commA: string, commF: string) => {
    const s = sku.trim(), d = parseFloat(disc)
    const cA = commA.trim() === '' ? null : parseFloat(commA), cF = commF.trim() === '' ? null : parseFloat(commF)
    if (!s) { setMsg({ ok: false, text: 'Enter a SKU (or __ALL__).' }); return }
    if (isNaN(d)) { setMsg({ ok: false, text: 'Enter a discount %.' }); return }
    setMsg(null)
    await supabase.from('recon_discount_event_skus').delete().eq('event_id', eventId).eq('sku', s)
    const { error } = await supabase.from('recon_discount_event_skus').insert({ event_id: eventId, sku: s, discount_pct: d, commission_off_amazon: cA, commission_off_flipkart: cF })
    if (error) { setMsg({ ok: false, text: 'Add failed: ' + error.message }); return }
    void load()
  }

  return (
    <div style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column' as const, gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 4px' }}>Discount events</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>Time-boxed promotions. During an event, expected price = base × (1 − discount%), and the <strong>commission off</strong> is deducted (in percentage points) from your rate-card commission — so it applies correctly to above/below-threshold tiers. The reward is the commission saved. Use <code style={{ background: 'var(--bg2)', padding: '1px 5px', borderRadius: 4 }}>__ALL__</code> for every SKU.</p>
      </div>

      {msg && <div style={{ borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: `1px solid ${msg.ok ? '#bbf7d0' : '#fecaca'}`, background: msg.ok ? 'var(--dispatched-bg)' : 'var(--critical-bg)', color: msg.ok ? 'var(--dispatched)' : 'var(--critical)' }}>{msg.text}</div>}

      {/* Add event */}
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Add an event</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Name</span><input value={ev.name} onChange={e => setEv(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Great Indian Festival" style={{ ...input, width: 240 }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Platform</span><select value={ev.platform} onChange={e => setEv(p => ({ ...p, platform: e.target.value }))} style={{ ...input, cursor: 'pointer' }}>{PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Start</span><DrumDatePicker value={ev.start} onChange={v => setEv(p => ({ ...p, start: v }))} placeholder="Start" /></div>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>End</span><DrumDatePicker value={ev.end} min={ev.start || undefined} onChange={v => setEv(p => ({ ...p, end: v }))} placeholder="End" /></div>
          <button onClick={addEvent} disabled={saving} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: saving ? 'var(--bg2)' : 'var(--accent)', color: saving ? 'var(--text3)' : '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add event</button>
        </div>
      </div>

      {loading ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : !events.length ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No discount events yet — add one above.</div>
      ) : events.map(e => {
        const c = platColor(e.platform); const isOpen = open[e.id] ?? false; const b = getBulk(e.id)
        const filtered = masterSkus.filter(m => !b.filter || m.sku.toLowerCase().includes(b.filter.toLowerCase()) || m.name.toLowerCase().includes(b.filter.toLowerCase()))
        const selCount = masterSkus.filter(m => b.sel[m.sku]).length
        return (
          <div key={e.id} style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }} onClick={() => setOpen(p => ({ ...p, [e.id]: !isOpen }))}>
              <span style={{ display: 'inline-flex', transition: 'transform .15s', transform: isOpen ? 'rotate(90deg)' : 'none' }}><ChevronRight size={15} /></span>
              <Tag size={14} style={{ color: 'var(--text3)' }} />
              <span style={{ fontWeight: 700, fontSize: 14 }}>{e.name}</span>
              <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, color: c.fg, background: c.bg, padding: '2px 7px', borderRadius: 4 }}>{e.platform}</span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{fmtDate(e.start_date)} → {fmtDate(e.end_date)}</span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>· {e.skus.length} SKU{e.skus.length === 1 ? '' : 's'}</span>
              <button onClick={ev2 => { ev2.stopPropagation(); if (confirm(`Delete event "${e.name}" and its ${e.skus.length} SKU discount(s)?`)) void deleteEvent(e.id) }} title="Delete event" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'inline-flex' }}><Trash2 size={15} /></button>
            </div>
            {isOpen && (
              <div style={{ borderTop: '1px solid var(--border)', padding: 14, display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
                {/* Existing SKU discounts */}
                {e.skus.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                    {e.skus.map(s => (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg2)', borderRadius: 6, padding: '6px 10px' }}>
                        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: s.sku === '__ALL__' ? 'var(--accent)' : 'var(--text)', fontWeight: s.sku === '__ALL__' ? 700 : 400, minWidth: 160 }}>{s.sku === '__ALL__' ? 'All SKUs' : s.sku}</span>
                        <span style={{ fontFamily: 'DM Mono', fontSize: 12, fontWeight: 700, color: 'var(--today)' }}>{s.discount_pct}% off</span>
                        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: (s.off_amazon != null || s.off_flipkart != null) ? 'var(--accent)' : 'var(--text3)' }}>{(s.off_amazon != null || s.off_flipkart != null) ? `comm off ${s.off_amazon != null ? `AMZ −${s.off_amazon}%` : ''}${s.off_amazon != null && s.off_flipkart != null ? ' · ' : ''}${s.off_flipkart != null ? `FK −${s.off_flipkart}%` : ''}` : 'comm unchanged'}</span>
                        <button onClick={() => deleteSku(s.id, e.id)} title="Remove" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'inline-flex' }}><Trash2 size={13} /></button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Bulk select/deselect */}
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column' as const, gap: 10 }} onMouseEnter={() => ensureInit(e.id)}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>Add discount to many SKUs — deselect the ones not participating</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const, alignItems: 'center' }}>
                    <input value={b.disc} onChange={ch => setBulkFor(e.id, { disc: ch.target.value })} inputMode="decimal" placeholder="Discount %" style={{ ...input, width: 110, fontFamily: 'DM Mono' }} />
                    <input value={b.commA} onChange={ch => setBulkFor(e.id, { commA: ch.target.value })} inputMode="decimal" placeholder="Amazon comm off %" style={{ ...input, width: 160, fontFamily: 'DM Mono' }} />
                    <input value={b.commF} onChange={ch => setBulkFor(e.id, { commF: ch.target.value })} inputMode="decimal" placeholder="Flipkart comm off %" style={{ ...input, width: 160, fontFamily: 'DM Mono' }} />
                    <input value={b.filter} onChange={ch => setBulkFor(e.id, { filter: ch.target.value })} placeholder="Filter SKUs…" style={{ ...input, width: 180 }} />
                    <button onClick={() => { ensureInit(e.id); const sel = { ...b.sel }; for (const m of filtered) sel[m.sku] = true; setBulkFor(e.id, { sel }) }} style={{ ...chipBtn }}>Select all</button>
                    <button onClick={() => { const sel = { ...b.sel }; for (const m of filtered) sel[m.sku] = false; setBulkFor(e.id, { sel }) }} style={{ ...chipBtn }}>Clear</button>
                  </div>
                  <div style={{ maxHeight: 220, overflowY: 'auto' as const, border: '1px solid var(--border)', borderRadius: 6 }}>
                    {masterSkus.length === 0 ? <div style={{ padding: 12, fontSize: 12, color: 'var(--text3)' }}>Loading SKUs from master sheet…</div> :
                      filtered.map(m => {
                        const on = !!b.sel[m.sku]
                        return (
                          <div key={m.sku} onClick={() => { ensureInit(e.id); setBulkFor(e.id, { sel: { ...b.sel, [m.sku]: !on } }) }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)', background: on ? 'var(--surface)' : 'var(--bg2)' }}>
                            {on ? <CheckSquare size={14} style={{ color: 'var(--accent)' }} /> : <Square size={14} style={{ color: 'var(--text3)' }} />}
                            <span style={{ fontFamily: 'DM Mono', fontSize: 11.5, color: on ? 'var(--text)' : 'var(--text3)' }}>{m.sku}</span>
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{m.name}</span>
                          </div>
                        )
                      })}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button onClick={() => applyBulk(e.id)} disabled={saving} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: saving ? 'var(--bg2)' : 'var(--accent)', color: saving ? 'var(--text3)' : '#fff', fontSize: 12.5, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Check size={14} /> Apply to {selCount} selected SKU{selCount === 1 ? '' : 's'}</button>
                    <SingleAdd onAdd={(sku, disc, cA, cF) => addOne(e.id, sku, disc, cA, cF)} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SingleAdd({ onAdd }: { onAdd: (sku: string, disc: string, commA: string, commF: string) => void }) {
  const [sku, setSku] = useState(''); const [disc, setDisc] = useState(''); const [commA, setCommA] = useState(''); const [commF, setCommF] = useState('')
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' as const, marginLeft: 'auto' }}>
      <input value={sku} onChange={e => setSku(e.target.value)} placeholder="SKU or __ALL__" style={{ ...input, width: 140, fontFamily: 'DM Mono' }} />
      <input value={disc} onChange={e => setDisc(e.target.value)} inputMode="decimal" placeholder="Disc %" style={{ ...input, width: 70, fontFamily: 'DM Mono' }} />
      <input value={commA} onChange={e => setCommA(e.target.value)} inputMode="decimal" placeholder="AMZ off %" style={{ ...input, width: 85, fontFamily: 'DM Mono' }} />
      <input value={commF} onChange={e => setCommF(e.target.value)} inputMode="decimal" placeholder="FK off %" style={{ ...input, width: 80, fontFamily: 'DM Mono' }} />
      <button onClick={() => { onAdd(sku, disc, commA, commF); setSku(''); setDisc(''); setCommA(''); setCommF('') }} style={{ ...chipBtn }}><Plus size={13} /> Add one</button>
    </div>
  )
}

const chipBtn: React.CSSProperties = { padding: '7px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }
