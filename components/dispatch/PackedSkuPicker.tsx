'use client'
import { useState, useMemo } from 'react'

export interface PackedSku {
  id: string; product: string; size: string | null; fcolor: string | null
  wood: string | null; mattress: string | null; clothcolor: string | null
  sku: string; descr: string | null; last_seq: number; active: boolean
}

const WOOD_PRODUCTS = ['Luvo', 'Elvo']
const NO_SIZE = ['Spacio', 'Eva']
const TABLE_PRODUCTS = ['Lizon', 'Duke']
const SIZE_ORDER = ['2.5x6', '3x6', '4x6.25', '4ft', '5x6.25', '5x6.5', '6x6.25']
const MATTRESS_ORDER = ['Metal', 'Single Layer', 'Double Layer', 'Ortho Tri', 'Table', 'Study Chair']

const FCOLOR_SWATCHES: Record<string, string> = { Black: '#1a1a1a', White: '#f0ede8', Ivory: '#f5f0e0', Golden: '#c9a227', Grey: '#6b6860', Brown: '#5c3d2e' }
const WOOD_SWATCHES: Record<string, string> = { 'Wenge Black': '#2c1f14', 'Stone Grain': '#7a6b5e', 'American Oak': '#b5895e' }
const CLOTH_SWATCHES: Record<string, string> = { White: '#f0ede8', Grey: '#6b6860', 'Natural Ash': '#c8b49a', 'American Oak': '#b5895e', Walnut: '#5c3d2e', 'Frosty White': '#e8eaec', Black: '#1a1a1a', Velvet: '#6b3fa0', Blue: '#2563eb', Brown: '#5c3d2e', SC: '#333' }

type SelKey = 'product' | 'size' | 'fcolor' | 'wood' | 'mattress' | 'clothcolor'
type Sel = Record<SelKey, string | null>

function uniq(arr: (string | null)[]): string[] {
  return [...new Set(arr)].filter((v): v is string => v !== null && v !== undefined)
}

