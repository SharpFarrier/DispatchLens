'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SkuMap } from '@/types'
import { Search, Plus, X, Pencil, Trash2, Upload, Package, CheckCircle, AlertCircle } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

const emptyDraft = (): Partial<SkuMap> => ({
  master_sku: '', product_name: '', amazon_sku: '', amazon_asin: '', flipkart_sku: '', website_sku: '', other_sku: '',
})

export default function SkuMapTab() {
  const supabase = createClient()
  const [maps, setMaps] = useState<SkuMap[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<SkuMap | null>(null)
  const [draft, setDraft] = useState<Partial<SkuMap>>(emptyDraft())
  const [isNew, setIsNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showBulk, setShowBulk] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkResult, setBulkResult] = useState<{ added: number; updated: number; errors: number } | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('dispatch_sku_map').select('*').order('master_sku', { ascending: true })
    setMaps((data as SkuMap[]) || [])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!search.trim()) return maps
    const q = search.toLowerCase()
    return maps.filter(m =>
      m.master_sku?.toLowerCase().includes(q) ||
      m.product_name?.toLowerCase().includes(q) ||
      m.amazon_sku?.toLowerCase().includes(q) ||
      m.amazon_asin?.toLowerCase().includes(q) ||
      m.flipkart_sku?.toLowerCase().includes(q) ||
      m.website_sku?.toLowerCase().includes(q) ||
      m.other_sku?.toLowerCase().includes(q)
    )
  }, [maps, search])

  const openNew = () => { setDraft(emptyDraft()); setIsNew(true); setEditing({ id: 'new' } as SkuMap) }
  const openEdit = (m: SkuMap) => { setDraft({ ...m }); setIsNew(false); setEditing(m) }
  const closeDrawer = () => { setEditing(null); setDraft(emptyDraft()); setIsNew(false) }

  const save = async () => {
    if (!draft.master_sku?.trim()) return
    setSaving(true)
    const payload = {
      master_sku: draft.master_sku!.trim(),
      product_name: draft.product_name?.trim() || null,
      amazon_sku: draft.amazon_sku?.trim() || null,
      amazon_asin: draft.amazon_asin?.trim() || null,
      flipkart_sku: draft.flipkart_sku?.trim() || null,
      website_sku: draft.website_sku?.trim() || null,
      other_sku: draft.other_sku?.trim() || null,
      updated_at: new Date().toISOString(),
    }
    if (isNew) {
      const { data } = await supabase.from('dispatch_sku_map').insert(payload).select().single()
      if (data) setMaps(prev => [...prev, data as SkuMap].sort((a, b) => a.master_sku.localeCompare(b.master_sku)))
    } else if (editing) {
      await supabase.from('dispatch_sku_map').update(payload).eq('id', editing.id)
      setMaps(prev => prev.map(m => m.id === editing.id ? { ...m, ...payload } as SkuMap : m))
    }
    setSaving(false)
    closeDrawer()
  }

  const remove = async () => {
    if (!editing || isNew) return
    setDeleting(true)
    await supabase.from('dispatch_sku_map').delete().eq('id', editing.id)
    setMaps(prev => prev.filter(m => m.id !== editing.id))
    setDeleting(false)
    closeDrawer()
  }

  // Bulk paste: tab/comma-separated. Columns: master_sku, product_name, amazon_sku, amazon_asin, flipkart_sku, website_sku
  // Upserts on master_sku.
  const runBulk = async () => {
    setBulkRunning(true)
    setBulkResult(null)
    const lines = bulkText.trim().split('\n').filter(l => l.trim())
    let added = 0, updated = 0, errors = 0
    const existing = new Map(maps.map(m => [m.master_sku.toLowerCase(), m]))
    const toInsert: Record<string, unknown>[] = []
    const toUpdate: { id: string; payload: Record<string, unknown> }[] = []

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      // Skip a header row if present
      if (i === 0 && /master\s*sku/i.test(raw)) continue
      const cols = raw.includes('\t') ? raw.split('\t') : raw.split(',')
      const master = (cols[0] || '').trim()
      if (!master) { errors++; continue }
      const payload = {
        master_sku: master,
        product_name: (cols[1] || '').trim() || null,
        amazon_sku: (cols[2] || '').trim() || null,
        amazon_asin: (cols[3] || '').trim() || null,
        flipkart_sku: (cols[4] || '').trim() || null,
        website_sku: (cols[5] || '').trim() || null,
        other_sku: (cols[6] || '').trim() || null,
        updated_at: new Date().toISOString(),
      }
      const hit = existing.get(master.toLowerCase())
      if (hit) { toUpdate.push({ id: hit.id, payload }); updated++ }
      else { toInsert.push(payload); added++ }
    }

    if (toInsert.length) await supabase.from('dispatch_sku_map').insert(toInsert)
    for (const u of toUpdate) await supabase.from('dispatch_sku_map').update(u.payload).eq('id', u.id)

    setBulkResult({ added, updated, errors })
    setBulkRunning(false)
    await load()
  }

  const field = (label: string, key: keyof SkuMap, placeholder: string, required = false) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 6, fontWeight: 500 }}>
        {label}{required && <span style={{ color: 'var(--critical)' }}> *</span>}
      </label>
      <input
        value={(draft[key] as string) || ''}
        onChange={e => setDraft(prev => ({ ...prev, [key]: e.target.value }))}
        placeholder={placeholder}
        style={{ width: '100%', padding: '9px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, fontFamily: 'DM Mono', outline: 'none' }}
        onFocus={e => e.target.style.borderColor = 'var(--accent)'}
        onBlur={e => e.target.style.borderColor = 'var(--border)'}
      />
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>SKU Map</h1>
        <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{filtered.length} of {maps.length} products</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px' }}>
            <Search size={13} style={{ color: 'var(--text3)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKUs…"
              style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'DM Sans', width: 200 }} />
            {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0 }}><X size={12} /></button>}
          </div>
          <button onClick={() => { setShowBulk(true); setBulkResult(null); setBulkText('') }} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
            <Upload size={13} /> Bulk Paste
          </button>
          <button onClick={openNew} style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <Plus size={14} /> Add Product
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading SKU map…</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text2)' }}>
          {maps.length === 0 ? 'No SKU mappings yet. Run the migration or use Bulk Paste to seed.' : 'No products match your search.'}
        </div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13, minWidth: 900 }}>
              <thead>
                <tr style={{ background: 'var(--bg2)', borderBottom: '2px solid var(--border2)' }}>
                  {['Master SKU (Barcode)', 'Product', 'Amazon SKU', 'Amazon ASIN', 'Flipkart SKU', 'Website SKU', 'Other SKU', ''].map(h => (
                    <th key={h} style={{ padding: '9px 14px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((m, i) => (
                  <tr key={m.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)', cursor: 'pointer' }}
                    onClick={() => openEdit(m)}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-bg)'}
                    onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--bg2)'}>
                    <td style={{ padding: '9px 14px', fontFamily: 'DM Mono', fontSize: 12, fontWeight: 600, color: 'var(--accent)', whiteSpace: 'nowrap' as const }}>{m.master_sku}</td>
                    <td style={{ padding: '9px 14px', fontSize: 13, color: 'var(--text)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{m.product_name || '—'}</td>
                    <td style={{ padding: '9px 14px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{m.amazon_sku || '—'}</td>
                    <td style={{ padding: '9px 14px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{m.amazon_asin || '—'}</td>
                    <td style={{ padding: '9px 14px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{m.flipkart_sku || '—'}</td>
                    <td style={{ padding: '9px 14px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{m.website_sku || '—'}</td>
                    <td style={{ padding: '9px 14px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)' }}>{m.other_sku || '—'}</td>
                    <td style={{ padding: '9px 14px' }}>
                      <Pencil size={12} style={{ color: 'var(--text3)' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit drawer */}
      {editing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)', display: 'flex', justifyContent: 'flex-end' }} onClick={closeDrawer}>
          <div style={{ background: 'var(--surface)', borderLeft: '1px solid var(--border)', width: 440, maxWidth: '90vw', height: '100%', padding: 28, overflowY: 'auto', boxShadow: '-8px 0 24px rgba(0,0,0,0.12)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <span style={{ fontWeight: 700, fontSize: 16 }}>{isNew ? 'Add Product' : 'Edit Product'}</span>
              <button onClick={closeDrawer} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 4 }}><X size={18} /></button>
            </div>

            {field('Master SKU (barcode value)', 'master_sku', 'e.g. L3-B-BR-TR-3', true)}
            {field('Product Name', 'product_name', 'e.g. Xyra')}
            <div style={{ height: 1, background: 'var(--border)', margin: '20px 0' }} />
            <div style={{ fontSize: 11, fontFamily: 'DM Mono', color: 'var(--text3)', marginBottom: 12, letterSpacing: '0.05em' }}>PLATFORM SKUs</div>
            {field('Amazon SKU', 'amazon_sku', 'Amazon seller SKU')}
            {field('Amazon ASIN', 'amazon_asin', 'B0XXXXXXXX')}
            {field('Flipkart SKU', 'flipkart_sku', 'Flipkart SKU')}
            {field('Website SKU', 'website_sku', 'D2C / website SKU')}
            {field('Other SKU', 'other_sku', 'Any other / new-platform SKU')}

            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button onClick={save} disabled={saving || !draft.master_sku?.trim()} style={{ flex: 1, padding: '10px', borderRadius: 7, border: 'none', background: saving || !draft.master_sku?.trim() ? 'var(--bg2)' : 'var(--accent)', color: saving || !draft.master_sku?.trim() ? 'var(--text3)' : '#fff', fontSize: 13, fontWeight: 600, cursor: saving || !draft.master_sku?.trim() ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <CheckCircle size={14} /> {saving ? 'Saving…' : isNew ? 'Add Product' : 'Save Changes'}
              </button>
              {!isNew && (
                <button onClick={remove} disabled={deleting} style={{ padding: '10px 16px', borderRadius: 7, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Trash2 size={14} /> {deleting ? '…' : 'Delete'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bulk paste modal */}
      {showBulk && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowBulk(false)}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 28, width: 600, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 40px rgba(0,0,0,0.12)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>Bulk Paste SKU Mappings</span>
              <button onClick={() => setShowBulk(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 4 }}><X size={16} /></button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12, lineHeight: 1.5 }}>
              Paste rows (tab or comma separated). Columns in order:<br />
              <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>Master SKU · Product Name · Amazon SKU · Amazon ASIN · Flipkart SKU · Website SKU · Other SKU</span><br />
              A header row is auto-detected and skipped. Existing Master SKUs are updated; new ones added.
            </p>
            <textarea value={bulkText} onChange={e => { setBulkText(e.target.value); setBulkResult(null) }}
              placeholder={'L3-B-BR-TR-3\tXyra\tSW-TR-BL-BR-3\tB0FPM59XH7\tSW-TR-BL-BR-3\t3L-B-BR-TR-3'}
              style={{ height: 240, width: '100%', padding: '12px 14px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', fontFamily: 'DM Mono', fontSize: 12, resize: 'vertical' as const, outline: 'none', lineHeight: 1.5 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 14 }}>
              <button onClick={runBulk} disabled={bulkRunning || !bulkText.trim()} style={{ padding: '9px 20px', borderRadius: 7, background: bulkRunning || !bulkText.trim() ? 'var(--bg2)' : 'var(--accent)', border: 'none', color: bulkRunning || !bulkText.trim() ? 'var(--text3)' : '#fff', fontWeight: 600, fontSize: 13, cursor: bulkRunning || !bulkText.trim() ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Upload size={14} /> {bulkRunning ? 'Importing…' : 'Import Mappings'}
              </button>
              {bulkResult && (
                <span style={{ fontSize: 13, color: 'var(--dispatched)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckCircle size={14} /> {bulkResult.added} added · {bulkResult.updated} updated
                  {bulkResult.errors > 0 && <span style={{ color: 'var(--critical)' }}> · {bulkResult.errors} skipped</span>}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
