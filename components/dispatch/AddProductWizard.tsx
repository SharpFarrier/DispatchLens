'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useProductStore } from './useProductStore'
import { PM_SIZES, COLOURS, COLOUR_HEX, MATTRESS_OPTIONS, packedSize } from '@/lib/catalogueMap'
import { X, Check, Plus, Loader2, ChevronRight, ChevronLeft } from 'lucide-react'

// One entry point that fans out to products / product_variants / packed_skus /
// dispatch_sku_map (and category + shape for a new family) via the
// create_product_full RPC. Variants = size × mattress; finished SKUs = size × mattress × colour.

type FamilyMode = 'existing' | 'new'

interface FinishedRow {
  key: string
  size: string | null
  mattress: string | null
  colour: string | null
  master_sku: string
  amazon_sku: string
  amazon_asin: string
  flipkart_sku: string
  website_sku: string
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }
const lbl = { fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' as const, color: 'var(--text3)', margin: '0 0 8px' }
const inp = { width: '100%', padding: '9px 11px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font-mono)', boxSizing: 'border-box' as const }
const chip = (on: boolean) => ({ padding: '7px 13px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: on ? '1.5px solid var(--accent)' : '1px solid var(--border)', background: on ? 'var(--accent-bg)' : 'var(--surface)', color: on ? 'var(--accent)' : 'var(--text2)' })

export default function AddProductWizard({ onClose, onSaved }: { onClose?: () => void; onSaved?: (summary: Record<string, unknown>) => void }) {
  const supabase = useMemo(() => createClient(), [])
  const { categories, shapes, reload } = useProductStore()

  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ text: string; type: 'error' | 'success' } | null>(null)

  // Step 1 — family
  const [familyMode, setFamilyMode] = useState<FamilyMode>('existing')
  const [familyLabels, setFamilyLabels] = useState<string[]>([])
  const [familyLabel, setFamilyLabel] = useState('')        // packed_skus.product (e.g. "Atlas")
  const [categoryName, setCategoryName] = useState('')
  const [shapeName, setShapeName] = useState('')
  const [shapeImage, setShapeImage] = useState('')

  // Step 2 — product
  const [productName, setProductName] = useState('')
  const [hasSize, setHasSize] = useState(true)
  const [hasMattress, setHasMattress] = useState(true)
  const [hasColour, setHasColour] = useState(true)

  // Step 3 — variant dimensions
  const [sizes, setSizes] = useState<string[]>([])
  const [mattresses, setMattresses] = useState<string[]>(['Without Mattress'])
  const [colours, setColours] = useState<string[]>([])

  // Step 4 — finished SKU rows (generated from the dimensions, editable)
  const [rows, setRows] = useState<FinishedRow[]>([])

  const loadFamilies = useCallback(async () => {
    const { data } = await supabase.from('packed_skus').select('product').order('product')
    const set = new Set<string>()
    ;(data as { product: string | null }[] | null)?.forEach(r => { if (r.product) set.add(r.product) })
    setFamilyLabels([...set])
  }, [supabase])

  useEffect(() => { void loadFamilies() }, [loadFamilies])

  const flash = (text: string, type: 'error' | 'success' = 'success') => { setMsg({ text, type }); if (type === 'success') setTimeout(() => setMsg(null), 4000) }

  function toggle(list: string[], set: (v: string[]) => void, v: string) {
    set(list.includes(v) ? list.filter(x => x !== v) : [...list, v])
  }

  // Build the editable finished-SKU grid from the chosen dimensions.
  function buildRows() {
    const szList = hasSize ? (sizes.length ? sizes : [null]) : [null]
    const mtList = hasMattress ? (mattresses.length ? mattresses : [null]) : [null]
    const clList = hasColour ? (colours.length ? colours : [null]) : [null]
    const next: FinishedRow[] = []
    for (const s of szList) for (const m of mtList) for (const c of clList) {
      const key = [s || '', m || '', c || ''].join('|')
      const prev = rows.find(r => r.key === key)
      next.push(prev || { key, size: s, mattress: m, colour: c, master_sku: '', amazon_sku: '', amazon_asin: '', flipkart_sku: '', website_sku: '' })
    }
    setRows(next)
  }

  function setRow(key: string, patch: Partial<FinishedRow>) {
    setRows(prev => prev.map(r => r.key === key ? { ...r, ...patch } : r))
  }

  const variantCount = useMemo(() => {
    const szList = hasSize ? (sizes.length ? sizes : [null]) : [null]
    const mtList = hasMattress ? (mattresses.length ? mattresses : [null]) : [null]
    return szList.length * mtList.length
  }, [hasSize, hasMattress, sizes, mattresses])

  function validateBeforeSave(): string | null {
    if (!productName.trim()) return 'Product name is required'
    if (!familyLabel.trim()) return 'Family label is required (it becomes the barcode generator’s product)'
    if (familyMode === 'new') {
      if (!categoryName.trim()) return 'New family needs a category'
      if (!shapeName.trim()) return 'New family needs a shape name'
    }
    if (!rows.length) return 'No finished SKUs — set the dimensions and build the list in step 4'
    const missing = rows.filter(r => !r.master_sku.trim())
    if (missing.length) return `${missing.length} finished SKU(s) have no master SKU`
    const seen = new Set<string>()
    for (const r of rows) {
      const k = r.master_sku.trim()
      if (seen.has(k)) return `Duplicate master SKU in the list: ${k}`
      seen.add(k)
    }
    return null
  }

  function slugify(s: string) { return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }

  async function handleSave() {
    const err = validateBeforeSave()
    if (err) { flash(err, 'error'); return }
    setSaving(true)
    try {
      const existingShape = shapes.find(s => s.name.toLowerCase() === shapeName.trim().toLowerCase())
      const slug = existingShape ? existingShape.slug : slugify(shapeName || familyLabel)

      const variants = (() => {
        const szList = hasSize ? (sizes.length ? sizes : [null]) : [null]
        const mtList = hasMattress ? (mattresses.length ? mattresses : [null]) : [null]
        const out: Array<Record<string, unknown>> = []
        for (const s of szList) for (const m of mtList) {
          out.push({ size: s, mattress: m, has_colour: hasColour, is_assembly: false })
        }
        return out
      })()

      const finished = rows.map(r => ({
        master_sku: r.master_sku.trim(),
        product_name: familyLabel.trim(),
        amazon_sku: r.amazon_sku.trim() || null,
        amazon_asin: r.amazon_asin.trim() || null,
        flipkart_sku: r.flipkart_sku.trim() || null,
        website_sku: r.website_sku.trim() || null,
        other_sku: null,
        other_sku_2: null,
        packed: {
          product: familyLabel.trim(),
          size: packedSize(r.size),
          fcolor: r.colour,
          wood: null,
          mattress: r.mattress,
          clothcolor: null,
          descr: [familyLabel.trim(), r.colour, packedSize(r.size)].filter(Boolean).join(' '),
        },
      }))

      const payload = {
        family: {
          category: categoryName.trim() || null,
          shape_name: shapeName.trim() || null,
          shape_slug: shapeName.trim() ? slug : null,
          shape_image_url: shapeImage.trim() || null,
        },
        product: {
          name: productName.trim(),
          has_size: hasSize,
          has_mattress: hasMattress,
          colour: hasColour && colours.length === 1 ? colours[0] : null,
          notes: null,
        },
        variants,
        finished,
      }

      const { data, error } = await supabase.rpc('create_product_full', { payload })
      if (error) throw error
      await reload()
      flash(`Saved — ${finished.length} SKU(s) across the catalogue ✓`)
      onSaved?.(data as Record<string, unknown>)
      setTimeout(() => onClose?.(), 900)
    } catch (e) {
      flash('Error: ' + (e as Error).message, 'error')
    }
    setSaving(false)
  }

  // Pre-fill category/shape when picking an existing family label from packed_skus.
  function pickFamily(label: string) {
    setFamilyLabel(label)
    if (!productName) setProductName(label)
  }

  const steps = ['Family', 'Product', 'Variants', 'Finished SKUs', 'Review']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 760 }}>
      {msg && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 2000, padding: '11px 20px', borderRadius: 999, fontSize: 13, fontWeight: 700, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', background: msg.type === 'error' ? 'var(--critical-bg)' : 'var(--dispatched-bg)', color: msg.type === 'error' ? 'var(--critical)' : 'var(--dispatched)', border: '1px solid var(--border)' }}>{msg.text}</div>
      )}

      {/* stepper */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div className="no-scrollbar" style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
          {steps.map((s, i) => (
            <button key={s} onClick={() => setStep(i + 1)}
              style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, background: step === i + 1 ? 'var(--accent)' : 'var(--bg2)', color: step === i + 1 ? '#fff' : 'var(--text3)' }}>
              <span style={{ opacity: 0.8 }}>{i + 1}</span>{s}
            </button>
          ))}
        </div>
        {onClose && <button onClick={onClose} aria-label="Close" style={{ flex: '0 0 auto', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text3)', cursor: 'pointer' }}><X size={15} /></button>}
      </div>

      {/* STEP 1 — Family */}
      {step === 1 && (
        <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden', alignSelf: 'flex-start' }}>
            {(['existing', 'new'] as FamilyMode[]).map(m => (
              <button key={m} onClick={() => setFamilyMode(m)} style={{ padding: '7px 14px', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, background: familyMode === m ? 'var(--accent)' : 'var(--surface)', color: familyMode === m ? '#fff' : 'var(--text3)' }}>{m === 'existing' ? 'Existing family' : '+ New family'}</button>
            ))}
          </div>

          {familyMode === 'existing' ? (
            <div>
              <div style={lbl}>Family <span style={{ textTransform: 'none', fontWeight: 500, color: 'var(--text3)', letterSpacing: 0 }}>(barcode generator product)</span></div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {familyLabels.map(f => <button key={f} onClick={() => pickFamily(f)} style={chip(familyLabel === f)}>{f}</button>)}
                {!familyLabels.length && <span style={{ fontSize: 12, color: 'var(--text3)' }}>No families yet — add one with “+ New family”.</span>}
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><div style={lbl}>Family label</div><input style={inp} placeholder="e.g. Atlas" value={familyLabel} onChange={e => setFamilyLabel(e.target.value)} /></div>
              <div><div style={lbl}>Category</div>
                <input style={inp} list="pm-cats" placeholder="e.g. Bed" value={categoryName} onChange={e => setCategoryName(e.target.value)} />
                <datalist id="pm-cats">{categories.map(c => <option key={c.id} value={c.name} />)}</datalist>
              </div>
              <div><div style={lbl}>Shape</div>
                <input style={inp} list="pm-shapes" placeholder="e.g. Round" value={shapeName} onChange={e => setShapeName(e.target.value)} />
                <datalist id="pm-shapes">{shapes.map(s => <option key={s.id} value={s.name} />)}</datalist>
              </div>
              <div><div style={lbl}>Shape image URL <span style={{ textTransform: 'none', fontWeight: 500, color: 'var(--text3)', letterSpacing: 0 }}>(optional)</span></div><input style={inp} placeholder="https://…/round.png" value={shapeImage} onChange={e => setShapeImage(e.target.value)} /></div>
            </div>
          )}

          {familyMode === 'existing' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><div style={lbl}>Category</div>
                <input style={inp} list="pm-cats" placeholder="e.g. Bed" value={categoryName} onChange={e => setCategoryName(e.target.value)} />
                <datalist id="pm-cats">{categories.map(c => <option key={c.id} value={c.name} />)}</datalist>
              </div>
              <div><div style={lbl}>Shape</div>
                <input style={inp} list="pm-shapes" placeholder="e.g. Round" value={shapeName} onChange={e => setShapeName(e.target.value)} />
                <datalist id="pm-shapes">{shapes.map(s => <option key={s.id} value={s.name} />)}</datalist>
              </div>
            </div>
          )}
        </div>
      )}

      {/* STEP 2 — Product */}
      {step === 2 && (
        <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div><div style={lbl}>Product name</div><input style={{ ...inp, maxWidth: 360 }} placeholder="e.g. Atlas Metal Bed" value={productName} onChange={e => setProductName(e.target.value)} /></div>
          <div>
            <div style={lbl}>Has these attributes</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {([['Size', hasSize, setHasSize], ['Mattress', hasMattress, setHasMattress], ['Colour', hasColour, setHasColour]] as [string, boolean, (v: boolean) => void][]).map(([name, val, set]) => (
                <button key={name} onClick={() => set(!val)} style={chip(val)}>{val ? '✓' : '—'} {name}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* STEP 3 — Variant dimensions */}
      {step === 3 && (
        <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {hasSize && (
            <div><div style={lbl}>Sizes</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {PM_SIZES.map(s => <button key={s} onClick={() => toggle(sizes, setSizes, s)} style={chip(sizes.includes(s))}>{s}</button>)}
            </div></div>
          )}
          {hasMattress && (
            <div><div style={lbl}>Mattress</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {MATTRESS_OPTIONS.map(m => <button key={m} onClick={() => toggle(mattresses, setMattresses, m)} style={chip(mattresses.includes(m))}>{m}</button>)}
            </div></div>
          )}
          {hasColour && (
            <div><div style={lbl}>Colours</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {COLOURS.map(c => <button key={c} onClick={() => toggle(colours, setColours, c)} style={chip(colours.includes(c))}><span style={{ width: 13, height: 13, borderRadius: '50%', border: '1px solid var(--border2)', background: COLOUR_HEX[c] || '#888', display: 'inline-block', verticalAlign: -2, marginRight: 7 }} />{c}</button>)}
            </div></div>
          )}
          <div style={{ fontSize: 12.5, color: 'var(--text2)', background: 'var(--accent-bg)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px' }}>
            This makes <b>{variantCount}</b> variant{variantCount !== 1 ? 's' : ''} (size × mattress). Colour is a product flag, not a variant — colours become separate finished SKUs in the next step.
          </div>
          <button onClick={() => { buildRows(); setStep(4) }} style={{ alignSelf: 'flex-start', padding: '10px 16px', borderRadius: 9, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>Build finished SKUs <ChevronRight size={15} /></button>
        </div>
      )}

      {/* STEP 4 — Finished SKUs */}
      {step === 4 && (
        <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!rows.length ? (
            <div style={{ fontSize: 13, color: 'var(--text3)' }}>Go back to step 3, set the dimensions, then “Build finished SKUs”.</div>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5, minWidth: 760 }}>
                <thead><tr style={{ background: 'var(--bg2)' }}>
                  {['Variant', 'Master SKU *', 'Amazon SKU', 'Amazon ASIN', 'Flipkart', 'Website', '→ size'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text3)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.key} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', color: 'var(--text2)' }}>{[r.size, r.mattress, r.colour].filter(Boolean).join(' · ') || '—'}</td>
                      <td style={{ padding: '6px 6px' }}><input style={{ ...inp, minWidth: 150 }} value={r.master_sku} onChange={e => setRow(r.key, { master_sku: e.target.value })} placeholder="ME-BL-BL-RF-3" /></td>
                      <td style={{ padding: '6px 6px' }}><input style={{ ...inp, minWidth: 150 }} value={r.amazon_sku} onChange={e => setRow(r.key, { amazon_sku: e.target.value })} /></td>
                      <td style={{ padding: '6px 6px' }}><input style={{ ...inp, minWidth: 120 }} value={r.amazon_asin} onChange={e => setRow(r.key, { amazon_asin: e.target.value })} /></td>
                      <td style={{ padding: '6px 6px' }}><input style={{ ...inp, minWidth: 150 }} value={r.flipkart_sku} onChange={e => setRow(r.key, { flipkart_sku: e.target.value })} /></td>
                      <td style={{ padding: '6px 6px' }}><input style={{ ...inp, minWidth: 150 }} value={r.website_sku} onChange={e => setRow(r.key, { website_sku: e.target.value })} /></td>
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{packedSize(r.size) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* STEP 5 — Review */}
      {step === 5 && (
        <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--text2)' }}>One save writes, idempotently (existing rows matched by key, not duplicated):</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
            {[
              ['Product', productName || '—'],
              ['Family / generator label', familyLabel || '—'],
              ['Category · Shape', [categoryName, shapeName].filter(Boolean).join(' · ') || '—'],
              ['Variants (product_variants)', String(variantCount)],
              ['Finished SKUs (packed_skus + dispatch_sku_map)', String(rows.length)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 11px', background: 'var(--bg2)', borderRadius: 8 }}>
                <span style={{ color: 'var(--text3)' }}>{k}</span><b style={{ color: 'var(--text)' }}>{v}</b>
              </div>
            ))}
          </div>
          <button onClick={handleSave} disabled={saving} style={{ padding: 13, borderRadius: 10, border: 'none', background: saving ? 'var(--bg2)' : 'var(--accent)', color: saving ? 'var(--text3)' : '#fff', fontSize: 14, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            {saving ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</> : <><Check size={16} /> Save product</>}
          </button>
        </div>
      )}

      {/* nav */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <button onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1} style={{ padding: '9px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, fontWeight: 600, cursor: step === 1 ? 'not-allowed' : 'pointer', opacity: step === 1 ? 0.4 : 1, display: 'flex', alignItems: 'center', gap: 5 }}><ChevronLeft size={15} /> Back</button>
        {step < 5
          ? <button onClick={() => { if (step === 3) buildRows(); setStep(s => Math.min(5, s + 1)) }} style={{ padding: '9px 16px', borderRadius: 9, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>Next <ChevronRight size={15} /></button>
          : <span />}
      </div>
    </div>
  )
}
