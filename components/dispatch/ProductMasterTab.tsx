'use client'
import { useState, useMemo } from 'react'
import { useProductStore } from './useProductStore'
import AddProductWizard from './AddProductWizard'
import { Plus, ArrowLeft, Package } from 'lucide-react'

// Product Master home: add a product/family (the fan-out wizard) + a read-only
// list of what already exists, grouped by category.
export default function ProductMasterTab() {
  const { products, categories, shapes, variants, loaded } = useProductStore()
  const [adding, setAdding] = useState(false)

  const catName = useMemo(() => Object.fromEntries(categories.map(c => [c.id, c.name])), [categories])
  const shapeName = useMemo(() => Object.fromEntries(shapes.map(s => [s.id, s.name])), [shapes])
  const varCount = useMemo(() => {
    const m: Record<string, number> = {}
    variants.forEach(v => { m[v.product_id] = (m[v.product_id] || 0) + 1 })
    return m
  }, [variants])

  const grouped = useMemo(() => {
    const m: Record<string, typeof products> = {}
    products.forEach(p => { const k = p.category_id ? (catName[p.category_id] || 'Uncategorised') : 'Uncategorised'; (m[k] ||= []).push(p) })
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]))
  }, [products, catName])

  if (adding) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <button onClick={() => setAdding(false)} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}><ArrowLeft size={15} /> Back to products</button>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Add Product / Family</h2>
        <AddProductWizard onClose={() => setAdding(false)} onSaved={() => setAdding(false)} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Product Master</h2>
        <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{products.length} products · {variants.length} variants</span>
        <button onClick={() => setAdding(true)} style={{ marginLeft: 'auto', padding: '8px 15px', borderRadius: 9, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}><Plus size={15} /> Add Product</button>
      </div>

      {!loaded ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text3)' }}>Loading product master…</div>
      ) : !products.length ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text2)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
          <Package size={28} style={{ color: 'var(--text3)', marginBottom: 8 }} /><div>No products yet. Use <b>Add Product</b> to create your first one.</div>
        </div>
      ) : (
        grouped.map(([cat, list]) => (
          <div key={cat} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text3)' }}>{cat} <span style={{ color: 'var(--text3)', fontWeight: 500 }}>· {list.length}</span></div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, minWidth: 520 }}>
                <thead><tr>{['Product', 'Shape', 'Attributes', 'Variants'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 14px', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text3)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {list.map(p => (
                    <tr key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 14px', fontWeight: 600, color: 'var(--text)' }}>{p.name}</td>
                      <td style={{ padding: '8px 14px', color: 'var(--text3)' }}>{p.shape_id ? (shapeName[p.shape_id] || '—') : '—'}</td>
                      <td style={{ padding: '8px 14px', color: 'var(--text3)', fontSize: 12 }}>{[p.has_size && 'Size', p.has_mattress && 'Mattress', p.has_colour && 'Colour', p.is_assembly && 'Assembly'].filter(Boolean).join(' · ') || '—'}</td>
                      <td style={{ padding: '8px 14px', fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 700 }}>{varCount[p.id] || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