const pillStyle = { padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const swatchBtn = { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', fontWeight: 600, fontSize: 13, color: 'var(--text2)', cursor: 'pointer', textAlign: 'left' as const }
const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }

export default function PackedSkuPicker({ skus, onResolve, onReset }: {
  skus: PackedSku[]; onResolve?: (row: PackedSku) => void; onReset?: () => void
}) {
  const [sel, setSel] = useState<Sel>({ product: null, size: null, fcolor: null, wood: null, mattress: null, clothcolor: null })

  const products = useMemo(() => uniq(skus.map(s => s.product)).sort(), [skus])

  function filtered(partial: Partial<Sel>) {
    return skus.filter(s => {
      for (const k of ['product', 'size', 'fcolor', 'wood', 'mattress', 'clothcolor'] as SelKey[]) {
        if (partial[k] !== undefined && partial[k] !== null && s[k] !== partial[k]) return false
      }
      return true
    })
  }

  function steps(): SelKey[] {
    const out: SelKey[] = []
    if (!NO_SIZE.includes(sel.product || '')) out.push('size')
    out.push('fcolor')
    if (WOOD_PRODUCTS.includes(sel.product || '')) out.push('wood')
    out.push('mattress')
    return out
  }

  function currentStep(): string {
    if (!sel.product) return 'product'
    for (const k of steps()) {
      if (sel[k] === null || sel[k] === undefined) return k
    }
    const partial = { product: sel.product, size: sel.size, fcolor: sel.fcolor, wood: sel.wood, mattress: sel.mattress }
    const cloths = uniq(filtered(partial).map(s => s.clothcolor))
    if (cloths.length > 0 && (sel.clothcolor === null || sel.clothcolor === undefined)) return 'clothcolor'
    return 'done'
  }

  function pick(key: SelKey, val: string) {
    const order: SelKey[] = ['size', 'fcolor', 'wood', 'mattress', 'clothcolor']
    const next = { ...sel, [key]: val }
    const idx = order.indexOf(key)
    order.slice(idx + 1).forEach(k => next[k] = null)
    setSel(next)
    setTimeout(() => maybeResolve(next), 0)
  }

  function pickProduct(p: string) {
    setSel({ product: p, size: null, fcolor: null, wood: null, mattress: null, clothcolor: null })
    onReset?.()
  }

  function maybeResolve(state: Sel) {
    const stepsFor: SelKey[] = []
    if (!NO_SIZE.includes(state.product || '')) stepsFor.push('size')
    stepsFor.push('fcolor')
    if (WOOD_PRODUCTS.includes(state.product || '')) stepsFor.push('wood')
    stepsFor.push('mattress')
    for (const k of stepsFor) if (state[k] === null || state[k] === undefined) return
    const partial = { product: state.product, size: state.size, fcolor: state.fcolor, wood: state.wood, mattress: state.mattress }
    const cloths = uniq(filtered(partial).map(s => s.clothcolor))
    if (cloths.length > 0 && (state.clothcolor === null || state.clothcolor === undefined)) return
    const match = skus.find(s =>
      s.product === state.product &&
      (s.size || null) === (state.size || null) &&
      (s.fcolor || null) === (state.fcolor || null) &&
      (s.wood || null) === (state.wood || null) &&
      (s.mattress || null) === (state.mattress || null) &&
      (s.clothcolor || null) === (state.clothcolor || null)
    )
    if (match) onResolve?.(match)
  }

  function back() {
    const order: SelKey[] = ['clothcolor', 'mattress', 'wood', 'fcolor', 'size']
    const next = { ...sel }
    for (const k of order) {
      if (next[k] !== null && next[k] !== undefined) { next[k] = null; setSel(next); onReset?.(); return }
    }
    next.product = null
    setSel(next)
    onReset?.()
  }

  const step = currentStep()
  const sortSizes = (arr: string[]) => arr.sort((a, b) => (SIZE_ORDER.indexOf(a) < 0 ? 99 : SIZE_ORDER.indexOf(a)) - (SIZE_ORDER.indexOf(b) < 0 ? 99 : SIZE_ORDER.indexOf(b)))
  const sortMatt = (arr: string[]) => arr.sort((a, b) => (MATTRESS_ORDER.indexOf(a) < 0 ? 99 : MATTRESS_ORDER.indexOf(a)) - (MATTRESS_ORDER.indexOf(b) < 0 ? 99 : MATTRESS_ORDER.indexOf(b)))

  if (step === 'product') {
    return (
      <div>
        <div style={sectionTitle}>Select Product</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {products.map(p => (
            <button key={p} onClick={() => pickProduct(p)}
              style={{ borderRadius: 10, border: '2px solid var(--border)', padding: 16, fontSize: 13, fontWeight: 700, color: 'var(--text2)', background: 'var(--surface)', cursor: 'pointer' }}>
              {p}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const crumb = [sel.product, sel.size, sel.fcolor, sel.wood, sel.mattress, sel.clothcolor].filter(Boolean).join(' · ')

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={back} style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--bg2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontWeight: 700, cursor: 'pointer' }}>←</button>
        <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{crumb || 'Pick options'}</div>
      </div>

      {step === 'size' && (
        <div>
          <div style={sectionTitle}>Size</div>
          <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
            {sortSizes(uniq(filtered({ product: sel.product }).map(s => s.size))).map(v => (
              <button key={v} onClick={() => pick('size', v)} style={pillStyle}>{v}</button>
            ))}
          </div>
        </div>
      )}

      {step === 'fcolor' && (
        <div>
          <div style={sectionTitle}>Frame Colour</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {uniq(filtered({ product: sel.product, size: sel.size }).map(s => s.fcolor)).map(v => (
              <button key={v} onClick={() => pick('fcolor', v)} style={swatchBtn}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--border2)', background: FCOLOR_SWATCHES[v] || '#888' }} />
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 'wood' && (
        <div>
          <div style={sectionTitle}>Wood Pattern</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {uniq(filtered({ product: sel.product, size: sel.size, fcolor: sel.fcolor }).map(s => s.wood)).map(v => (
              <button key={v} onClick={() => pick('wood', v)} style={swatchBtn}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--border2)', background: WOOD_SWATCHES[v] || '#5c3d2e' }} />
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 'mattress' && (
        <div>
          <div style={sectionTitle}>{TABLE_PRODUCTS.includes(sel.product || '') ? 'Type' : 'Mattress'}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
            {sortMatt(uniq(filtered({ product: sel.product, size: sel.size, fcolor: sel.fcolor, wood: sel.wood }).map(s => s.mattress))).map(v => (
              <button key={v} onClick={() => pick('mattress', v)} style={pillStyle}>{v}</button>
            ))}
          </div>
        </div>
      )}

      {step === 'clothcolor' && (
        <div>
          <div style={sectionTitle}>{TABLE_PRODUCTS.includes(sel.product || '') ? 'Top Colour' : 'Mattress Colour'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {uniq(filtered({ product: sel.product, size: sel.size, fcolor: sel.fcolor, wood: sel.wood, mattress: sel.mattress }).map(s => s.clothcolor)).map(v => (
              <button key={v} onClick={() => pick('clothcolor', v)} style={swatchBtn}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--border2)', background: CLOTH_SWATCHES[v] || '#888' }} />
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 'done' && (
        <div style={{ textAlign: 'center' as const, padding: 16, fontSize: 13, color: 'var(--text3)' }}>Resolving SKU…</div>
      )}
    </div>
  )
}
