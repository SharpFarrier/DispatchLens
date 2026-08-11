'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Plus, Trash2, Save } from 'lucide-react'

// Category commission rows (edited as strings, parsed on save).
interface CatRow { category: string; rate_below: string; rate_above: string; threshold: string; closing_fee: string }

const DEFAULT_CATEGORIES: CatRow[] = [
  { category: 'Bed', rate_below: '15.5', rate_above: '11', threshold: '15000', closing_fee: '100' },
  { category: 'Chair', rate_below: '15.5', rate_above: '11', threshold: '15000', closing_fee: '100' },
  { category: 'Desk', rate_below: '15.5', rate_above: '11', threshold: '15000', closing_fee: '100' },
  { category: 'Rack', rate_below: '15.5', rate_above: '11', threshold: '15000', closing_fee: '100' },
  { category: 'Mattress', rate_below: '9.5', rate_above: '9.5', threshold: '15000', closing_fee: '100' },
  { category: 'Uncategorized', rate_below: '15.5', rate_above: '11', threshold: '15000', closing_fee: '100' },
]
const DEFAULT_GLOBALS = { tcs: '0.4237', tds: '0.0849', accuracy: '10', fkCommission: '18', fkFixed: '10', fkCollection: '0' }

const CONFIG_KEYS = {
  tcs: 'recon_tcs_rate', tds: 'recon_tds_rate', accuracy: 'recon_accuracy_threshold',
  fkCommission: 'recon_fk_commission_rate', fkFixed: 'recon_fk_fixed_fee', fkCollection: 'recon_fk_collection_fee_pct',
} as const

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }
const inputStyle = { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, fontFamily: 'DM Mono', outline: 'none', width: '100%', boxSizing: 'border-box' as const }
const numField = (label: string, hint: string, value: string, onChange: (v: string) => void) => (
  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, minWidth: 120 }}>
    <label style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>{label}</label>
    <input value={value} onChange={e => onChange(e.target.value)} inputMode="decimal" style={inputStyle} />
    <span style={{ fontSize: 10, color: 'var(--text3)' }}>{hint}</span>
  </div>
)

