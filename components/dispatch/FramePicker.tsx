'use client'
import { useState, useEffect } from 'react'
import { useProductStore, COLOURS, type ProductFlags, type Shape, type BomItem, type Part, type Category } from './useProductStore'

const COLOUR_HEX: Record<string, string> = { Black: '#1a1a1a', White: '#f0ede8', Golden: '#c9a227', Ivory: '#f5f0e0' }

const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }
const pillStyle = { padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const pillSelected = { ...pillStyle, border: '2px solid var(--accent)', background: 'var(--accent-bg)', color: 'var(--accent)' }

export interface FrameItem {
  category: string
  product_id: string
  product_name?: string
  part_id?: string | null
  part_name?: string
  shape: string
  size: string | null
  mattress: string | null
  colour: string | null
  pieces: number
  is_assembly?: boolean
  size_required?: boolean
  mattress_required?: boolean
  colour_required?: boolean
}

// ---- Shape card ----
function ShapeCard({ product, shape, selected, onClick }: {
  product: ProductFlags; shape: Shape | null; selected: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      style={{
        position: 'relative', borderRadius: 14, overflow: 'hidden', textAlign: 'left',
        border: selected ? '2px solid var(--accent)' : '2px solid var(--border)',
        boxShadow: selected ? '0 0 0 2px var(--accent-bg)' : 'none',
        background: 'var(--surface)', cursor: 'pointer', padding: 0,
      }}>
      {shape?.image_url ? (
        <img src={shape.image_url} alt={product.name} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
      ) : (
        <div style={{ width: '100%', aspectRatio: '1', background: 'var(--bg2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30 }}>
          {product.is_assembly ? '🔩' : '🛏️'}
        </div>
      )}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, padding: '6px 8px',
        textAlign: 'center', fontSize: 11, fontWeight: 700,
        background: selected ? 'var(--accent)' : 'rgba(0,0,0,0.55)', color: '#fff',
      }}>{shape?.name || product.name}</div>
    </button>
  )
}

// ---- Parts entry (inward / assembly products) ----
function PartsEntry({ product, bom, parts, size, mattress, onAdd, onBack, showColour = false }: {
  product: ProductFlags; bom: BomItem[]; parts: Part[]
  size: string | null; mattress: string | null
  onAdd: (item: FrameItem) => void; onBack: () => void; showColour?: boolean
}) {
  const [sets, setSets] = useState('')
  const [qtys, setQtys] = useState<Record<string, number>>(() => Object.fromEntries(bom.map(b => [b.part_id, 0])))
  const [colour, setColour] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setQtys(Object.fromEntries(bom.map(b => [b.part_id, 0])))
    setSets(''); setError('')
  }, [bom])

  function applyQuickFill(n: string) {
    const count = parseInt(n) || 0
    if (count < 1) return
    const filled: Record<string, number> = {}
    bom.forEach(b => { filled[b.part_id] = b.quantity * count })
    setQtys(filled); setError('')
  }

  function setQty(partId: string, val: number | string) {
    const n = Math.max(0, parseInt(String(val)) || 0)
    setQtys(prev => ({ ...prev, [partId]: n }))
    setError('')
  }

  function handleAdd() {
    const hasAny = Object.values(qtys).some(q => q > 0)
    if (!hasAny) { setError('Enter at least one part quantity'); return }
    if (showColour && !colour) { setError('Select a coating colour'); return }
    bom.forEach(b => {
      const qty = qtys[b.part_id]
      if (qty > 0) {
        const partName = b.parts?.name || parts.find(p => p.id === b.part_id)?.name || 'Part'
        onAdd({
          category: 'parts',
          product_id: product.id,
          product_name: product.name,
          part_id: b.part_id,
          part_name: partName,
          shape: partName,
          size: size || null,
          mattress: mattress || null,
          colour: colour || null,
          pieces: qty,
        })
      }
    })
    setSets(''); setQtys(Object.fromEntries(bom.map(b => [b.part_id, 0]))); setColour(null); setError('')
  }

  const totalParts = Object.values(qtys).reduce((s, q) => s + q, 0)
  const hasBom = bom.length > 0
  const setsNum = parseInt(sets) || 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button onClick={onBack} style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}>← Back</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, background: 'var(--accent-bg)', borderRadius: 10, border: '1px solid var(--border)' }}>
        <span style={{ fontSize: 22 }}>🔩</span>
        <div>
          <div style={{ fontWeight: 800, color: 'var(--text)', fontSize: 13 }}>{product.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            {[size, mattress].filter(Boolean).join(' · ') || 'No variant'} · Enter parts received
          </div>
        </div>
      </div>

      {!hasBom ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text3)' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>No BOM defined</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Ask an admin to set up the BOM for {product.name} {size} {mattress} in Product Master</div>
        </div>
      ) : (
        <>
          <div>
            <div style={sectionTitle}>Quick Fill <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>(sets to auto-fill)</span></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" inputMode="numeric" min="1"
                style={{ flex: 1, textAlign: 'center', fontWeight: 700, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                placeholder="e.g. 10 sets" value={sets}
                onChange={e => setSets(e.target.value)} />
              <button onClick={() => applyQuickFill(sets)}
                style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer' }}>Fill</button>
            </div>
            {setsNum > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4, paddingLeft: 4 }}>
                {bom.map(b => `${b.parts?.name}: ${setsNum * b.quantity}`).join(' · ')}
              </div>
            )}
          </div>

          <div>
            <div style={sectionTitle}>Parts Received</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {bom.map(b => {
                const partName = b.parts?.name || parts.find(p => p.id === b.part_id)?.name || 'Unknown'
                return (
                  <div key={b.part_id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)' }}>{partName}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>{b.quantity} per {product.name}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button onClick={() => setQty(b.part_id, (qtys[b.part_id] || 0) - 1)}
                        style={{ width: 36, height: 36, borderRadius: 8, border: '2px solid var(--border)', fontSize: 18, fontWeight: 700, color: 'var(--text3)', background: 'var(--surface)', cursor: 'pointer' }}>−</button>
                      <input type="number" inputMode="numeric" min="0"
                        value={qtys[b.part_id] || ''}
                        onChange={e => setQty(b.part_id, e.target.value)}
                        placeholder="0"
                        style={{ width: 56, textAlign: 'center', fontWeight: 800, color: 'var(--accent)', padding: '9px 4px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }} />
                      <button onClick={() => setQty(b.part_id, (qtys[b.part_id] || 0) + 1)}
                        style={{ width: 36, height: 36, borderRadius: 8, border: '2px solid var(--border)', fontSize: 18, fontWeight: 700, color: 'var(--text3)', background: 'var(--surface)', cursor: 'pointer' }}>+</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {showColour && (
            <div>
              <div style={sectionTitle}>Coating Colour</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {COLOURS.map(c => (
                  <button key={c} onClick={() => { setColour(c); setError('') }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 8,
                      border: colour === c ? '2px solid var(--accent)' : '2px solid var(--border)',
                      background: colour === c ? 'var(--accent-bg)' : 'var(--surface)',
                      color: colour === c ? 'var(--accent)' : 'var(--text2)',
                      fontWeight: 700, fontSize: 13, cursor: 'pointer',
                    }}>
                    <span style={{ width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--border2)', background: COLOUR_HEX[c] || '#888' }} />
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p style={{ color: 'var(--critical)', fontSize: 13, fontWeight: 600, margin: 0 }}>{error}</p>}

          <button onClick={handleAdd} disabled={totalParts === 0}
            style={{ width: '100%', padding: 14, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 15, borderRadius: 10, border: 'none', cursor: 'pointer', opacity: totalParts === 0 ? 0.4 : 1 }}>
            Add {totalParts > 0 ? `(${totalParts} parts)` : ''} to List
          </button>
        </>
      )}
    </div>
  )
}

// ---- Main FramePicker ----
// mode: 'inward' (stock — assembly variants route to parts entry)
//       'coating' / 'picks' (assembly variants treated as finished UNITS)
export default function FramePicker({ onAdd, showColour = false, mode = 'inward' }: {
  onAdd: (item: FrameItem) => void; showColour?: boolean; mode?: 'inward' | 'coating' | 'picks'
}) {
  const {
    load, getProductsForCategory, getSizesForProduct, getMattressOption,
    getBomForProduct, getShapeForProduct, isVariantAssembly, variantHasColour,
    categories, parts, loaded,
  } = useProductStore()

  // Assembly/parts inward flow removed — everything is inwarded as a finished frame.
  const routesToParts = false

  const [step, setStep] = useState<'category' | 'product' | 'size' | 'mattress' | 'colour' | 'pieces' | 'parts'>('category')
  const [category, setCategory] = useState<Category | null>(null)
  const [product, setProduct] = useState<ProductFlags | null>(null)
  const [size, setSize] = useState<string | null>(null)
  const [mattress, setMattress] = useState<string | null>(null)
  const [colour, setColour] = useState<string | null>(null)
  const [pieces, setPieces] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { void load() }, [load])

  function reset() {
    setStep('category'); setCategory(null); setProduct(null)
    setSize(null); setMattress(null); setColour(null); setPieces(''); setError('')
  }

  function pickCategory(cat: Category) {
    setCategory(cat); setProduct(null); setSize(null); setMattress(null); setColour(null)
    setStep('product')
  }

  function afterSize(prod: ProductFlags, sz: string | null) {
    const mattressOpt = getMattressOption(prod.id, sz)
    if (prod.has_mattress && mattressOpt === 'both') { setStep('mattress'); return }
    const fixedMattress = (prod.has_mattress && mattressOpt !== 'none' && mattressOpt !== 'both') ? mattressOpt : null
    if (fixedMattress) setMattress(fixedMattress)
    const resolvedMattress = fixedMattress
    if (routesToParts && isVariantAssembly(prod.id, sz, resolvedMattress)) { setStep('parts'); return }
    if (showColour) { setStep('colour'); return }
    setStep('pieces')
  }

  function pickProduct(prod: ProductFlags) {
    setProduct(prod); setSize(null); setMattress(null); setColour(null)
    if (routesToParts && !prod.has_size && isVariantAssembly(prod.id, null, null)) { setStep('parts'); return }
    if (prod.has_size) { setStep('size'); return }
    afterSize(prod, null)
  }

  function pickSize(s: string) { setSize(s); afterSize(product!, s) }
  function pickMattress(m: string) {
    setMattress(m)
    if (routesToParts && isVariantAssembly(product!.id, size, m)) { setStep('parts'); return }
    if (showColour && variantHasColour(product!.id, size, m)) { setStep('colour'); return }
    setStep('pieces')
  }
  function pickColour(c: string) { setColour(c); setStep('pieces') }

  function handleAdd() {
    const p = parseInt(pieces)
    if (!p || p < 1) { setError('Enter a valid piece count'); return }
    if (showColour && variantHasColour(product!.id, size, mattress) && !colour) { setError('Select a colour'); return }
    if (product!.has_size && !size) { setError('Size is required'); return }
    if (product!.has_mattress && !mattress) { setError('Mattress type is required'); return }
    const shape = getShapeForProduct(product!.id)
    onAdd({
      category: category!.name.toLowerCase(),
      product_id: product!.id,
      shape: shape?.name || product!.name,
      size: size || null,
      mattress: mattress || null,
      colour: colour || null,
      pieces: p,
      is_assembly: isVariantAssembly(product!.id, size || null, mattress || null),
      size_required: product!.has_size || false,
      mattress_required: product!.has_mattress || false,
      colour_required: showColour && variantHasColour(product!.id, size, mattress),
    })
    reset()
  }

  const productsForCategory = category ? getProductsForCategory(category.name) : []
  const sizesForProduct = product ? getSizesForProduct(product.id) : []
  const bomForVariant = product ? getBomForProduct(product.id, size, mattress) : []
  const shapeForProduct = product ? getShapeForProduct(product.id) : null

  if (!loaded) return <div style={{ fontSize: 13, color: 'var(--text3)', padding: '16px 0', textAlign: 'center' }}>Loading products...</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Category */}
      <div>
        <div style={sectionTitle}>Category</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {categories.map(cat => (
            <button key={cat.id} onClick={() => pickCategory(cat)}
              style={{ ...(category?.id === cat.id ? pillSelected : pillStyle), flex: 1 }}>
              {cat.name === 'Bed' ? '🛏️' : cat.name === 'Table' ? '🪑' : cat.name === 'Chair' ? '💺' : '📦'} {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* Shape grid */}
      {step !== 'category' && step !== 'parts' && (
        <div>
          <div style={sectionTitle}>Shape</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {productsForCategory.map(prod => (
              <ShapeCard key={prod.id} product={prod} shape={getShapeForProduct(prod.id)}
                selected={product?.id === prod.id} onClick={() => pickProduct(prod)} />
            ))}
          </div>
        </div>
      )}

      {/* Parts entry */}
      {step === 'parts' && product && (
        <PartsEntry
          product={product} bom={bomForVariant} parts={parts}
          size={size} mattress={mattress} onAdd={onAdd}
          onBack={() => {
            if (product.has_mattress && size) { setMattress(null); setStep('mattress'); return }
            if (product.has_size) { setSize(null); setMattress(null); setStep('size'); return }
            setProduct(null); setStep('product')
          }}
          showColour={showColour}
        />
      )}

      {/* Size */}
      {step === 'size' && (
        <div>
          <div style={sectionTitle}>Size</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {sizesForProduct.map(s => (
              <button key={s} onClick={() => pickSize(s)} style={size === s ? pillSelected : pillStyle}>{s}</button>
            ))}
          </div>
        </div>
      )}

      {/* Mattress */}
      {step === 'mattress' && (
        <div>
          <div style={sectionTitle}>Mattress</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            {['With Mattress', 'Without Mattress'].map(m => (
              <button key={m} onClick={() => pickMattress(m)}
                style={{
                  padding: 14, borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  border: mattress === m ? '2px solid var(--accent)' : '2px solid var(--border)',
                  background: mattress === m ? 'var(--accent-bg)' : 'var(--surface)',
                  color: mattress === m ? 'var(--accent)' : 'var(--text3)',
                }}>{m}</button>
            ))}
          </div>
        </div>
      )}

      {/* Colour */}
      {step === 'colour' && showColour && (
        <div>
          <div style={sectionTitle}>Coating Colour</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {COLOURS.map(c => (
              <button key={c} onClick={() => pickColour(c)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 8,
                  border: colour === c ? '2px solid var(--accent)' : '2px solid var(--border)',
                  background: colour === c ? 'var(--accent-bg)' : 'var(--surface)',
                  color: colour === c ? 'var(--accent)' : 'var(--text2)',
                  fontWeight: 700, fontSize: 13, cursor: 'pointer',
                }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--border2)', background: COLOUR_HEX[c] || '#888' }} />
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Pieces */}
      {step === 'pieces' && (
        <div>
          <div style={sectionTitle}>Pieces</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: 12, background: 'var(--accent-bg)', borderRadius: 10, border: '1px solid var(--border)' }}>
            {shapeForProduct?.image_url && (
              <img src={shapeForProduct.image_url} alt={product!.name} style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover' }} />
            )}
            <div style={{ fontSize: 13 }}>
              <div style={{ fontWeight: 700, color: 'var(--text)' }}>{shapeForProduct?.name || product!.name}{size ? ` · ${size}` : ''}</div>
              <div style={{ color: 'var(--text3)', fontSize: 12 }}>{mattress && mattress !== 'N/A' ? mattress : ''}{colour ? ` · ${colour}` : ''}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPieces(p => String(Math.max(1, (parseInt(p || '0') || 0) - 1)))}
              style={{ width: 48, height: 48, borderRadius: 10, border: '2px solid var(--border)', fontSize: 22, fontWeight: 700, color: 'var(--text3)', background: 'var(--surface)', cursor: 'pointer' }}>−</button>
            <input type="number" inputMode="numeric" min="1" value={pieces}
              onChange={e => { setPieces(e.target.value); setError('') }}
              placeholder="0"
              style={{ flex: 1, textAlign: 'center', fontSize: 22, fontWeight: 700, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
              onKeyDown={e => e.key === 'Enter' && handleAdd()} />
            <button onClick={() => setPieces(p => String((parseInt(p || '0') || 0) + 1))}
              style={{ width: 48, height: 48, borderRadius: 10, border: '2px solid var(--border)', fontSize: 22, fontWeight: 700, color: 'var(--text3)', background: 'var(--surface)', cursor: 'pointer' }}>+</button>
          </div>
          {error && <p style={{ color: 'var(--critical)', fontSize: 13, fontWeight: 600, marginTop: 4 }}>{error}</p>}
          <button onClick={handleAdd}
            style={{ width: '100%', marginTop: 12, padding: 14, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 15, borderRadius: 10, border: 'none', cursor: 'pointer' }}>
            Add to List
          </button>
        </div>
      )}
    </div>
  )
}
