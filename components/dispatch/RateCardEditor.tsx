'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Plus, Trash2, Save } from 'lucide-react'

// Rate Card v2 — per-platform category commission + closing/fixed fee (flat ₹ and/or %).
// Feeds the recon "expected" columns. Expected commission % = rate × 1.18 (Amazon,
// GST-inclusive) or rate as-is (Flipkart); expected closing = flat ₹ + % of price.
interface CatRow {
  platform: string; category: string; rate_below: string; rate_above: string
  threshold: string; closing_fee: string; closing_fee_pct: string
}
const PLATFORMS = ['Amazon', 'Flipkart'] as const
type Plat = typeof PLATFORMS[number]
const CATS = ['Bed', 'Chair', 'Desk', 'Table', 'Rack', 'Mattress', 'Uncategorized']

function defaultsFor(platform: string): CatRow[] {
  const base = platform === 'Amazon'
    ? { rate_below: '15.5', rate_above: '11', threshold: '15000', closing_fee: '100', closing_fee_pct: '0' }
    : { rate_below: '13.5', rate_above: '9.5', threshold: '15000', closing_fee: '88', closing_fee_pct: '0' }
  return CATS.map(c => ({ platform, category: c, ...(c === 'Mattress' ? { ...base, rate_below: '9.5', rate_above: '9.5' } : base) }))
}

const DEFAULT_GLOBALS = { tcs: '0.4237', tds: '0.0849', gst: '18', accuracy: '2' }
const CONFIG_KEYS = {
  tcs: 'recon_tcs_rate', tds: 'recon_tds_rate', gst: 'recon_gst_on_fees_rate', accuracy: 'recon_accuracy_threshold',
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
const num = (v: string, dflt = 0) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? dflt : n }