export default function RateCardEditor() {
  const supabase = createClient()
  const [cats, setCats] = useState<CatRow[]>(DEFAULT_CATEGORIES)
  const [g, setG] = useState({ ...DEFAULT_GLOBALS })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: catData } = await supabase.from('recon_rate_card_categories').select('*').order('category')
      if (catData && catData.length) {
        setCats(catData.map((c: Record<string, unknown>) => ({
          category: String(c.category ?? ''),
          rate_below: String(c.rate_below ?? ''),
          rate_above: String(c.rate_above ?? ''),
          threshold: String(c.threshold ?? ''),
          closing_fee: String(c.closing_fee ?? ''),
        })))
      }
      const keys = Object.values(CONFIG_KEYS)
      const { data: cfg } = await supabase.from('app_config').select('key, value').in('key', keys)
      if (cfg && cfg.length) {
        const byKey: Record<string, string> = {}
        for (const r of cfg) byKey[r.key as string] = String((r as { value: unknown }).value ?? '')
        setG(prev => ({
          tcs: byKey[CONFIG_KEYS.tcs] ?? prev.tcs,
          tds: byKey[CONFIG_KEYS.tds] ?? prev.tds,
          accuracy: byKey[CONFIG_KEYS.accuracy] ?? prev.accuracy,
          fkCommission: byKey[CONFIG_KEYS.fkCommission] ?? prev.fkCommission,
          fkFixed: byKey[CONFIG_KEYS.fkFixed] ?? prev.fkFixed,
          fkCollection: byKey[CONFIG_KEYS.fkCollection] ?? prev.fkCollection,
        }))
      }
    } catch (e) { setMsg({ ok: false, text: 'Load failed: ' + (e as Error).message }) }
    setLoading(false)
  }, [supabase])

  useEffect(() => { void load() }, [load])

  const setCat = (i: number, field: keyof CatRow, v: string) =>
    setCats(prev => prev.map((c, idx) => idx === i ? { ...c, [field]: v } : c))
  const addRow = () => setCats(prev => [...prev, { category: '', rate_below: '15.5', rate_above: '11', threshold: '15000', closing_fee: '100' }])
  const removeRow = (i: number) => setCats(prev => prev.filter((_, idx) => idx !== i))
  const loadDefaults = () => { setCats(DEFAULT_CATEGORIES.map(c => ({ ...c }))); setG({ ...DEFAULT_GLOBALS }) }

  const save = async () => {
    const clean = cats.filter(c => c.category.trim())
    const names = clean.map(c => c.category.trim().toLowerCase())
    if (new Set(names).size !== names.length) { setMsg({ ok: false, text: 'Duplicate category names — each must be unique.' }); return }
    if (!clean.length) { setMsg({ ok: false, text: 'Add at least one category.' }); return }
    setSaving(true); setMsg(null)
    try {
      const num = (v: string, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n }
      // Replace the whole category set (handles removed rows).
      const { error: delErr } = await supabase.from('recon_rate_card_categories').delete().gte('closing_fee', -1)
      if (delErr) throw delErr
      const { error: insErr } = await supabase.from('recon_rate_card_categories').insert(
        clean.map(c => ({
          category: c.category.trim(),
          rate_below: num(c.rate_below), rate_above: num(c.rate_above),
          threshold: num(c.threshold, 15000), closing_fee: num(c.closing_fee, 100),
          updated_at: new Date().toISOString(),
        })))
      if (insErr) throw insErr
      // Global config → app_config
      const now = new Date().toISOString()
      const cfgRows = [
        { key: CONFIG_KEYS.tcs, value: g.tcs }, { key: CONFIG_KEYS.tds, value: g.tds },
        { key: CONFIG_KEYS.accuracy, value: g.accuracy }, { key: CONFIG_KEYS.fkCommission, value: g.fkCommission },
        { key: CONFIG_KEYS.fkFixed, value: g.fkFixed }, { key: CONFIG_KEYS.fkCollection, value: g.fkCollection },
      ].map(r => ({ ...r, updated_at: now, updated_by: 'recon-ratecard' }))
      const { error: cfgErr } = await supabase.from('app_config').upsert(cfgRows, { onConflict: 'key' })
      if (cfgErr) throw cfgErr
      setMsg({ ok: true, text: `Saved ${clean.length} categories + rate config.` })
      void load()
    } catch (e) { setMsg({ ok: false, text: 'Save failed: ' + (e as Error).message }) }
    setSaving(false)
  }

  const th = { padding: '8px 10px', textAlign: 'left' as const, fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text3)', whiteSpace: 'nowrap' as const, background: 'var(--bg2)' }

  return (
    <div style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column' as const, gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 4px' }}>Rate Card</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>
          Commission and fees used to compute each order&apos;s <strong>expected</strong> settlement. Expected net = price − commission − closing fee − TCS − TDS.
        </p>
      </div>

      {msg && (
        <div style={{ borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: `1px solid ${msg.ok ? '#bbf7d0' : '#fecaca'}`, background: msg.ok ? 'var(--dispatched-bg)' : 'var(--critical-bg)', color: msg.ok ? 'var(--dispatched)' : 'var(--critical)' }}>{msg.text}</div>
      )}

      {loading ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : (<>
        {/* Global taxes + tolerance */}
        <div style={{ ...card, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Taxes &amp; tolerance</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' as const }}>
            {numField('TCS rate (%)', 'Tax collected at source', g.tcs, v => setG(p => ({ ...p, tcs: v })))}
            {numField('TDS rate (%)', 'Tax deducted at source', g.tds, v => setG(p => ({ ...p, tds: v })))}
            {numField('Accuracy tolerance (%)', 'Within this = "correct"', g.accuracy, v => setG(p => ({ ...p, accuracy: v })))}
          </div>
        </div>

        {/* Flipkart flat fees */}
        <div style={{ ...card, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Flipkart fees</div>
          <p style={{ fontSize: 11, color: 'var(--text3)', margin: '0 0 12px' }}>Flipkart uses a flat commission + fixed fee instead of the category rate card.</p>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' as const }}>
            {numField('Commission (%)', 'Flat commission rate', g.fkCommission, v => setG(p => ({ ...p, fkCommission: v })))}
            {numField('Fixed fee (₹)', 'Per-order fixed fee', g.fkFixed, v => setG(p => ({ ...p, fkFixed: v })))}
            {numField('Collection fee (%)', 'Optional COD collection', g.fkCollection, v => setG(p => ({ ...p, fkCollection: v })))}
          </div>
        </div>

        {/* Category rate card (Amazon) */}
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Category commission (Amazon)</span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>rate_below applies at/under the threshold price, rate_above over it</span>
          </div>
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 640 }}>
              <thead><tr>
                <th style={th}>Category</th><th style={th}>Rate below (%)</th><th style={th}>Rate above (%)</th>
                <th style={th}>Threshold (₹)</th><th style={th}>Closing fee (₹)</th><th style={{ ...th, width: 40 }}></th>
              </tr></thead>
              <tbody>
                {cats.map((c, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px' }}><input value={c.category} onChange={e => setCat(i, 'category', e.target.value)} placeholder="Category" style={{ ...inputStyle, fontFamily: 'DM Sans', minWidth: 120 }} /></td>
                    <td style={{ padding: '6px 10px' }}><input value={c.rate_below} onChange={e => setCat(i, 'rate_below', e.target.value)} inputMode="decimal" style={{ ...inputStyle, minWidth: 90 }} /></td>
                    <td style={{ padding: '6px 10px' }}><input value={c.rate_above} onChange={e => setCat(i, 'rate_above', e.target.value)} inputMode="decimal" style={{ ...inputStyle, minWidth: 90 }} /></td>
                    <td style={{ padding: '6px 10px' }}><input value={c.threshold} onChange={e => setCat(i, 'threshold', e.target.value)} inputMode="decimal" style={{ ...inputStyle, minWidth: 90 }} /></td>
                    <td style={{ padding: '6px 10px' }}><input value={c.closing_fee} onChange={e => setCat(i, 'closing_fee', e.target.value)} inputMode="decimal" style={{ ...inputStyle, minWidth: 90 }} /></td>
                    <td style={{ padding: '6px 10px', textAlign: 'center' as const }}>
                      <button onClick={() => removeRow(i)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'inline-flex' }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
            <button onClick={addRow} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Add category</button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={save} disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: saving ? 'var(--bg2)' : 'var(--accent)', color: saving ? 'var(--text3)' : '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}><Save size={15} /> {saving ? 'Saving…' : 'Save rate card'}</button>
          <button onClick={loadDefaults} style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Reset to defaults</button>
        </div>
      </>)}
    </div>
  )
}
