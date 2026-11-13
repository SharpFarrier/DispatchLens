'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Plus, Trash2, Search, X, RefreshCw, CalendarClock } from 'lucide-react'
import DrumDatePicker from './DrumDatePicker'

interface PriceRow { id: string; sku: string; price: number; effective_from: string; effective_to: string | null; source: string | null }
interface Era { column: string; from: string; to: string | null; count: number }
interface Preview { skusPriced: number; eraInserts: number; trims: number; splits: number; deletes: number; sample: { sku: string; price: number }[] }

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }
const input = { padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const }
const fmtDate = (s: string | null) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const money = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')
const prevDay = (iso: string) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10) }

export default function PriceMaster() {
  const supabase = createClient()
  const [rows, setRows] = useState<PriceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [form, setForm] = useState({ sku: '', price: '', from: '', to: '' })
  const [closePrev, setClosePrev] = useState(true)
  const [hasEnd, setHasEnd] = useState(false)
  const [syncing, setSyncing] = useState(false)
  // Dated price columns
  const [columns, setColumns] = useState<string[]>([])
  const [era, setEra] = useState({ col: '', from: '', to: '' })
  const [eraHasEnd, setEraHasEnd] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await supabase.from('recon_prices').select('*').order('sku').order('effective_from', { ascending: false })
      setRows((data || []).map((r: Record<string, unknown>) => ({
        id: String(r.id), sku: String(r.sku ?? ''), price: Number(r.price ?? 0),
        effective_from: String(r.effective_from ?? ''), effective_to: r.effective_to ? String(r.effective_to) : null,
        source: r.source ? String(r.source) : null,
      })))
    } catch (e) { setMsg({ ok: false, text: 'Load failed: ' + (e as Error).message }) }
    setLoading(false)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  // Sheet columns for the picker.
  useEffect(() => { (async () => {
    try { const r = await fetch('/api/recon/price-apply'); if (r.ok) { const j = await r.json(); setColumns(j.columns || []) } } catch { /* ignore */ }
  })() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? rows.filter(r => r.sku.toLowerCase().includes(q)) : rows
  }, [rows, search])

  // Applied price eras (grouped sheet-column rows) for the timeline.
  const eras = useMemo(() => {
    const m = new Map<string, Era>()
    for (const r of rows) {
      if (!r.source || !r.source.startsWith('sheet:')) continue
      const key = `${r.source}|${r.effective_from}|${r.effective_to || ''}`
      const e = m.get(key) || { column: r.source.slice(6), from: r.effective_from, to: r.effective_to, count: 0 }
      e.count++; m.set(key, e)
    }
    return [...m.values()].sort((a, b) => b.from.localeCompare(a.from))
  }, [rows])

  const addPrice = async () => {
    const sku = form.sku.trim(); const price = parseFloat(form.price)
    if (!sku) { setMsg({ ok: false, text: 'Enter a SKU.' }); return }
    if (isNaN(price)) { setMsg({ ok: false, text: 'Enter a valid price.' }); return }
    if (!form.from) { setMsg({ ok: false, text: 'Set an effective-from date.' }); return }
    if (form.to && form.to < form.from) { setMsg({ ok: false, text: 'Effective-to is before effective-from.' }); return }
    setSaving(true); setMsg(null)
    try {
      if (closePrev) {
        const { error: uErr } = await supabase.from('recon_prices').update({ effective_to: prevDay(form.from) })
          .eq('sku', sku).is('effective_to', null).lt('effective_from', form.from)
        if (uErr) throw uErr
      }
      const { error } = await supabase.from('recon_prices').insert({ sku, price, effective_from: form.from, effective_to: form.to || null })
      if (error) throw error
      setMsg({ ok: true, text: `Added ${money(price)} for ${sku}.` })
      setForm({ sku: '', price: '', from: '', to: '' }); setHasEnd(false)
      void load()
    } catch (e) { setMsg({ ok: false, text: 'Add failed: ' + (e as Error).message }) }
    setSaving(false)
  }

  // Apply (or preview) a sheet column across the chosen effective window.
  const runApply = async (dryRun: boolean) => {
    if (!era.col) { setMsg({ ok: false, text: 'Pick a sheet column.' }); return }
    if (!era.from) { setMsg({ ok: false, text: 'Set an effective-from date.' }); return }
    if (era.to && era.to < era.from) { setMsg({ ok: false, text: 'Effective-to is before effective-from.' }); return }
    setBusy(dryRun ? 'preview' : 'apply'); setMsg(null)
    try {
      const res = await fetch('/api/recon/price-apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ column: era.col, from: era.from, to: era.to || null, dryRun }) })
      const j = await res.json(); if (!res.ok) throw new Error(j.error || 'Failed')
      if (dryRun) { setPreview(j) }
      else {
        setPreview(null)
        setMsg({ ok: true, text: `Applied “${era.col}” — ${j.eraInserts} prices set for ${fmtDate(era.from)} → ${era.to ? fmtDate(era.to) : 'current'} (${j.trims} trimmed, ${j.splits} split, ${j.deletes} replaced).` })
        setEra({ col: '', from: '', to: '' }); setEraHasEnd(false); void load()
      }
    } catch (e) { setMsg({ ok: false, text: (dryRun ? 'Preview' : 'Apply') + ' failed: ' + (e as Error).message }) }
    setBusy(null)
  }

  const removeEra = async (e: Era) => {
    if (!confirm(`Remove the “${e.column}” price era (${fmtDate(e.from)} → ${e.to ? fmtDate(e.to) : 'current'})? This deletes the ${e.count} dated rows it wrote.`)) return
    setMsg(null)
    let q = supabase.from('recon_prices').delete().eq('source', 'sheet:' + e.column).eq('effective_from', e.from)
    q = e.to ? q.eq('effective_to', e.to) : q.is('effective_to', null)
    const { error } = await q
    if (error) { setMsg({ ok: false, text: 'Remove failed: ' + error.message }); return }
    setMsg({ ok: true, text: `Removed the “${e.column}” era.` }); void load()
  }

  const syncSheet = async () => {
    setSyncing(true); setMsg(null)
    try {
      const res = await fetch('/api/recon/price-sync', { method: 'POST' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Sync failed')
      setMsg({ ok: true, text: `Synced from sheet — ${j.created} new, ${j.changed} changed price${j.changed === 1 ? '' : 's'} (${j.scanned} SKUs scanned).` })
      void load()
    } catch (e) { setMsg({ ok: false, text: 'Sync failed: ' + (e as Error).message }) }
    setSyncing(false)
  }

  const remove = async (id: string) => {
    setMsg(null)
    const { error } = await supabase.from('recon_prices').delete().eq('id', id)
    if (error) { setMsg({ ok: false, text: 'Delete failed: ' + error.message }); return }
    setRows(prev => prev.filter(r => r.id !== id))
  }

  const th = { padding: '8px 10px', textAlign: 'left' as const, fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text3)', whiteSpace: 'nowrap' as const, background: 'var(--bg2)' }
  const lbl = { fontSize: 11, color: 'var(--text2)', fontWeight: 600 } as const

  return (
    <div style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column' as const, gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' as const }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 4px' }}>Price master</h2>
          <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>The base selling price per SKU, with dated history. The expected price for an order uses whichever price was in effect on its order date. Leave &ldquo;effective to&rdquo; blank for the current price.</p>
        </div>
        <button onClick={syncSheet} disabled={syncing} title="Pull current prices from the master sheet into the dated history"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 7, border: '1px solid var(--accent)', background: 'var(--surface)', color: 'var(--accent)', fontSize: 13, fontWeight: 700, cursor: syncing ? 'not-allowed' : 'pointer', opacity: syncing ? 0.6 : 1, whiteSpace: 'nowrap' as const }}>
          <RefreshCw size={14} /> {syncing ? 'Syncing…' : 'Sync prices from sheet'}
        </button>
      </div>

      {msg && <div style={{ borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: `1px solid ${msg.ok ? '#bbf7d0' : '#fecaca'}`, background: msg.ok ? 'var(--dispatched-bg)' : 'var(--critical-bg)', color: msg.ok ? 'var(--dispatched)' : 'var(--critical)' }}>{msg.text}</div>}

      {/* Dated price from a sheet column */}
      <div style={{ ...card, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}><CalendarClock size={15} style={{ color: 'var(--accent)' }} /><span style={{ fontSize: 13, fontWeight: 700 }}>Dated price from a sheet column</span></div>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: '0 0 12px' }}>Pick a master-sheet price column and the dates it was in effect. On apply, that column&rsquo;s price is written per SKU for the window, overwriting any overlapping dated prices — so recon reads the right price for each order&rsquo;s date and a later sheet edit won&rsquo;t rebase past orders.</p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={lbl}>Sheet column</span>
            <select value={era.col} onChange={e => { setEra(s => ({ ...s, col: e.target.value })); setPreview(null) }} style={{ ...input, width: 220, cursor: 'pointer' }}>
              <option value="">Select column…</option>
              {columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={lbl}>Effective from</span><DrumDatePicker value={era.from} onChange={v => { setEra(s => ({ ...s, from: v })); setPreview(null) }} placeholder="From" /></div>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={lbl}>Effective to <span style={{ color: 'var(--text3)' }}>(blank = current)</span></span>
            {eraHasEnd ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <DrumDatePicker value={era.to} min={era.from || undefined} onChange={v => { setEra(s => ({ ...s, to: v })); setPreview(null) }} placeholder="To" />
                <button type="button" onClick={() => { setEraHasEnd(false); setEra(s => ({ ...s, to: '' })); setPreview(null) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', display: 'inline-flex' }} title="Clear end date (make current)"><X size={15} /></button>
              </div>
            ) : (
              <button type="button" onClick={() => setEraHasEnd(true)} style={{ ...input, cursor: 'pointer', color: 'var(--text3)', textAlign: 'left' as const, background: 'var(--bg)' }}>+ set end date</button>
            )}
          </div>
          <button onClick={() => runApply(true)} disabled={busy !== null} style={{ padding: '8px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer' }}>{busy === 'preview' ? 'Checking…' : 'Preview'}</button>
          <button onClick={() => runApply(false)} disabled={busy !== null || !preview} title={!preview ? 'Preview first' : 'Apply'} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: (busy || !preview) ? 'var(--bg2)' : 'var(--accent)', color: (busy || !preview) ? 'var(--text3)' : '#fff', fontSize: 13, fontWeight: 700, cursor: (busy || !preview) ? 'not-allowed' : 'pointer' }}>{busy === 'apply' ? 'Applying…' : 'Apply'}</button>
        </div>
        {preview && (
          <div style={{ marginTop: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', padding: '11px 13px', fontSize: 12.5, color: 'var(--text2)' }}>
            <b style={{ color: 'var(--text)' }}>{preview.eraInserts}</b> SKU prices will be set from <b style={{ color: 'var(--accent)' }}>{era.col}</b> for {fmtDate(era.from)} → {era.to ? fmtDate(era.to) : 'current'}. Of existing rows: {preview.trims} trimmed, {preview.splits} split, {preview.deletes} replaced.
            {preview.sample.length > 0 && <div style={{ marginTop: 6, fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>e.g. {preview.sample.slice(0, 5).map(s => `${s.sku} ${money(s.price)}`).join(' · ')}</div>}
            <div style={{ marginTop: 8, fontWeight: 700, color: 'var(--text)' }}>Looks right? Hit Apply.</div>
          </div>
        )}
      </div>

      {/* Applied price-era timeline */}
      {eras.length > 0 && (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 700 }}>Price-era timeline <span style={{ fontWeight: 500, color: 'var(--text3)', fontSize: 12 }}>· applied from sheet columns</span></div>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
            <thead><tr><th style={th}>Column</th><th style={th}>Effective from</th><th style={th}>Effective to</th><th style={{ ...th, textAlign: 'right' as const }}>SKUs</th><th style={{ ...th, width: 40 }}></th></tr></thead>
            <tbody>
              {eras.map((e, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 10px' }}><span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', padding: '2px 8px', borderRadius: 5, fontFamily: 'DM Mono' }}>{e.column}</span></td>
                  <td style={{ padding: '8px 10px', color: 'var(--text2)' }}>{fmtDate(e.from)}</td>
                  <td style={{ padding: '8px 10px' }}>{e.to ? <span style={{ color: 'var(--text2)' }}>{fmtDate(e.to)}</span> : <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '2px 7px', borderRadius: 4 }}>CURRENT</span>}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' as const, fontFamily: 'DM Mono' }}>{e.count}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' as const }}><button onClick={() => removeEra(e)} title="Remove this era" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'inline-flex' }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add price */}
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Add a price</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={lbl}>SKU</span><input value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))} placeholder="e.g. HT-QB-…" style={{ ...input, width: 200, fontFamily: 'DM Mono' }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={lbl}>Price (₹)</span><input value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} inputMode="decimal" style={{ ...input, width: 120, fontFamily: 'DM Mono' }} /></label>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={lbl}>Effective from</span><DrumDatePicker value={form.from} onChange={v => setForm(f => ({ ...f, from: v }))} placeholder="From" /></div>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={lbl}>Effective to <span style={{ color: 'var(--text3)' }}>(blank = current)</span></span>
            {hasEnd ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <DrumDatePicker value={form.to} min={form.from || undefined} onChange={v => setForm(f => ({ ...f, to: v }))} placeholder="To" />
                <button type="button" onClick={() => { setHasEnd(false); setForm(f => ({ ...f, to: '' })) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 12, display: 'inline-flex' }} title="Clear end date (make current)"><X size={15} /></button>
              </div>
            ) : (
              <button type="button" onClick={() => setHasEnd(true)} style={{ ...input, cursor: 'pointer', color: 'var(--text3)', textAlign: 'left' as const, background: 'var(--bg)' }}>+ set end date</button>
            )}
          </div>
          <button onClick={addPrice} disabled={saving} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: saving ? 'var(--bg2)' : 'var(--accent)', color: saving ? 'var(--text3)' : '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add</button>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12, color: 'var(--text2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={closePrev} onChange={e => setClosePrev(e.target.checked)} /> Close the previous current price for this SKU (set its &ldquo;effective to&rdquo; to the day before)
        </label>
      </div>

      {/* Existing prices */}
      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Prices</span>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{filtered.length} of {rows.length}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 10px' }}>
            <Search size={13} style={{ color: 'var(--text3)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU…" style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 12, outline: 'none', fontFamily: 'DM Mono' }} />
            {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0, display: 'inline-flex' }}><X size={13} /></button>}
          </div>
        </div>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
        ) : !filtered.length ? (
          <div style={{ padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>{rows.length ? 'No SKUs match your search.' : 'No prices yet — add one above.'}</div>
        ) : (
          <div style={{ overflowX: 'auto' as const, maxHeight: 520 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 640 }}>
              <thead style={{ position: 'sticky' as const, top: 0, zIndex: 1 }}><tr>
                <th style={th}>SKU</th><th style={{ ...th, textAlign: 'right' as const }}>Price</th><th style={th}>Effective from</th><th style={th}>Effective to</th><th style={th}>Source</th><th style={{ ...th, width: 40 }}></th>
              </tr></thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '7px 10px', fontFamily: 'DM Mono', fontSize: 11 }}>{r.sku}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right' as const, fontFamily: 'DM Mono' }}>{money(r.price)}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text2)' }}>{fmtDate(r.effective_from)}</td>
                    <td style={{ padding: '7px 10px' }}>{r.effective_to ? <span style={{ color: 'var(--text2)' }}>{fmtDate(r.effective_to)}</span> : <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '2px 7px', borderRadius: 4 }}>CURRENT</span>}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text3)', fontSize: 11 }}>{r.source ? (r.source.startsWith('sheet:') ? r.source.slice(6) : r.source) : '—'}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'center' as const }}><button onClick={() => remove(r.id)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'inline-flex' }}><Trash2 size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