export default function RateCardEditor() {
  const supabase = createClient()
  const [cats, setCats] = useState<CatRow[]>([...defaultsFor('Amazon'), ...defaultsFor('Flipkart')])
  const [plat, setPlat] = useState<Plat>('Amazon')
  const [g, setG] = useState({ ...DEFAULT_GLOBALS })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: catData } = await supabase.from('recon_rate_card_categories').select('*')
      let rows: CatRow[] = (catData || []).map((c: Record<string, unknown>) => ({
        platform: String(c.platform ?? 'Amazon'), category: String(c.category ?? ''),
        rate_below: String(c.rate_below ?? ''), rate_above: String(c.rate_above ?? ''),
        threshold: String(c.threshold ?? ''), closing_fee: String(c.closing_fee ?? ''),
        closing_fee_pct: String(c.closing_fee_pct ?? '0'),
      }))
      for (const p of PLATFORMS) if (!rows.some(r => r.platform === p)) rows = rows.concat(defaultsFor(p))
      setCats(rows)
      const { data: cfg } = await supabase.from('app_config').select('key, value').in('key', Object.values(CONFIG_KEYS))
      if (cfg && cfg.length) {
        const byKey: Record<string, string> = {}
        for (const r of cfg) byKey[r.key as string] = String((r as { value: unknown }).value ?? '')
        setG(prev => ({
          tcs: byKey[CONFIG_KEYS.tcs] ?? prev.tcs, tds: byKey[CONFIG_KEYS.tds] ?? prev.tds,
          gst: byKey[CONFIG_KEYS.gst] ?? prev.gst, accuracy: byKey[CONFIG_KEYS.accuracy] ?? prev.accuracy,
        }))
      }
    } catch { /* keep defaults */ }
    setLoading(false)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  const loadDefaults = () => { setCats([...defaultsFor('Amazon'), ...defaultsFor('Flipkart')]); setG({ ...DEFAULT_GLOBALS }) }
  const setCat = (i: number, field: keyof CatRow, val: string) => setCats(prev => prev.map((c, j) => j === i ? { ...c, [field]: val } : c))
  const addRow = () => setCats(prev => [...prev, { platform: plat, category: '', rate_below: '', rate_above: '', threshold: '15000', closing_fee: '0', closing_fee_pct: '0' }])
  const removeRow = (i: number) => setCats(prev => prev.filter((_, j) => j !== i))

  const save = async () => {
    setSaving(true); setMsg(null)
    try {
      const clean = cats.filter(c => c.category.trim())
      const { error: delErr } = await supabase.from('recon_rate_card_categories').delete().gte('closing_fee', -1)
      if (delErr) throw delErr
      const { error: insErr } = await supabase.from('recon_rate_card_categories').insert(
        clean.map(c => ({
          platform: (c.platform || 'Amazon').trim(), category: c.category.trim(),
          rate_below: num(c.rate_below), rate_above: num(c.rate_above),
          threshold: num(c.threshold, 15000), closing_fee: num(c.closing_fee, 0), closing_fee_pct: num(c.closing_fee_pct, 0),
          updated_at: new Date().toISOString(),
        })))
      if (insErr) throw insErr
      const now = new Date().toISOString()
      const cfgRows = [
        { key: CONFIG_KEYS.tcs, value: g.tcs }, { key: CONFIG_KEYS.tds, value: g.tds },
        { key: CONFIG_KEYS.gst, value: g.gst }, { key: CONFIG_KEYS.accuracy, value: g.accuracy },
      ].map(r => ({ ...r, updated_at: now, updated_by: 'recon-ratecard' }))
      const { error: cfgErr } = await supabase.from('app_config').upsert(cfgRows, { onConflict: 'key' })
      if (cfgErr) throw cfgErr
      setMsg({ ok: true, text: `Saved ${clean.length} rows + rate config.` })
      void load()
    } catch (e) { setMsg({ ok: false, text: 'Save failed: ' + (e as Error).message }) }
    setSaving(false)
  }

  const th = { padding: '8px 10px', textAlign: 'left' as const, fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text3)', whiteSpace: 'nowrap' as const, background: 'var(--bg2)' }

  return (
    <div style={{ maxWidth: 1040, display: 'flex', flexDirection: 'column' as const, gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 4px' }}>Rate Card</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>
          Per-platform commission &amp; fees used to compute each order&apos;s <strong>expected</strong> settlement. Amazon expected commission % = rate × 1.18 (GST-inclusive); Flipkart = rate as-is. Closing/fixed fee can be a flat ₹ and/or a % of price.
        </p>
      </div>

      {msg && (
        <div style={{ borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: `1px solid ${msg.ok ? '#bbf7d0' : '#fecaca'}`, background: msg.ok ? 'var(--dispatched-bg)' : 'var(--critical-bg)', color: msg.ok ? 'var(--dispatched)' : 'var(--critical)' }}>{msg.text}</div>
      )}

      {loading ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : (<>
        <div style={{ ...card, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Taxes &amp; tolerance</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' as const }}>
            {numField('TCS rate (%)', 'on the sale price', g.tcs, v => setG(p => ({ ...p, tcs: v })))}
            {numField('TDS rate (%)', 'on the sale price', g.tds, v => setG(p => ({ ...p, tds: v })))}
            {numField('GST on fees (%)', 'on commission + closing', g.gst, v => setG(p => ({ ...p, gst: v })))}
            {numField('Accuracy tolerance (%)', 'within this = "correct"', g.accuracy, v => setG(p => ({ ...p, accuracy: v })))}
          </div>
        </div>

        {/* Platform toggle */}
        <div style={{ display: 'inline-flex', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 2, gap: 1, alignSelf: 'flex-start' }}>
          {PLATFORMS.map(p => (
            <button key={p} onClick={() => setPlat(p)} style={{ border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, padding: '7px 16px', borderRadius: 6, background: plat === p ? 'var(--accent)' : 'transparent', color: plat === p ? '#fff' : 'var(--text2)' }}>{p}</button>
          ))}
        </div>

        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Category commission &amp; closing · {plat}</span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>rate_below applies at/under the threshold price, rate_above over it</span>
          </div>
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 760 }}>
              <thead><tr>
                <th style={th}>Category</th><th style={th}>Rate below (%)</th><th style={th}>Rate above (%)</th>
                <th style={th}>Threshold (₹)</th><th style={th}>Closing ₹ (flat)</th><th style={th}>Closing % </th><th style={{ ...th, width: 40 }}></th>
              </tr></thead>
              <tbody>
                {cats.map((c, i) => c.platform !== plat ? null : (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 10px' }}><input value={c.category} onChange={e => setCat(i, 'category', e.target.value)} placeholder="Category" style={{ ...inputStyle, fontFamily: 'DM Sans', minWidth: 110 }} /></td>
                    <td style={{ padding: '6px 10px' }}><input value={c.rate_below} onChange={e => setCat(i, 'rate_below', e.target.value)} inputMode="decimal" style={{ ...inputStyle, minWidth: 80 }} /></td>
                    <td style={{ padding: '6px 10px' }}><input value={c.rate_above} onChange={e => setCat(i, 'rate_above', e.target.value)} inputMode="decimal" style={{ ...inputStyle, minWidth: 80 }} /></td>
                    <td style={{ padding: '6px 10px' }}><input value={c.threshold} onChange={e => setCat(i, 'threshold', e.target.value)} inputMode="decimal" style={{ ...inputStyle, minWidth: 80 }} /></td>
                    <td style={{ padding: '6px 10px' }}><input value={c.closing_fee} onChange={e => setCat(i, 'closing_fee', e.target.value)} inputMode="decimal" style={{ ...inputStyle, minWidth: 80 }} /></td>
                    <td style={{ padding: '6px 10px' }}><input value={c.closing_fee_pct} onChange={e => setCat(i, 'closing_fee_pct', e.target.value)} inputMode="decimal" style={{ ...inputStyle, minWidth: 70 }} /></td>
                    <td style={{ padding: '6px 10px', textAlign: 'center' as const }}>
                      <button onClick={() => removeRow(i)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'inline-flex' }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
            <button onClick={addRow} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> Add category to {plat}</button>
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
