'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Plus, Trash2, Search, X } from 'lucide-react'

interface PriceRow { id: string; sku: string; price: number; effective_from: string; effective_to: string | null }

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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await supabase.from('recon_prices').select('*').order('sku').order('effective_from', { ascending: false })
      setRows((data || []).map((r: Record<string, unknown>) => ({
        id: String(r.id), sku: String(r.sku ?? ''), price: Number(r.price ?? 0),
        effective_from: String(r.effective_from ?? ''), effective_to: r.effective_to ? String(r.effective_to) : null,
      })))
    } catch (e) { setMsg({ ok: false, text: 'Load failed: ' + (e as Error).message }) }
    setLoading(false)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? rows.filter(r => r.sku.toLowerCase().includes(q)) : rows
  }, [rows, search])

  const addPrice = async () => {
    const sku = form.sku.trim(); const price = parseFloat(form.price)
    if (!sku) { setMsg({ ok: false, text: 'Enter a SKU.' }); return }
    if (isNaN(price)) { setMsg({ ok: false, text: 'Enter a valid price.' }); return }
    if (!form.from) { setMsg({ ok: false, text: 'Set an effective-from date.' }); return }
    if (form.to && form.to < form.from) { setMsg({ ok: false, text: 'Effective-to is before effective-from.' }); return }
    setSaving(true); setMsg(null)
    try {
      // Close the previous open ("current") price for this SKU so ranges don't overlap.
      if (closePrev) {
        const { error: uErr } = await supabase.from('recon_prices').update({ effective_to: prevDay(form.from) })
          .eq('sku', sku).is('effective_to', null).lt('effective_from', form.from)
        if (uErr) throw uErr
      }
      const { error } = await supabase.from('recon_prices').insert({ sku, price, effective_from: form.from, effective_to: form.to || null })
      if (error) throw error
      setMsg({ ok: true, text: `Added ${money(price)} for ${sku}.` })
      setForm({ sku: '', price: '', from: '', to: '' })
      void load()
    } catch (e) { setMsg({ ok: false, text: 'Add failed: ' + (e as Error).message }) }
    setSaving(false)
  }

  const remove = async (id: string) => {
    setMsg(null)
    const { error } = await supabase.from('recon_prices').delete().eq('id', id)
    if (error) { setMsg({ ok: false, text: 'Delete failed: ' + error.message }); return }
    setRows(prev => prev.filter(r => r.id !== id))
  }

  const th = { padding: '8px 10px', textAlign: 'left' as const, fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text3)', whiteSpace: 'nowrap' as const, background: 'var(--bg2)' }

  return (
    <div style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column' as const, gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 4px' }}>Price master</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>The base selling price per SKU, with dated history. The expected price for an order uses whichever price was in effect on its order date. Leave &ldquo;effective to&rdquo; blank for the current price.</p>
      </div>

      {msg && <div style={{ borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: `1px solid ${msg.ok ? '#bbf7d0' : '#fecaca'}`, background: msg.ok ? 'var(--dispatched-bg)' : 'var(--critical-bg)', color: msg.ok ? 'var(--dispatched)' : 'var(--critical)' }}>{msg.text}</div>}

      {/* Add price */}
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Add a price</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>SKU</span><input value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))} placeholder="e.g. HT-QB-…" style={{ ...input, width: 200, fontFamily: 'DM Mono' }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Price (₹)</span><input value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} inputMode="decimal" style={{ ...input, width: 120, fontFamily: 'DM Mono' }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Effective from</span><input type="date" value={form.from} onChange={e => setForm(f => ({ ...f, from: e.target.value }))} style={{ ...input }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Effective to <span style={{ color: 'var(--text3)' }}>(blank = current)</span></span><input type="date" value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))} style={{ ...input }} /></label>
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
                <th style={th}>SKU</th><th style={{ ...th, textAlign: 'right' as const }}>Price</th><th style={th}>Effective from</th><th style={th}>Effective to</th><th style={{ ...th, width: 40 }}></th>
              </tr></thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '7px 10px', fontFamily: 'DM Mono', fontSize: 11 }}>{r.sku}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right' as const, fontFamily: 'DM Mono' }}>{money(r.price)}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text2)' }}>{fmtDate(r.effective_from)}</td>
                    <td style={{ padding: '7px 10px' }}>{r.effective_to ? <span style={{ color: 'var(--text2)' }}>{fmtDate(r.effective_to)}</span> : <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', padding: '2px 7px', borderRadius: 4 }}>CURRENT</span>}</td>
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
