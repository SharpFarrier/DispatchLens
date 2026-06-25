'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import PackedSkuPicker, { PackedSku } from './PackedSkuPicker'
import { sharePackedLabelsPDF, LabelUnit } from './packedLabelGenerator'
import { Share2, Loader2 } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

interface LastBatch { units: LabelUnit[]; sku: string; descr: string | null }

export default function GenerateTab({ userId }: { userId: string }) {
  const supabase = createClient()
  const [skus, setSkus] = useState<PackedSku[]>([])
  const [loadingSkus, setLoadingSkus] = useState(true)
  const [resolved, setResolved] = useState<PackedSku | null>(null)
  const [qty, setQty] = useState('')
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

  async function handleGenerate() {
    const n = parseInt(qty)
    if (!resolved) { flash('Select a product variant first', 'error'); return }
    if (!n || n < 1) { flash('Enter a valid quantity', 'error'); return }
    setGenerating(true)
    try {
      const { data: startSeq, error: seqErr } = await supabase.rpc('reserve_packed_seq', { p_sku: resolved.sku, p_count: n })
      if (seqErr) throw seqErr

      const rows = []
      for (let i = 0; i < n; i++) {
        const seq = (startSeq as number) + i
        rows.push({
          barcode: `${resolved.sku}-${seq}`,
          sku: resolved.sku,
          seq,
          status: 'packed',
          source: 'warelens',
          created_by: userId,
        })
      }

      const { error: insErr } = await supabase.from('packed_units').insert(rows)
      if (insErr) throw insErr

      const units = rows.map(r => ({ barcode: r.barcode, descr: resolved.descr || undefined }))
      setLastBatch({ units, sku: resolved.sku, descr: resolved.descr })
      flash(`Generated ${n} × ${resolved.sku}`)
      setQty('')
      setResolved(null)
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
      const result = await sharePackedLabelsPDF(lastBatch.units, `packed-${lastBatch.sku}-${stamp}.pdf`)
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
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}>Quantity to generate</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setQty(q => String(Math.max(1, (parseInt(q) || 0) - 1)))} style={{ width: 48, height: 48, borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', fontSize: 22, fontWeight: 700, color: 'var(--text3)', cursor: 'pointer' }}>−</button>
                  <input type="number" inputMode="numeric" min="1" value={qty} onChange={e => setQty(e.target.value)} placeholder="0"
                    style={{ flex: 1, padding: '0 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 22, fontWeight: 700, textAlign: 'center' as const, fontFamily: 'DM Mono', outline: 'none' }} />
                  <button onClick={() => setQty(q => String((parseInt(q) || 0) + 1))} style={{ width: 48, height: 48, borderRadius: 8, border: '2px solid var(--border)', background: 'var(--surface)', fontSize: 22, fontWeight: 700, color: 'var(--text3)', cursor: 'pointer' }}>+</button>
                </div>
              </div>
              <button onClick={handleGenerate} disabled={generating || !qty}
                style={{ padding: '11px', borderRadius: 8, border: 'none', background: generating || !qty ? 'var(--bg2)' : 'var(--accent)', color: generating || !qty ? 'var(--text3)' : '#fff', fontSize: 14, fontWeight: 700, cursor: generating || !qty ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                {generating ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Generating…</> : 'Generate Barcodes'}
              </button>
            </div>
          )}

          {lastBatch && (
            <div style={{ background: 'var(--dispatched-bg)', border: '1px solid #bbf7d0', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--dispatched)' }}>{lastBatch.units.length} barcode(s) generated for {lastBatch.sku}</div>
              <div style={{ fontSize: 12, color: 'var(--dispatched)', fontFamily: 'DM Mono' }}>
                {lastBatch.units[0].barcode} → {lastBatch.units[lastBatch.units.length - 1].barcode}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>Share the PDF to whoever prints on the TE244 (email / WhatsApp), or download it.</div>
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
