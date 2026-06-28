'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import PackedSkuPicker, { PackedSku } from './PackedSkuPicker'
import { sharePackedLabelsPDF, LabelUnit } from './packedLabelGenerator'
import { Share2, Loader2, Plus, Trash2 } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

// A line waiting to be generated.
interface CartLine { sku: string; descr: string | null; last_seq: number; qty: number }
interface LastBatch { units: LabelUnit[]; lineCount: number }

export default function GenerateTab({ userId }: { userId: string }) {
  const supabase = createClient()
  const [skus, setSkus] = useState<PackedSku[]>([])
  const [loadingSkus, setLoadingSkus] = useState(true)
  const [resolved, setResolved] = useState<PackedSku | null>(null)
  const [qty, setQty] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [generating, setGenerating] = useState(false)
  const [lastBatch, setLastBatch] = useState<LastBatch | null>(null)
  const [msg, setMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  const flash = (text: string, type: 'success' | 'error' = 'success') => {
    setMsg({ text, type }); setTimeout(() => setMsg(null), 3500)
  }

  const loadSkus = useCallback(async () => {
    setLoadingSkus(true)
    const { data } = await supabase.from('packed_skus').select('*').eq('active', true).order('product')
    setSkus((data as PackedSku[]) || [])
    setLoadingSkus(false)
  }, [supabase])

  useEffect(() => { loadSkus() }, [loadSkus])

  const cartTotal = cart.reduce((s, l) => s + l.qty, 0)

  // Add the resolved SKU + qty to the list. Same SKU merges (sums qty).
  function addToCart() {
    const n = parseInt(qty)
    if (!resolved) { flash('Select a product variant first', 'error'); return }
    if (!n || n < 1) { flash('Enter a valid quantity', 'error'); return }
    setCart(prev => {
      const i = prev.findIndex(l => l.sku === resolved.sku)
      if (i >= 0) {
        const next = [...prev]
        next[i] = { ...next[i], qty: next[i].qty + n }
        return next
      }
      return [...prev, { sku: resolved.sku, descr: resolved.descr, last_seq: resolved.last_seq, qty: n }]
    })
    flash(`Added ${n} × ${resolved.sku}`)
    setQty('')
    setResolved(null)
  }

  function removeLine(sku: string) {
    setCart(prev => prev.filter(l => l.sku !== sku))
  }

  function changeLineQty(sku: string, delta: number) {
    setCart(prev => prev.map(l => l.sku === sku ? { ...l, qty: Math.max(1, l.qty + delta) } : l))
  }

  // Generate every line: reserve seqs + insert packed_units per SKU, then ONE combined PDF.
  async function handleGenerateAll() {
    if (!cart.length) { flash('Add at least one SKU to the list', 'error'); return }
    setGenerating(true)
    try {
      const allUnits: LabelUnit[] = []
      for (const line of cart) {
        const { data: startSeq, error: seqErr } = await supabase.rpc('reserve_packed_seq', { p_sku: line.sku, p_count: line.qty })
        if (seqErr) throw seqErr
        const rows = []
        for (let i = 0; i < line.qty; i++) {
          const seq = (startSeq as number) + i
          rows.push({ barcode: `${line.sku}-${seq}`, sku: line.sku, seq, status: 'packed', source: 'warelens', created_by: userId })
        }
        const { error: insErr } = await supabase.from('packed_units').insert(rows)
        if (insErr) throw insErr
        for (const r of rows) allUnits.push({ barcode: r.barcode, descr: line.descr || undefined })
      }
      setLastBatch({ units: allUnits, lineCount: cart.length })
      flash(`Generated ${allUnits.length} barcode(s) across ${cart.length} SKU(s)`)
      setCart([])
      loadSkus()
    } catch (e) {
      flash('Error: ' + (e as Error).message, 'error')
    }
    setGenerating(false)
  }

  async function handleShareLabels() {
    if (!lastBatch) return
    try {
      const stamp = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(/[ ,:]/g, '')
      const name = lastBatch.lineCount === 1 ? `packed-${lastBatch.units[0].barcode}-${stamp}.pdf` : `packed-${lastBatch.lineCount}skus-${stamp}.pdf`
      const result = await sharePackedLabelsPDF(lastBatch.units, name)
      if (result === 'downloaded') flash('Labels downloaded')
      else if (result === 'shared') flash('Labels shared ✓')
    } catch (e) {
      flash('Label error: ' + (e as Error).message, 'error')
    }
  }

  const todayLabel = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20, maxWidth: 560 }}>
      {msg && (
        <div style={{ position: 'fixed' as const, bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, padding: '10px 20px', borderRadius: 20, fontSize: 13, fontWeight: 700, boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          background: msg.type === 'error' ? 'var(--critical-bg)' : 'var(--dispatched-bg)',
          color: msg.type === 'error' ? 'var(--critical)' : 'var(--dispatched)',
          border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
          {msg.text}
        </div>
      )}

      <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: 8, padding: '12px 16px', fontSize: 14, fontWeight: 700 }}>{todayLabel}</div>

      {loadingSkus && !skus.length ? (
        <div style={{ ...card, padding: 48, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading catalogue…</div>
      ) : (
        <>
          <div style={{ ...card, padding: 16 }}>
            <PackedSkuPicker skus={skus} onResolve={row => setResolved(row)} onReset={() => setResolved(null)} />
          </div>

          {resolved && (
            <div style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 4 }}>SKU Resolved</div>
                <div style={{ fontFamily: 'DM Mono', fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>{resolved.sku}</div>
                <div style={{ fontSize: 13, color: 'var(--text2)' }}>{resolved.descr}</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>Last number used: {resolved.last_seq} · next will be {resolved.last_seq + 1}</div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Quantity</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setQty(q => String(Math.max(1, (parseInt(q) || 0) - 1)))} style={{ width: 48, height: 48, borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', fontSize: 22, fontWeight: 700, color: 'var(--text3)', cursor: 'pointer' }}>−</button>
                  <input type="number" inputMode="numeric" min="1" value={qty} onChange={e => setQty(e.target.value)} placeholder="0"
                    onKeyDown={e => { if (e.key === 'Enter') addToCart() }}
                    style={{ flex: 1, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 22, fontWeight: 700, textAlign: 'center' as const, fontFamily: 'DM Mono', outline: 'none' }} />
                  <button onClick={() => setQty(q => String((parseInt(q) || 0) + 1))} style={{ width: 48, height: 48, borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', fontSize: 22, fontWeight: 700, color: 'var(--text3)', cursor: 'pointer' }}>+</button>
                </div>
              </div>
              <button onClick={addToCart} disabled={!qty}
                style={{ padding: '11px', borderRadius: 8, border: 'none', background: !qty ? 'var(--bg2)' : 'var(--accent)', color: !qty ? 'var(--text3)' : '#fff', fontSize: 14, fontWeight: 700, cursor: !qty ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Plus size={16} /> Add to list
              </button>
            </div>
          )}

          {/* The cart — SKUs queued for generation */}
          {cart.length > 0 && (
            <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>To generate</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{cart.length} SKU{cart.length !== 1 ? 's' : ''} · {cartTotal} label{cartTotal !== 1 ? 's' : ''}</div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                {cart.map(line => (
                  <div key={line.sku} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'DM Mono', fontSize: 13, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.sku}</div>
                      {line.descr && <div style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.descr}</div>}
                      <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'DM Mono', marginTop: 1 }}>{line.sku}-{line.last_seq + 1} → {line.sku}-{line.last_seq + line.qty}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button onClick={() => changeLineQty(line.sku, -1)} style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 16, fontWeight: 700, color: 'var(--text3)', cursor: 'pointer' }}>−</button>
                      <span style={{ minWidth: 28, textAlign: 'center' as const, fontFamily: 'DM Mono', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{line.qty}</span>
                      <button onClick={() => changeLineQty(line.sku, 1)} style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 16, fontWeight: 700, color: 'var(--text3)', cursor: 'pointer' }}>+</button>
                    </div>
                    <button onClick={() => removeLine(line.sku)} title="Remove" style={{ width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--critical)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>

              <button onClick={handleGenerateAll} disabled={generating}
                style={{ padding: '12px', borderRadius: 8, border: 'none', background: generating ? 'var(--bg2)' : 'var(--accent)', color: generating ? 'var(--text3)' : '#fff', fontSize: 14, fontWeight: 700, cursor: generating ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                {generating ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Generating…</> : `Generate ${cartTotal} barcode${cartTotal !== 1 ? 's' : ''}`}
              </button>
            </div>
          )}

          {lastBatch && (
            <div style={{ background: 'var(--dispatched-bg)', border: '1px solid #bbf7d0', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--dispatched)' }}>{lastBatch.units.length} barcode(s) generated across {lastBatch.lineCount} SKU{lastBatch.lineCount !== 1 ? 's' : ''}</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>One PDF holds every label. Share it to whoever prints on the TE244 (email / WhatsApp), or download it.</div>
              <button onClick={handleShareLabels}
                style={{ padding: '11px', borderRadius: 8, border: 'none', background: 'var(--dispatched)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <Share2 size={15} /> Share Labels PDF
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
